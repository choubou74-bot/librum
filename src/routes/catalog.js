const express = require('express');
const router = express.Router();
const { query, queryOne, queryMany } = require('../db');

const VALID_TYPES = ['roman','nouvelle','poesie','essai','scenario_film',
                     'scenario_serie','scenario_court','bd','jeunesse','biographie','documentaire'];

// ============================================================
// GET /api/catalog — Catalogue public
// ============================================================
router.get('/', async (req, res) => {
  const {
    page = 1,
    limit = 24,
    type,
    genre,
    lang,
    sort = 'recent',
    search,
    minRating,
    hasCagnotte
  } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  const conditions = ["w.status = 'published'"];

  if (type && VALID_TYPES.includes(type)) {
    params.push(type);
    conditions.push(`w.type = $${params.length}`);
  }

  if (genre) {
    params.push(`%${genre}%`);
    conditions.push(`w.genre ILIKE $${params.length}`);
  }

  if (lang) {
    params.push(lang);
    conditions.push(`w.language = $${params.length}`);
  }

  if (minRating) {
    params.push(parseFloat(minRating));
    conditions.push(`w.avg_rating >= $${params.length}`);
  }

  if (hasCagnotte === 'true') {
    conditions.push('w.cagnotte_amount > 0');
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(w.title ILIKE $${params.length} OR w.description ILIKE $${params.length})`);
  }

  const sortMap = {
    recent: 'w.published_at DESC',
    top_rated: 'w.avg_rating DESC, w.vote_count DESC',
    most_voted: 'w.vote_count DESC',
    cagnotte: 'w.cagnotte_amount DESC',
    most_read: 'w.view_count DESC'
  };
  const orderBy = sortMap[sort] || sortMap.recent;

  const where = conditions.join(' AND ');
  params.push(parseInt(limit), offset);

  const works = await queryMany(
    `SELECT w.id, w.title, w.type, w.genre, w.description, w.cover_url,
            w.language, w.word_count, w.avg_rating, w.vote_count,
            w.cagnotte_amount, w.cagnotte_threshold, w.cagnotte_donors,
            w.is_printed, w.published_at, w.reading_time_min,
            w.content_warnings, w.is_adult_content, w.tags,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar
     FROM works w
     JOIN users u ON w.author_id = u.id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, -2);
  const totalResult = await queryOne(
    `SELECT COUNT(*) FROM works w WHERE ${where}`,
    countParams
  );

  res.json({
    works,
    total: parseInt(totalResult.count),
    page: parseInt(page),
    pages: Math.ceil(parseInt(totalResult.count) / parseInt(limit))
  });
});

// ============================================================
// GET /api/catalog/featured — Oeuvres mises en avant
// ============================================================
router.get('/featured', async (req, res) => {
  const [topRated, mostCagnotte, recent, nearPrint] = await Promise.all([
    // Top notées ce mois
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.avg_rating, w.vote_count,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published' AND w.published_at >= NOW() - INTERVAL '30 days'
       ORDER BY w.avg_rating DESC, w.vote_count DESC LIMIT 6`,
      []
    ),
    // Plus grande cagnotte
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.cagnotte_amount, w.cagnotte_threshold,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published' AND NOT w.is_printed
       ORDER BY w.cagnotte_amount DESC LIMIT 4`,
      []
    ),
    // Nouvelles publications
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.published_at,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published'
       ORDER BY w.published_at DESC LIMIT 8`,
      []
    ),
    // Proches de l'impression
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url,
              w.cagnotte_amount, w.cagnotte_threshold,
              ROUND((w.cagnotte_amount / w.cagnotte_threshold * 100)::numeric, 1) AS percentage,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published' AND NOT w.is_printed
         AND w.cagnotte_threshold > 0
         AND w.cagnotte_amount > 0
       ORDER BY (w.cagnotte_amount / w.cagnotte_threshold) DESC LIMIT 4`,
      []
    )
  ]);

  res.json({ topRated, mostCagnotte, recent, nearPrint });
});

// ============================================================
// GET /api/catalog/ranking — Classement mensuel
// ============================================================
router.get('/ranking', async (req, res) => {
  const { type } = req.query;

  let whereType = '';
  const params = [];
  if (type && VALID_TYPES.includes(type)) {
    params.push(type);
    whereType = `AND w.type = $1`;
  }

  const ranking = await queryMany(
    `SELECT w.id, w.title, w.type, w.cover_url,
            w.avg_rating, w.vote_count, w.cagnotte_amount,
            w.cagnotte_threshold, w.is_printed,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar,
            RANK() OVER (PARTITION BY w.type ORDER BY w.avg_rating DESC, w.vote_count DESC) AS rank
     FROM works w
     JOIN users u ON w.author_id = u.id
     WHERE w.status = 'published'
       AND w.published_at >= date_trunc('month', NOW())
       ${whereType}
     ORDER BY w.type, rank`,
    params
  );

  // Grouper par type
  const grouped = ranking.reduce((acc, work) => {
    if (!acc[work.type]) acc[work.type] = [];
    acc[work.type].push(work);
    return acc;
  }, {});

  res.json(grouped);
});

module.exports = router;
