const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { query, queryOne, queryMany } = require('../db');
const { authenticate, authenticateOptional } = require('../middleware/auth');

// ============================================================
// POST /api/donations/create — Créer un intent de paiement Stripe
// ============================================================
router.post('/create',
  authenticateOptional,
  [
    body('workId').isUUID().withMessage('ID oeuvre invalide.'),
    body('amount').isFloat({ min: 0.50 }).withMessage('Montant minimum : 0.50 EUR.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { workId, amount } = req.body;

    // Vérifier que l'oeuvre existe et est publiée
    const work = await queryOne(
      'SELECT id, title, is_printed FROM works WHERE id = $1 AND status = $2',
      [workId, 'published']
    );

    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable ou non publiée.' });
    if (work.is_printed) return res.status(400).json({ error: 'Cette oeuvre a déjà été imprimée.' });

    const amountCents = Math.round(parseFloat(amount) * 100);

    try {
      // Initialiser Stripe seulement si la clé existe
      if (!process.env.STRIPE_SECRET_KEY) {
        // Mode développement sans Stripe
        const donation = await queryOne(
          `INSERT INTO donations (user_id, work_id, amount, status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING id, amount, status`,
          [req.user?.id || null, workId, parseFloat(amount)]
        );
        return res.json({ donationId: donation.id, devMode: true });
      }

      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'eur',
        metadata: {
          work_id: workId,
          work_title: work.title,
          user_id: req.user?.id || 'anonymous',
          platform: 'librum'
        },
        description: `Don LIBRUM — ${work.title}`
      });

      const donation = await queryOne(
        `INSERT INTO donations (user_id, work_id, amount, stripe_payment_id, stripe_client_secret, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id, amount`,
        [req.user?.id || null, workId, parseFloat(amount),
         paymentIntent.id, paymentIntent.client_secret]
      );

      res.json({
        donationId: donation.id,
        clientSecret: paymentIntent.client_secret,
        amount: donation.amount
      });

    } catch (err) {
      console.error('Erreur Stripe:', err);
      res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
    }
  }
);

// ============================================================
// POST /api/donations/confirm/:id — Confirmer un don (webhook Stripe ou dev)
// ============================================================
router.post('/confirm/:id', async (req, res) => {
  const donation = await queryOne(
    'SELECT id, work_id, amount, status FROM donations WHERE id = $1',
    [req.params.id]
  );

  if (!donation) return res.status(404).json({ error: 'Don introuvable.' });
  if (donation.status === 'confirmed') return res.status(400).json({ error: 'Don déjà confirmé.' });

  await query(
    'UPDATE donations SET status = $1, confirmed_at = NOW() WHERE id = $2',
    ['confirmed', donation.id]
  );

  // Le trigger PostgreSQL met à jour la cagnotte automatiquement
  // On récupère les nouvelles valeurs pour l'événement WebSocket
  const work = await queryOne(
    'SELECT id, cagnotte_amount, cagnotte_threshold, cagnotte_donors, title FROM works WHERE id = $1',
    [donation.work_id]
  );

  // Émettre l'événement WebSocket pour le compteur live
  const io = req.app.get('io');
  if (io && work) {
    io.to(`work:${work.id}`).emit('cagnotte:update', {
      workId: work.id,
      amount: parseFloat(work.cagnotte_amount),
      threshold: parseFloat(work.cagnotte_threshold),
      donors: work.cagnotte_donors,
      percentage: Math.min(100, (parseFloat(work.cagnotte_amount) / parseFloat(work.cagnotte_threshold)) * 100),
      newDonation: parseFloat(donation.amount)
    });

    // Vérifier si seuil atteint → notification impression
    if (parseFloat(work.cagnotte_amount) >= parseFloat(work.cagnotte_threshold)) {
      io.to(`work:${work.id}`).emit('cagnotte:threshold_reached', {
        workId: work.id,
        title: work.title,
        totalAmount: parseFloat(work.cagnotte_amount)
      });
      // TODO: notifier l'auteur par email + notification
    }
  }

  res.json({
    message: 'Don confirmé. Merci pour votre soutien !',
    cagnotte: {
      amount: parseFloat(work?.cagnotte_amount || 0),
      threshold: parseFloat(work?.cagnotte_threshold || 0),
      donors: work?.cagnotte_donors || 0
    }
  });
});

// ============================================================
// GET /api/donations/work/:workId — Cagnotte d'une oeuvre
// ============================================================
router.get('/work/:workId', async (req, res) => {
  const work = await queryOne(
    `SELECT cagnotte_amount, cagnotte_threshold, cagnotte_donors, is_printed, printed_at
     FROM works WHERE id = $1`,
    [req.params.workId]
  );

  if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });

  const amount = parseFloat(work.cagnotte_amount || 0);
  const threshold = parseFloat(work.cagnotte_threshold || 0);

  res.json({
    amount,
    threshold,
    donors: work.cagnotte_donors,
    percentage: threshold > 0 ? Math.min(100, (amount / threshold) * 100) : 0,
    isPrinted: work.is_printed,
    printedAt: work.printed_at,
    remaining: Math.max(0, threshold - amount)
  });
});

// ============================================================
// GET /api/donations/my — Historique de mes dons
// ============================================================
router.get('/my', authenticate, async (req, res) => {
  const donations = await queryMany(
    `SELECT d.id, d.amount, d.status, d.created_at,
            w.title AS work_title, w.id AS work_id, u.pseudo AS author_pseudo
     FROM donations d
     JOIN works w ON d.work_id = w.id
     JOIN users u ON w.author_id = u.id
     WHERE d.user_id = $1
     ORDER BY d.created_at DESC`,
    [req.user.id]
  );

  res.json(donations);
});

module.exports = router;
