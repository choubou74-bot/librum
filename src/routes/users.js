const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { query, queryOne, queryMany } = require('../db');
const { authenticate } = require('../middleware/auth');

const { PEPITE_TO_EUR } = require('../constants');

// ══════════════════════════════════════════════════════════════
// IMPORTANT : les routes /me/* DOIVENT être AVANT /:pseudo
// sinon Express matche "me" comme un pseudo
// ══════════════════════════════════════════════════════════════

// ── PUT /api/users/me/profile ────────────────────────────────
// Mettre à jour son propre profil
router.put('/me/profile',
  authenticate,
  [
    body('bio').optional().isLength({ max: 1000 }),
    body('avatar_url').optional().isURL().withMessage('URL avatar invalide.'),
    body('website').optional().isURL().withMessage('URL invalide.'),
    body('lang').optional().isIn(['fr','en','es','de','ar','pt']),
    body('dark_mode').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { bio, avatar_url, website, lang, dark_mode } = req.body;
    await query(
      `UPDATE users SET
         bio        = COALESCE($1, bio),
         avatar_url = COALESCE($2, avatar_url),
         website    = COALESCE($3, website),
         lang       = COALESCE($4, lang),
         dark_mode  = COALESCE($5, dark_mode),
         updated_at = NOW()
       WHERE id = $6`,
      [bio || null, avatar_url || null, website || null,
       lang || null, dark_mode ?? null, req.user.id]
    );
    res.json({ message: 'Profil mis à jour.' });
  }
);

// ── GET /api/users/me/dashboard ──────────────────────────────
// Données complètes pour le tableau de bord auteur
router.get('/me/dashboard', authenticate, async (req, res) => {
  const [user, works, recentVotes, recentDonations] = await Promise.all([
    queryOne(
      `SELECT id, pseudo, bio, avatar_url, account_level, reputation_score,
              votes_remaining, pepites_balance, total_works, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    ),
    queryMany(
      `SELECT id, title, type, status, avg_rating, vote_count, view_count,
              cagnotte_pepites, cagnotte_donors, is_printed, published_at
       FROM works WHERE author_id = $1 ORDER BY updated_at DESC`,
      [req.user.id]
    ),
    queryMany(
      `SELECT v.rating, v.comment, v.created_at,
              CASE WHEN v.is_anonymous THEN 'Anonyme' ELSE u.pseudo END AS voter_pseudo,
              w.title AS work_title, w.id AS work_id
       FROM votes v
       JOIN works w ON v.work_id = w.id
       JOIN users u ON v.user_id = u.id
       WHERE w.author_id = $1
       ORDER BY v.created_at DESC LIMIT 5`,
      [req.user.id]
    ),
    queryMany(
      `SELECT d.amount_pepites, d.created_at,
              COALESCE(u.pseudo, 'Anonyme') AS donor_pseudo,
              w.title AS work_title
       FROM donations d
       JOIN works w ON d.work_id = w.id
       LEFT JOIN users u ON d.user_id = u.id
       WHERE w.author_id = $1 AND d.status = 'confirmed'
       ORDER BY d.created_at DESC LIMIT 5`,
      [req.user.id]
    ),
  ]);

  const totalPepites   = works.reduce((s, w) => s + (w.cagnotte_pepites || 0), 0);
  const totalViews     = works.reduce((s, w) => s + (w.view_count || 0), 0);
  const totalVotes     = works.reduce((s, w) => s + (w.vote_count || 0), 0);
  const publishedWorks = works.filter(w => w.status === 'published' || w.status === 'printed');

  res.json({
    user,
    stats: {
      total_works          : works.length,
      published_works      : publishedWorks.length,
      total_views          : totalViews,
      total_votes          : totalVotes,
      total_cagnotte_pepites: totalPepites,
      total_cagnotte_eur   : parseFloat((totalPepites * PEPITE_TO_EUR).toFixed(2)),
      votes_remaining      : user.votes_remaining,
      pepites_balance      : user.pepites_balance,
    },
    works,
    recent_votes     : recentVotes,
    recent_donations : recentDonations,
  });
});

// ── POST /api/users/me/follow/:targetId ──────────────────────
// Suivre / ne plus suivre un auteur
router.post('/me/follow/:targetId', authenticate, async (req, res) => {
  if (req.params.targetId === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas vous suivre vous-même.' });
  }

  const existing = await queryOne(
    'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
    [req.user.id, req.params.targetId]
  );

  if (existing) {
    await query('DELETE FROM follows WHERE id = $1', [existing.id]);
    res.json({ following: false });
  } else {
    await query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)',
      [req.user.id, req.params.targetId]
    );
    res.json({ following: true });
  }
});

// ── GET /api/users/me/pepites ────────────────────────────────
// Solde et historique pépites
router.get('/me/pepites', authenticate, async (req, res) => {
  const user = await queryOne(
    'SELECT pepites_balance FROM users WHERE id = $1',
    [req.user.id]
  );

  const history = await queryMany(
    `SELECT reason, amount, created_at
     FROM pepites_log
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );

  res.json({
    balance : user.pepites_balance,
    balance_eur: parseFloat((user.pepites_balance * PEPITE_TO_EUR).toFixed(2)),
    history,
  });
});

// ── GET /api/users/:pseudo ───────────────────────────────────
// Profil public d'un auteur
// ⚠ DOIT rester EN DERNIER — sinon "me" serait matché comme pseudo
router.get('/:pseudo', async (req, res) => {
  const user = await queryOne(
    `SELECT id, pseudo, bio, avatar_url, website, account_level,
            reputation_score, total_works, created_at
     FROM users WHERE pseudo = $1 AND status = 'active'`,
    [req.params.pseudo]
  );
  if (!user) return res.status(404).json({ error: 'Auteur introuvable.' });

  const [works, badges, supporters, followers] = await Promise.all([
    queryMany(
      `SELECT id, title, type, cover_url, avg_rating, vote_count,
              cagnotte_pepites, is_printed, published_at
       FROM works WHERE author_id = $1 AND status IN ('published','printed')
       ORDER BY published_at DESC`,
      [user.id]
    ),
    queryMany(
      'SELECT badge_type, awarded_at FROM badges WHERE user_id = $1 ORDER BY awarded_at DESC',
      [user.id]
    ),
    queryMany(
      `SELECT u2.pseudo, SUM(d.amount_pepites) AS total_pepites
       FROM donations d
       JOIN users u2 ON d.user_id = u2.id
       JOIN works w ON d.work_id = w.id
       WHERE w.author_id = $1 AND d.status = 'confirmed'
       GROUP BY u2.pseudo ORDER BY total_pepites DESC LIMIT 5`,
      [user.id]
    ),
    queryOne(
      'SELECT COUNT(*) FROM follows WHERE following_id = $1',
      [user.id]
    ),
  ]);

  const totalCag = works.reduce((s, w) => s + (w.cagnotte_pepites || 0), 0);

  res.json({
    ...user,
    // pepites_balance retiré du profil public (donnée privée)
    total_cagnotte_pepites: totalCag,
    total_cagnotte_eur    : parseFloat((totalCag * PEPITE_TO_EUR).toFixed(2)),
    follower_count        : parseInt(followers.count),
    works,
    badges,
    supporters,
  });
});

module.exports = router;
