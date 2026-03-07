const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { query, queryOne, queryMany } = require('../db');
const { authenticate } = require('../middleware/auth');

// ============================================================
// POST /api/votes — Voter pour une oeuvre
// ============================================================
router.post('/',
  authenticate,
  [
    body('workId').isUUID(),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Note entre 1 et 5.'),
    body('comment').optional().isLength({ max: 1000 }),
    body('isAnonymous').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { workId, rating, comment, isAnonymous } = req.body;
    const userId = req.user.id;

    // Compte doit avoir 7+ jours
    const user = await queryOne(
      'SELECT created_at, votes_remaining, last_vote_reset, account_level FROM users WHERE id = $1',
      [userId]
    );

    const daysSinceCreation = (Date.now() - new Date(user.created_at)) / (1000 * 60 * 60 * 24);
    if (daysSinceCreation < 7) {
      return res.status(403).json({
        error: 'Vous devez attendre 7 jours après l\'inscription pour voter.',
        daysRemaining: Math.ceil(7 - daysSinceCreation)
      });
    }

    // Reset mensuel des votes si nécessaire
    const lastReset = new Date(user.last_vote_reset);
    const now = new Date();
    if (lastReset.getMonth() !== now.getMonth() || lastReset.getFullYear() !== now.getFullYear()) {
      await query(
        'UPDATE users SET votes_remaining = 5, last_vote_reset = CURRENT_DATE WHERE id = $1',
        [userId]
      );
      user.votes_remaining = 5;
    }

    // Vérifier votes restants
    const existingVote = await queryOne(
      'SELECT id FROM votes WHERE user_id = $1 AND work_id = $2',
      [userId, workId]
    );

    if (!existingVote && user.votes_remaining <= 0) {
      return res.status(403).json({
        error: 'Plus de votes disponibles ce mois. Revenez le mois prochain.',
        votesRemaining: 0
      });
    }

    // Vérifier que l'oeuvre est publiée
    const work = await queryOne(
      'SELECT id, author_id FROM works WHERE id = $1 AND status = $2',
      [workId, 'published']
    );
    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable ou non publiée.' });

    // Pas de vote sur sa propre oeuvre
    if (work.author_id === userId) {
      return res.status(403).json({ error: 'Vous ne pouvez pas voter pour votre propre oeuvre.' });
    }

    // Poids du vote selon le niveau
    const voteWeight = getVoteWeight(user.account_level);

    if (existingVote) {
      // Modifier le vote existant (1 seule modification autorisée dans les 48h)
      await query(
        `UPDATE votes SET rating = $1, comment = $2, is_anonymous = $3,
         vote_weight = $4, updated_at = NOW()
         WHERE id = $5`,
        [rating, comment || null, isAnonymous || false, voteWeight, existingVote.id]
      );
    } else {
      // Nouveau vote
      await query(
        `INSERT INTO votes (user_id, work_id, rating, comment, is_anonymous, vote_weight)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, workId, rating, comment || null, isAnonymous || false, voteWeight]
      );

      // Décrémenter votes restants
      await query(
        'UPDATE users SET votes_remaining = votes_remaining - 1 WHERE id = $1',
        [userId]
      );
    }

    // Récupérer la nouvelle moyenne (mise à jour par trigger)
    const updatedWork = await queryOne(
      'SELECT avg_rating, vote_count FROM works WHERE id = $1',
      [workId]
    );

    res.json({
      message: existingVote ? 'Vote mis à jour.' : 'Vote enregistré.',
      newRating: parseFloat(updatedWork.avg_rating),
      voteCount: updatedWork.vote_count,
      votesRemaining: existingVote ? user.votes_remaining : user.votes_remaining - 1
    });
  }
);

// Poids du vote selon le niveau de compte
function getVoteWeight(level) {
  const weights = { 1: 1.0, 2: 1.0, 3: 1.05, 4: 1.1, 5: 1.15, 6: 1.2 };
  return weights[level] || 1.0;
}

// ============================================================
// GET /api/votes/work/:workId — Votes d'une oeuvre
// ============================================================
router.get('/work/:workId', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const votes = await queryMany(
    `SELECT v.id, v.rating, v.comment, v.created_at,
            CASE WHEN v.is_anonymous THEN NULL ELSE u.pseudo END AS author_pseudo,
            CASE WHEN v.is_anonymous THEN NULL ELSE u.avatar_url END AS author_avatar,
            CASE WHEN v.is_anonymous THEN NULL ELSE u.account_level END AS author_level
     FROM votes v
     JOIN users u ON v.user_id = u.id
     WHERE v.work_id = $1
     ORDER BY v.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.params.workId, parseInt(limit), offset]
  );

  const total = await queryOne(
    'SELECT COUNT(*) FROM votes WHERE work_id = $1',
    [req.params.workId]
  );

  res.json({
    votes,
    total: parseInt(total.count),
    page: parseInt(page),
    pages: Math.ceil(parseInt(total.count) / parseInt(limit))
  });
});

// ============================================================
// GET /api/votes/my — Mes votes
// ============================================================
router.get('/my', authenticate, async (req, res) => {
  const votes = await queryMany(
    `SELECT v.id, v.rating, v.comment, v.created_at,
            w.id AS work_id, w.title, w.type, w.cover_url
     FROM votes v
     JOIN works w ON v.work_id = w.id
     WHERE v.user_id = $1
     ORDER BY v.created_at DESC`,
    [req.user.id]
  );

  res.json(votes);
});

module.exports = router;
