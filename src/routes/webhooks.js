// routes/webhooks.js — Stripe webhook handler
const express = require('express');
const router  = express.Router();
const { query, queryOne } = require('../db');

// IMPORTANT : raw body obligatoire pour vérification signature Stripe
// Déclaré AVANT express.json() dans index.js
router.post('/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // Mode dev sans Stripe
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.json({ received: true, devMode: true });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig    = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error(`Stripe webhook signature error: ${err.message}`);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    const { getTier } = require('../constants');

    try {
      switch (event.type) {

        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          const don = await queryOne(
            'SELECT id, work_id, amount_pepites, user_id FROM donations WHERE stripe_payment_id = $1',
            [pi.id]
          );
          if (!don) break;

          // Confirmer le don
          await query(
            `UPDATE donations SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
            [don.id]
          );

          // Mettre à jour la cagnotte de l'œuvre
          const updatedWork = await queryOne(
            `UPDATE works
             SET cagnotte_pepites = cagnotte_pepites + $1,
                 cagnotte_donors  = cagnotte_donors  + 1,
                 updated_at       = NOW()
             WHERE id = $2
             RETURNING id, title, cagnotte_pepites, cagnotte_donors, vote_count, is_printed`,
            [don.amount_pepites, don.work_id]
          );

          // Vérifier si seuil atteint
          const tier  = getTier(updatedWork.vote_count || 0);
          const seuil = tier.seuil;
          const thresholdReached = updatedWork.cagnotte_pepites >= seuil && !updatedWork.is_printed;

          if (thresholdReached) {
            await query(
              `UPDATE works SET is_printed = true, printed_at = NOW() WHERE id = $1`,
              [updatedWork.id]
            );
            // Entrée Livre d'Or
            await query(
              `INSERT INTO book_of_gold (work_id, author_id, year, month, category,
               final_rating, vote_count, cagnotte_pepites, tier_level, tirage, printed_at)
               SELECT w.id, w.author_id, EXTRACT(YEAR FROM NOW()), EXTRACT(MONTH FROM NOW()),
                      w.type, w.avg_rating, w.vote_count, $2, $3, $4, NOW()
               FROM works w WHERE w.id = $1
               ON CONFLICT (work_id) DO NOTHING`,
              [updatedWork.id, updatedWork.cagnotte_pepites, tier.level, tier.tirage]
            );
            console.log(`🏆 Seuil atteint: "${updatedWork.title}" — ${tier.tirage} ex. commandés`);
          }

          // Récompense +1 pépite au donateur
          if (don.user_id) {
            await query(
              'UPDATE users SET pepites_balance = pepites_balance + 1 WHERE id = $1',
              [don.user_id]
            );
          }

          // Émettre WebSocket live
          const io = req.app?.get?.('io');
          if (io) {
            io.to(`work:${don.work_id}`).emit('cagnotte:update', {
              workId           : updatedWork.id,
              pepites          : updatedWork.cagnotte_pepites,
              donors           : updatedWork.cagnotte_donors,
              tier, seuil,
              pct              : Math.min(100, Math.round(updatedWork.cagnotte_pepites / seuil * 100)),
              thresholdReached,
            });
          }
          break;
        }

        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          await query(
            `UPDATE donations SET status = 'failed', updated_at = NOW()
             WHERE stripe_payment_id = $1`,
            [pi.id]
          );
          console.warn(`Paiement échoué: ${pi.id}`);
          break;
        }

        case 'charge.dispute.created': {
          // Litige Stripe — marquer le don et alerter
          console.error(`Litige Stripe: ${event.data.object.id}`);
          break;
        }

        default:
          // Événement non géré — log silencieux
          break;
      }
    } catch (err) {
      console.error('Webhook handler error:', err);
      // On répond quand même 200 pour éviter les retries Stripe
    }

    res.json({ received: true });
  }
);

module.exports = router;
