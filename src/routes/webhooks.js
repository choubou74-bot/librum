// routes/webhooks.js — Stripe webhook handler
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');

// Important : raw body pour vérification signature Stripe
router.post('/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.json({ received: true, devMode: true });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;

      const donation = await queryOne(
        'SELECT id FROM donations WHERE stripe_payment_id = $1',
        [paymentIntent.id]
      );

      if (donation) {
        await query(
          'UPDATE donations SET status = $1, confirmed_at = NOW() WHERE id = $2',
          ['confirmed', donation.id]
        );
        // Le trigger PostgreSQL met à jour la cagnotte
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      await query(
        'UPDATE donations SET status = $1 WHERE stripe_payment_id = $2',
        ['failed', paymentIntent.id]
      );
    }

    res.json({ received: true });
  }
);

module.exports = router;
