const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { query, queryOne, queryMany } = require('../db');
const { authenticate, authenticateOptional } = require('../middleware/auth');

const { PEPITE_TO_EUR, MIN_PEPITES, getTier } = require('../constants');

// ── POST /api/donations/create ───────────────────────────────────────────────
// Crée un Stripe PaymentIntent pour un don en pépites
router.post('/create',
  authenticateOptional,
  [
    body('workId').isUUID().withMessage('ID œuvre invalide.'),
    body('pepites').isInt({ min: MIN_PEPITES }).withMessage(`Minimum ${MIN_PEPITES} pépite.`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { workId, pepites } = req.body;
    const amountEur    = parseFloat((pepites * PEPITE_TO_EUR).toFixed(2));
    const amountCents  = Math.round(amountEur * 100);

    const work = await queryOne(
      'SELECT id, title, is_printed, vote_count FROM works WHERE id = $1 AND status = $2',
      [workId, 'published']
    );
    if (!work) return res.status(404).json({ error: 'Œuvre introuvable ou non publiée.' });
    if (work.is_printed) return res.status(400).json({ error: 'Cette œuvre a déjà été éditée.' });

    try {
      if (!process.env.STRIPE_SECRET_KEY) {
        // Mode dev sans Stripe
        const don = await queryOne(
          `INSERT INTO donations (user_id, work_id, amount_eur, amount_pepites, status)
           VALUES ($1, $2, $3, $4, 'pending') RETURNING id, amount_pepites, status`,
          [req.user?.id || null, workId, amountEur, pepites]
        );
        return res.json({ donationId: don.id, pepites, amountEur, devMode: true });
      }

      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'eur',
        metadata: { work_id: workId, work_title: work.title, user_id: req.user?.id || 'anonymous', pepites: String(pepites) },
        description: `Don LIBRUM — ${work.title} — ${pepites} 🪙`,
      });

      const don = await queryOne(
        `INSERT INTO donations (user_id, work_id, amount_eur, amount_pepites, stripe_payment_id, stripe_client_secret, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
        [req.user?.id || null, workId, amountEur, pepites, pi.id, pi.client_secret]
      );

      res.json({
        donationId     : don.id,
        clientSecret   : pi.client_secret,
        pepites,
        amountEur,
        tier           : getTier(work.vote_count || 0),
      });
    } catch (err) {
      console.error('Stripe error:', err);
      res.status(500).json({ error: 'Erreur de paiement. Veuillez réessayer.' });
    }
  }
);

// ── POST /api/donations/:id/confirm ─────────────────────────────────────────
// Confirme un don après paiement Stripe et met à jour la cagnotte
// ⚠ Vérifie le paiement Stripe avant confirmation (sécurité anti-fraude)
router.post('/:id/confirm', authenticateOptional, async (req, res) => {
  const don = await queryOne(
    'SELECT * FROM donations WHERE id = $1 AND status = $2',
    [req.params.id, 'pending']
  );
  if (!don) return res.status(404).json({ error: 'Don introuvable ou déjà traité.' });

  // ── Vérification Stripe obligatoire (sauf mode dev) ──
  if (process.env.STRIPE_SECRET_KEY && don.stripe_payment_id) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.retrieve(don.stripe_payment_id);
      if (pi.status !== 'succeeded') {
        return res.status(402).json({
          error: 'Le paiement n\'a pas été confirmé par Stripe.',
          stripeStatus: pi.status
        });
      }
    } catch (err) {
      console.error('Stripe verification error:', err);
      return res.status(500).json({ error: 'Impossible de vérifier le paiement.' });
    }
  } else if (process.env.STRIPE_SECRET_KEY && !don.stripe_payment_id) {
    // Don sans payment Stripe alors que Stripe est configuré → suspect
    return res.status(400).json({ error: 'Don sans référence de paiement.' });
  }
  // Si pas de STRIPE_SECRET_KEY → mode dev, on confirme directement

  await query(
    `UPDATE donations SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
    [don.id]
  );

  // Mettre à jour cagnotte de l'œuvre
  const updatedWork = await queryOne(
    `UPDATE works
     SET cagnotte_pepites = cagnotte_pepites + $1,
         cagnotte_donors  = cagnotte_donors  + 1,
         updated_at       = NOW()
     WHERE id = $2
     RETURNING id, title, cagnotte_pepites, cagnotte_donors, vote_count, is_printed`,
    [don.amount_pepites, don.work_id]
  );

  // Calculer seuil dynamique
  const tier  = getTier(updatedWork.vote_count || 0);
  const seuil = tier.seuil;
  const thresholdReached = updatedWork.cagnotte_pepites >= seuil && !updatedWork.is_printed;

  // Marquer comme imprimée si seuil atteint
  if (thresholdReached) {
    await query(
      `UPDATE works SET is_printed = true, printed_at = NOW() WHERE id = $1`,
      [updatedWork.id]
    );

    // Entrée Livre d'Or (aligné avec webhooks.js)
    await query(
      `INSERT INTO book_of_gold (work_id, author_id, year, month, category,
       final_rating, vote_count, cagnotte_pepites, tier_level, tirage, printed_at)
       SELECT w.id, w.author_id, EXTRACT(YEAR FROM NOW()), EXTRACT(MONTH FROM NOW()),
              w.type, w.avg_rating, w.vote_count, $2, $3, $4, NOW()
       FROM works w WHERE w.id = $1
       ON CONFLICT (work_id) DO NOTHING`,
      [updatedWork.id, updatedWork.cagnotte_pepites, tier.level, tier.tirage || 300]
    );

    // Émettre événement WebSocket — seuil atteint
    const io = req.app.get('io');
    if (io) {
      io.emit('cagnotte:threshold_reached', {
        workId    : updatedWork.id,
        title     : updatedWork.title,
        pepites   : updatedWork.cagnotte_pepites,
        tier,
      });
    }
  }

  // Récompense +1 pépite au donateur (aligné avec webhooks.js)
  if (don.user_id) {
    await query(
      'UPDATE users SET pepites_balance = pepites_balance + 1 WHERE id = $1',
      [don.user_id]
    );
  }

  // Émettre mise à jour live
  const io = req.app.get('io');
  if (io) {
    io.to(`work:${don.work_id}`).emit('cagnotte:update', {
      workId     : updatedWork.id,
      pepites    : updatedWork.cagnotte_pepites,
      donors     : updatedWork.cagnotte_donors,
      tier,
      seuil,
      pct        : Math.min(100, Math.round(updatedWork.cagnotte_pepites / seuil * 100)),
      thresholdReached,
    });
  }

  res.json({
    success          : true,
    pepites          : updatedWork.cagnotte_pepites,
    donors           : updatedWork.cagnotte_donors,
    tier,
    seuil,
    thresholdReached,
  });
});

// ── GET /api/donations/work/:workId/status ───────────────────────────────────
// Retourne l'état actuel de la cagnotte d'une œuvre
router.get('/work/:workId/status', async (req, res) => {
  const work = await queryOne(
    `SELECT id, title, cagnotte_pepites, cagnotte_donors, vote_count, is_printed
     FROM works WHERE id = $1`,
    [req.params.workId]
  );
  if (!work) return res.status(404).json({ error: 'Œuvre introuvable.' });

  const tier  = getTier(work.vote_count || 0);
  const seuil = tier.seuil;

  res.json({
    workId      : work.id,
    title       : work.title,
    pepites     : work.cagnotte_pepites,
    amountEur   : parseFloat((work.cagnotte_pepites * PEPITE_TO_EUR).toFixed(2)),
    donors      : work.cagnotte_donors,
    tier,
    seuil,
    seuilEur    : parseFloat((seuil * PEPITE_TO_EUR).toFixed(2)),
    pct         : Math.min(100, Math.round(work.cagnotte_pepites / seuil * 100)),
    is_printed  : work.is_printed,
  });
});

// ── GET /api/donations/my ────────────────────────────────────────────────────
// Historique des dons de l'utilisateur connecté
router.get('/my', authenticate, async (req, res) => {
  const donations = await queryMany(
    `SELECT d.id, d.amount_pepites, d.amount_eur, d.status, d.created_at,
            w.title as work_title, w.id as work_id
     FROM donations d
     JOIN works w ON w.id = d.work_id
     WHERE d.user_id = $1
     ORDER BY d.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  res.json(donations);
});

module.exports = router;
