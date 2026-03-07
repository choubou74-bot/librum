// routes/users.js
const express = require('express');
const router = express.Router();
const { queryOne, queryMany } = require('../db');
const { authenticate } = require('../middleware/auth');

// Profil public d'un auteur
router.get('/:pseudo', async (req, res) => {
  const user = await queryOne(
    `SELECT id, pseudo, bio, avatar_url, website, account_level,
            reputation_score, total_works, total_donations, created_at
     FROM users WHERE pseudo = $1 AND status = 'active'`,
    [req.params.pseudo]
  );
  if (!user) return res.status(404).json({ error: 'Auteur introuvable.' });

  const works = await queryMany(
    `SELECT id, title, type, cover_url, avg_rating, vote_count, published_at
     FROM works WHERE author_id = $1 AND status = 'published'
     ORDER BY published_at DESC`,
    [user.id]
  );

  const badges = await queryMany(
    'SELECT badge_type, awarded_at FROM badges WHERE user_id = $1',
    [user.id]
  );

  res.json({ ...user, works, badges });
});

// Mettre à jour son propre profil
router.put('/me/profile', authenticate, async (req, res) => {
  const { bio, avatar_url, website, lang, dark_mode } = req.body;
  const { query } = require('../db');

  await query(
    `UPDATE users SET bio = $1, avatar_url = $2, website = $3,
     lang = $4, dark_mode = $5, updated_at = NOW() WHERE id = $6`,
    [bio || null, avatar_url || null, website || null,
     lang || 'fr', dark_mode || false, req.user.id]
  );

  res.json({ message: 'Profil mis à jour.' });
});

module.exports = router;
