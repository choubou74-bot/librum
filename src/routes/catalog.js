const express = require('express');
const router  = express.Router();
const { queryOne, queryMany } = require('../db');

const { PEPITE_TO_EUR, getTier } = require('../constants');
function enrich(w) {
  const tier = getTier(w.vote_count || 0);
  return { ...w, tier, cagnotte_seuil: tier.seuil,
    cagnotte_eur: parseFloat(((w.cagnotte_pepites||0) * PEPITE_TO_EUR).toFixed(2)),
    cagnotte_pct: Math.min(100, Math.round((w.cagnotte_pepites||0) / tier.seuil * 100)) };
}

const VALID_TYPES = ['roman','nouvelle','poesie','essai','scenario_film',
                     'scenario_serie','scenario_court','bd','jeunesse','biographie','documentaire'];

// ── GET /api/catalog ─────────────────────────────────────────
router.get('/', async (req, res) => {
  const { page=1, limit=24, type, genre, lang, sort='recent',
          search, minRating, hasCagnotte } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(50, parseInt(limit));
  const params = [];
  const cond   = ["w.status = 'published'"];

  if (type && VALID_TYPES.includes(type))         { params.push(type);             cond.push(`w.type = $${params.length}`); }
  if (genre)                                       { params.push(`%${genre}%`);     cond.push(`w.genre ILIKE $${params.length}`); }
  if (lang)                                        { params.push(lang);             cond.push(`w.language = $${params.length}`); }
  if (minRating)                                   { params.push(parseFloat(minRating)); cond.push(`w.avg_rating >= $${params.length}`); }
  if (hasCagnotte === 'true')                      { cond.push('w.cagnotte_pepites > 0'); }
  if (search) {
    params.push(`%${search}%`);
    cond.push(`(w.title ILIKE $${params.length} OR w.description ILIKE $${params.length} OR u.pseudo ILIKE $${params.length})`);
  }

  const sortMap = {
    recent    : 'w.published_at DESC',
    top_rated : 'w.avg_rating DESC, w.vote_count DESC',
    most_voted: 'w.vote_count DESC',
    cagnotte  : 'w.cagnotte_pepites DESC',
    most_read : 'w.view_count DESC',
  };
  const orderBy = sortMap[sort] || sortMap.recent;
  const where   = cond.join(' AND ');
  const lim     = Math.min(50, parseInt(limit));

  params.push(lim, offset);
  const works = await queryMany(
    `SELECT w.id, w.title, w.type, w.genre, w.description, w.cover_url, w.language,
            w.word_count, w.reading_time_min, w.avg_rating, w.vote_count, w.view_count,
            w.cagnotte_pepites, w.cagnotte_donors, w.is_printed,
            w.published_at, w.tags, w.is_adult_content, w.content_warnings,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar
     FROM works w JOIN users u ON w.author_id = u.id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const totalResult = await queryOne(
    `SELECT COUNT(*) FROM works w JOIN users u ON w.author_id = u.id WHERE ${where}`,
    params.slice(0, -2)
  );

  res.json({
    works : works.map(enrich),
    total : parseInt(totalResult.count),
    page  : parseInt(page),
    pages : Math.ceil(parseInt(totalResult.count) / lim),
  });
});

// ── GET /api/catalog/featured ────────────────────────────────
router.get('/featured', async (req, res) => {
  const [topRated, nearPrint, recent, printed] = await Promise.all([
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.avg_rating, w.vote_count,
              w.cagnotte_pepites, u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published' AND w.published_at >= NOW() - INTERVAL '30 days'
       ORDER BY w.avg_rating DESC, w.vote_count DESC LIMIT 6`, []
    ),
    // Proches du seuil (% croissant, non encore édités)
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.cagnotte_pepites,
              w.vote_count, w.cagnotte_donors,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published' AND NOT w.is_printed AND w.cagnotte_pepites > 0
       ORDER BY w.cagnotte_pepites DESC LIMIT 4`, []
    ),
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.published_at,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.status = 'published'
       ORDER BY w.published_at DESC LIMIT 8`, []
    ),
    queryMany(
      `SELECT w.id, w.title, w.type, w.cover_url, w.printed_at,
              w.cagnotte_pepites, w.vote_count,
              u.pseudo AS author_pseudo
       FROM works w JOIN users u ON w.author_id = u.id
       WHERE w.is_printed = true
       ORDER BY w.printed_at DESC LIMIT 4`, []
    ),
  ]);

  res.json({
    topRated  : topRated.map(enrich),
    nearPrint : nearPrint.map(enrich),
    recent,
    printed   : printed.map(enrich),
  });
});

// ── GET /api/catalog/ranking ─────────────────────────────────
router.get('/ranking', async (req, res) => {
  const { type } = req.query;
  const params   = [];
  let whereType  = '';
  if (type && VALID_TYPES.includes(type)) { params.push(type); whereType = `AND w.type = $1`; }

  const ranking = await queryMany(
    `SELECT w.id, w.title, w.type, w.cover_url, w.avg_rating, w.vote_count,
            w.cagnotte_pepites, w.is_printed,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar,
            RANK() OVER (PARTITION BY w.type ORDER BY w.avg_rating DESC, w.vote_count DESC) AS rank
     FROM works w JOIN users u ON w.author_id = u.id
     WHERE w.status = 'published'
       AND w.published_at >= date_trunc('month', NOW())
       ${whereType}
     ORDER BY w.type, rank`,
    params
  );

  const grouped = ranking.reduce((acc, w) => {
    if (!acc[w.type]) acc[w.type] = [];
    acc[w.type].push(enrich(w));
    return acc;
  }, {});

  res.json(grouped);
});

// ── GET /api/catalog/stats ───────────────────────────────────
router.get('/stats', async (req, res) => {
  const [totals, cagTotal] = await Promise.all([
    queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'published') AS total_works,
         COUNT(DISTINCT author_id) AS total_authors,
         COUNT(*) FILTER (WHERE is_printed) AS total_printed
       FROM works`, []
    ),
    queryOne(`SELECT SUM(cagnotte_pepites) AS total_pepites FROM works WHERE status = 'published'`, []),
  ]);

  const members = await queryOne(`SELECT COUNT(*) FROM users WHERE status = 'active'`, []);

  res.json({
    total_works   : parseInt(totals.total_works),
    total_authors : parseInt(totals.total_authors),
    total_printed : parseInt(totals.total_printed),
    total_members : parseInt(members.count),
    total_pepites : parseInt(cagTotal.total_pepites || 0),
    total_eur     : parseFloat(((cagTotal.total_pepites || 0) * PEPITE_TO_EUR).toFixed(2)),
  });
});

module.exports = router;
