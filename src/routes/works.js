const express   = require('express');
const router    = express.Router();
const { body, validationResult } = require('express-validator');
const { query, queryOne, queryMany, withTransaction } = require('../db');
const { authenticate, authenticateOptional, requireLevel } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const { PEPITE_TO_EUR, getTier } = require('../constants');

const VALID_TYPES = ['roman','nouvelle','poesie','essai','scenario_film',
                     'scenario_serie','scenario_court','bd','jeunesse','biographie','documentaire'];

// ── GET /api/works ───────────────────────────────────────────
// Mes œuvres (auteur connecté)
router.get('/', authenticate, async (req, res) => {
  const works = await queryMany(
    `SELECT id, title, type, genre, status, word_count, avg_rating,
            vote_count, cagnotte_pepites, cagnotte_donors, is_printed,
            cover_url, published_at, created_at, updated_at
     FROM works WHERE author_id = $1
     ORDER BY updated_at DESC`,
    [req.user.id]
  );
  // Enrichir avec tier dynamique
  const enriched = works.map(w => {
    const tier = getTier(w.vote_count || 0);
    return {
      ...w,
      tier,
      cagnotte_seuil:    tier.seuil,
      cagnotte_eur:      parseFloat((w.cagnotte_pepites * PEPITE_TO_EUR).toFixed(2)),
      cagnotte_pct:      Math.min(100, Math.round(w.cagnotte_pepites / tier.seuil * 100)),
    };
  });
  res.json(enriched);
});

// ── POST /api/works ──────────────────────────────────────────
// Créer une nouvelle œuvre (brouillon)
router.post('/',
  authenticate, requireLevel(1),
  [
    body('title').trim().isLength({ min: 1, max: 255 }).withMessage('Titre requis.'),
    body('type').isIn(VALID_TYPES).withMessage('Type invalide.'),
    body('language').optional().isLength({ min: 2, max: 5 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { title, type, genre, language } = req.body;
    const work = await queryOne(
      `INSERT INTO works (author_id, title, type, genre, language, content_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING id, title, type, genre, status, created_at`,
      [req.user.id, title, type, genre || null, language || 'fr',
       JSON.stringify({ chapters: [{ id: uuidv4(), title: 'Chapitre 1', content: '' }] })]
    );
    res.status(201).json(work);
  }
);

// ── GET /api/works/:id ───────────────────────────────────────
// Détail d'une œuvre (public si publiée, auteur si brouillon)
router.get('/:id', authenticateOptional, async (req, res) => {
  const work = await queryOne(
    `SELECT w.id, w.title, w.type, w.genre, w.description, w.cover_url,
            w.language, w.word_count, w.reading_time_min, w.tags,
            w.avg_rating, w.vote_count, w.view_count, w.status,
            w.cagnotte_pepites, w.cagnotte_donors, w.is_printed,
            w.is_adult_content, w.content_warnings,
            w.watermark_id, w.published_at, w.printed_at,
            w.content_json, w.author_id,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar,
            u.bio AS author_bio, u.reputation_score AS author_reputation
     FROM works w
     JOIN users u ON w.author_id = u.id
     WHERE w.id = $1`,
    [req.params.id]
  );

  if (!work) return res.status(404).json({ error: 'Œuvre introuvable.' });

  // Brouillon : accessible uniquement par l'auteur
  if (work.status === 'draft') {
    if (!req.user || req.user.id !== work.author_id) {
      return res.status(403).json({ error: 'Accès interdit.' });
    }
  }

  // Incrémenter vues (non-auteur uniquement)
  if (req.user?.id !== work.author_id && work.status === 'published') {
    query('UPDATE works SET view_count = view_count + 1 WHERE id = $1', [work.id]).catch(() => {});
  }

  const tier = getTier(work.vote_count || 0);
  res.json({
    ...work,
    tier,
    cagnotte_seuil : tier.seuil,
    cagnotte_eur   : parseFloat(((work.cagnotte_pepites || 0) * PEPITE_TO_EUR).toFixed(2)),
    cagnotte_pct   : Math.min(100, Math.round((work.cagnotte_pepites || 0) / tier.seuil * 100)),
  });
});

// ── PUT /api/works/:id ───────────────────────────────────────
// Mettre à jour une œuvre (auteur uniquement)
router.put('/:id',
  authenticate,
  [
    body('title').optional().trim().isLength({ min: 1, max: 255 }),
    body('description').optional().isLength({ max: 2000 }),
    body('genre').optional().isLength({ max: 100 }),
    body('tags').optional().isArray(),
    body('content_json').optional().isObject(),
    body('cover_url').optional().isURL(),
    body('language').optional().isLength({ min: 2, max: 5 }),
    body('is_adult_content').optional().isBoolean(),
    body('content_warnings').optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const work = await queryOne(
      'SELECT id, author_id, status, word_count FROM works WHERE id = $1',
      [req.params.id]
    );
    if (!work) return res.status(404).json({ error: 'Œuvre introuvable.' });
    if (work.author_id !== req.user.id) return res.status(403).json({ error: 'Accès interdit.' });

    const {
      title, description, genre, tags, content_json,
      cover_url, language, is_adult_content, content_warnings
    } = req.body;

    // Recalcul mot-count si contenu mis à jour
    let wordCount = work.word_count;
    let readingTime = null;
    if (content_json) {
      const text = JSON.stringify(content_json).replace(/<[^>]+>/g, ' ');
      wordCount = text.split(/\s+/).filter(Boolean).length;
      readingTime = Math.ceil(wordCount / 200); // ~200 mots/min
    }

    const updated = await queryOne(
      `UPDATE works SET
        title            = COALESCE($1, title),
        description      = COALESCE($2, description),
        genre            = COALESCE($3, genre),
        tags             = COALESCE($4, tags),
        content_json     = COALESCE($5, content_json),
        cover_url        = COALESCE($6, cover_url),
        language         = COALESCE($7, language),
        is_adult_content = COALESCE($8, is_adult_content),
        content_warnings = COALESCE($9, content_warnings),
        word_count       = COALESCE($10, word_count),
        reading_time_min = COALESCE($11, reading_time_min),
        updated_at       = NOW()
       WHERE id = $12
       RETURNING id, title, status, updated_at`,
      [
        title || null, description || null, genre || null,
        tags ? JSON.stringify(tags) : null,
        content_json ? JSON.stringify(content_json) : null,
        cover_url || null, language || null,
        is_adult_content ?? null,
        content_warnings ? JSON.stringify(content_warnings) : null,
        wordCount, readingTime,
        req.params.id
      ]
    );
    res.json(updated);
  }
);

// ── POST /api/works/:id/publish ──────────────────────────────
// Publier une œuvre (brouillon → publié)
router.post('/:id/publish', authenticate, async (req, res) => {
  const work = await queryOne(
    'SELECT id, author_id, status, title, word_count FROM works WHERE id = $1',
    [req.params.id]
  );
  if (!work) return res.status(404).json({ error: 'Œuvre introuvable.' });
  if (work.author_id !== req.user.id) return res.status(403).json({ error: 'Accès interdit.' });
  if (work.status === 'published') return res.status(400).json({ error: 'Déjà publiée.' });
  if ((work.word_count || 0) < 100) return res.status(400).json({ error: 'Trop court (minimum 100 mots).' });

  // Générer le watermark
  const watermarkId = `LBR-${req.user.id.slice(0, 8).toUpperCase()}-${Math.floor(Date.now()/1000)}`;

  const published = await queryOne(
    `UPDATE works SET status = 'published', published_at = NOW(),
     watermark_id = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, title, status, published_at, watermark_id`,
    [watermarkId, req.params.id]
  );

  // Récompense : +5 pépites à l'auteur
  await query(
    `UPDATE users SET
       pepites_balance = pepites_balance + 5,
       total_works     = total_works + 1,
       updated_at      = NOW()
     WHERE id = $1`,
    [req.user.id]
  );

  res.json({ ...published, reward_pepites: 5 });
});

// ── DELETE /api/works/:id ────────────────────────────────────
// Dépublier (archiver) une œuvre — jamais supprimée définitivement
router.delete('/:id', authenticate, async (req, res) => {
  const work = await queryOne(
    'SELECT id, author_id, status FROM works WHERE id = $1',
    [req.params.id]
  );
  if (!work) return res.status(404).json({ error: 'Œuvre introuvable.' });
  if (work.author_id !== req.user.id) return res.status(403).json({ error: 'Accès interdit.' });
  if (work.status === 'printed') return res.status(400).json({ error: 'Une œuvre éditée ne peut pas être archivée.' });

  await query(
    `UPDATE works SET status = 'archived', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ message: 'Œuvre archivée (non supprimée). L\'historique est conservé.' });
});

// ── GET /api/works/:id/cagnotte ──────────────────────────────
// État live de la cagnotte
router.get('/:id/cagnotte', async (req, res) => {
  const work = await queryOne(
    `SELECT id, title, cagnotte_pepites, cagnotte_donors, vote_count, is_printed
     FROM works WHERE id = $1 AND status = 'published'`,
    [req.params.id]
  );
  if (!work) return res.status(404).json({ error: 'Œuvre introuvable.' });

  const tier  = getTier(work.vote_count || 0);
  const pep   = work.cagnotte_pepites || 0;
  const seuil = tier.seuil;

  res.json({
    workId     : work.id,
    pepites    : pep,
    amountEur  : parseFloat((pep * PEPITE_TO_EUR).toFixed(2)),
    donors     : work.cagnotte_donors || 0,
    tier,
    seuil,
    seuilEur   : parseFloat((seuil * PEPITE_TO_EUR).toFixed(2)),
    pct        : Math.min(100, Math.round(pep / seuil * 100)),
    is_printed : work.is_printed,
  });
});

module.exports = router;
