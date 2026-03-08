const express = require('express');
const router  = express.Router();
const { query, queryOne, queryMany } = require('../db');
const { authenticate, requireLevel } = require('../middleware/auth');

const { PEPITE_TO_EUR, TIER_LABELS } = require('../constants');

// ── GET /api/book-of-gold ────────────────────────────────────
// Liste du Livre d'Or (filtrable par année, mois, type)
router.get('/', async (req, res) => {
  const { year, month, type } = req.query;
  const params = [];
  const cond   = [];

  if (year)  { params.push(parseInt(year));  cond.push(`bg.year = $${params.length}`);  }
  if (month) { params.push(parseInt(month)); cond.push(`bg.month = $${params.length}`); }
  if (type)  { params.push(type);            cond.push(`w.type = $${params.length}`);   }

  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  const entries = await queryMany(
    `SELECT bg.id, bg.year, bg.month, bg.category, bg.final_rating, bg.vote_count,
            bg.cagnotte_pepites, bg.tier_level, bg.tirage, bg.author_quote,
            bg.printed_at, bg.created_at,
            w.id AS work_id, w.title, w.cover_url, w.type, w.description,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar, u.id AS author_id
     FROM book_of_gold bg
     JOIN works w ON bg.work_id = w.id
     JOIN users u ON bg.author_id = u.id
     ${where}
     ORDER BY bg.year DESC, bg.month DESC, bg.final_rating DESC`,
    params
  );

  const enriched = entries.map(e => ({
    ...e,
    cagnotte_eur: parseFloat(((e.cagnotte_pepites || 0) * PEPITE_TO_EUR).toFixed(2)),
    tier_label  : TIER_LABELS[e.tier_level - 1] || '—',
  }));

  res.json(enriched);
});

// ══════════════════════════════════════════════════════════════
// IMPORTANT : /quote et /stats/* DOIVENT être AVANT /:id
// sinon Express matche "stats" ou "quote" comme un :id
// ══════════════════════════════════════════════════════════════

// ── POST /api/book-of-gold/quote ─────────────────────────────
// Auteur ajoute une dédicace/citation pour son Livre d'Or
router.post('/quote',
  authenticate,
  async (req, res) => {
    const { workId, quote } = req.body;
    if (!quote || quote.length > 500) {
      return res.status(400).json({ error: 'Citation requise, max 500 caractères.' });
    }

    const entry = await queryOne(
      `SELECT bg.id FROM book_of_gold bg
       JOIN works w ON bg.work_id = w.id
       WHERE bg.work_id = $1 AND w.author_id = $2`,
      [workId, req.user.id]
    );
    if (!entry) return res.status(404).json({ error: 'Entrée introuvable ou accès interdit.' });

    await query(
      'UPDATE book_of_gold SET author_quote = $1 WHERE id = $2',
      [quote.trim(), entry.id]
    );

    res.json({ message: 'Citation enregistrée dans le Livre d\'Or.' });
  }
);

// ── GET /api/book-of-gold/stats/summary ──────────────────────
// Statistiques globales du Livre d'Or
router.get('/stats/summary', async (req, res) => {
  const stats = await queryOne(
    `SELECT
       COUNT(*)                       AS total_entries,
       SUM(bg.cagnotte_pepites)       AS total_pepites,
       SUM(bg.tirage)                 AS total_printed_copies,
       AVG(bg.final_rating)           AS avg_rating,
       COUNT(DISTINCT bg.author_id)   AS unique_authors
     FROM book_of_gold bg`, []
  );

  res.json({
    total_entries       : parseInt(stats.total_entries),
    total_pepites       : parseInt(stats.total_pepites || 0),
    total_eur           : parseFloat(((stats.total_pepites || 0) * PEPITE_TO_EUR).toFixed(2)),
    total_printed_copies: parseInt(stats.total_printed_copies || 0),
    avg_rating          : parseFloat(parseFloat(stats.avg_rating || 0).toFixed(2)),
    unique_authors      : parseInt(stats.unique_authors),
  });
});

// ── GET /api/book-of-gold/:id ────────────────────────────────
// Détail d'une entrée du Livre d'Or
// ⚠ DOIT rester EN DERNIER — sinon "stats"/"quote" seraient matchés comme :id
router.get('/:id', async (req, res) => {
  const entry = await queryOne(
    `SELECT bg.*, w.id AS work_id, w.title, w.description, w.cover_url, w.type,
            w.word_count, w.content_warnings,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar,
            u.bio AS author_bio
     FROM book_of_gold bg
     JOIN works w ON bg.work_id = w.id
     JOIN users u ON bg.author_id = u.id
     WHERE bg.id = $1`,
    [req.params.id]
  );
  if (!entry) return res.status(404).json({ error: 'Entrée introuvable.' });

  res.json({
    ...entry,
    cagnotte_eur: parseFloat(((entry.cagnotte_pepites || 0) * PEPITE_TO_EUR).toFixed(2)),
  });
});

module.exports = router;
