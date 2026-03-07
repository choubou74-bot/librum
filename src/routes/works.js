const express = require('express');
const router = express.Router();
const { body, param, query: qv, validationResult } = require('express-validator');
const { query, queryOne, queryMany, withTransaction } = require('../db');
const { authenticate, authenticateOptional, requireLevel } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// GET /api/works — Liste des oeuvres de l'auteur connecté
// ============================================================
router.get('/', authenticate, async (req, res) => {
  const works = await queryMany(
    `SELECT id, title, type, genre, status, word_count, avg_rating,
            vote_count, cagnotte_amount, cagnotte_threshold, is_printed,
            cover_url, published_at, created_at, updated_at
     FROM works WHERE author_id = $1
     ORDER BY updated_at DESC`,
    [req.user.id]
  );
  res.json(works);
});

// ============================================================
// POST /api/works — Créer une nouvelle oeuvre (brouillon)
// ============================================================
router.post('/',
  authenticate,
  requireLevel(1),
  [
    body('title').trim().isLength({ min: 1, max: 255 }).withMessage('Titre requis, max 255 caractères.'),
    body('type').isIn([
      'roman', 'nouvelle', 'poesie', 'essai',
      'scenario_film', 'scenario_serie', 'scenario_court',
      'bd', 'jeunesse', 'biographie', 'documentaire'
    ]).withMessage('Type invalide.'),
    body('language').optional().isLength({ min: 2, max: 5 })
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

// ============================================================
// GET /api/works/:id — Détail d'une oeuvre (auteur ou publiée)
// ============================================================
router.get('/:id',
  authenticateOptional,
  [param('id').isUUID()],
  async (req, res) => {
    const work = await queryOne(
      `SELECT w.*, u.pseudo AS author_pseudo, u.avatar_url AS author_avatar,
              u.reputation_score AS author_reputation, u.total_works AS author_total_works
       FROM works w
       JOIN users u ON w.author_id = u.id
       WHERE w.id = $1`,
      [req.params.id]
    );

    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });

    // Si brouillon ou bloqué, seul l'auteur peut voir
    if (work.status !== 'published' && (!req.user || req.user.id !== work.author_id)) {
      if (!req.user || req.user.mod_grade < 2) {
        return res.status(403).json({ error: 'Accès non autorisé.' });
      }
    }

    // Incrémenter les vues (non bloquant)
    if (work.status === 'published') {
      query('UPDATE works SET view_count = view_count + 1 WHERE id = $1', [work.id]);
    }

    // Vote de l'utilisateur courant si connecté
    let userVote = null;
    if (req.user) {
      userVote = await queryOne(
        'SELECT rating, comment FROM votes WHERE user_id = $1 AND work_id = $2',
        [req.user.id, work.id]
      );
    }

    res.json({ ...work, userVote });
  }
);

// ============================================================
// PUT /api/works/:id — Modifier une oeuvre
// ============================================================
router.put('/:id',
  authenticate,
  [param('id').isUUID()],
  async (req, res) => {
    const work = await queryOne(
      'SELECT id, author_id, status FROM works WHERE id = $1',
      [req.params.id]
    );

    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });
    if (work.author_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé.' });
    if (work.status === 'archived') return res.status(400).json({ error: 'Oeuvre archivée, non modifiable.' });

    const allowedFields = ['title', 'genre', 'description', 'tags', 'language', 'cover_url',
                           'content_json', 'content_warnings', 'is_adult_content'];
    const updates = {};
    allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Aucune modification fournie.' });
    }

    // Recalculer word_count si contenu mis à jour
    if (updates.content_json) {
      try {
        const content = typeof updates.content_json === 'string'
          ? JSON.parse(updates.content_json)
          : updates.content_json;

        const fullText = content.chapters
          ?.map(c => c.content || '')
          .join(' ') || '';
        updates.word_count = fullText.split(/\s+/).filter(Boolean).length;
        updates.estimated_pages = Math.ceil(updates.word_count / 250);
        updates.reading_time_min = Math.ceil(updates.word_count / 200);
      } catch (e) {}

      // Sauvegarder une version
      const current = await queryOne('SELECT content_json, word_count FROM works WHERE id = $1', [work.id]);
      if (current) {
        const lastVersion = await queryOne(
          'SELECT MAX(version_num) as max FROM work_versions WHERE work_id = $1',
          [work.id]
        );
        await query(
          'INSERT INTO work_versions (work_id, version_num, content_json, word_count) VALUES ($1, $2, $3, $4)',
          [work.id, (lastVersion?.max || 0) + 1, current.content_json, current.word_count]
        );

        // Garder seulement les 30 dernières versions
        await query(
          `DELETE FROM work_versions WHERE work_id = $1 AND version_num NOT IN (
            SELECT version_num FROM work_versions WHERE work_id = $1 ORDER BY version_num DESC LIMIT 30
          )`,
          [work.id]
        );
      }
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [work.id, ...Object.values(updates)];

    const updated = await queryOne(
      `UPDATE works SET ${setClauses}, updated_at = NOW() WHERE id = $1
       RETURNING id, title, type, status, word_count, updated_at`,
      values
    );

    res.json(updated);
  }
);

// ============================================================
// POST /api/works/:id/publish — Publier une oeuvre
// ============================================================
router.post('/:id/publish',
  authenticate,
  requireLevel(1),
  async (req, res) => {
    const work = await queryOne(
      'SELECT * FROM works WHERE id = $1 AND author_id = $2',
      [req.params.id, req.user.id]
    );

    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });
    if (work.status === 'published') return res.status(400).json({ error: 'Déjà publiée.' });
    if (work.status === 'blocked') return res.status(403).json({ error: 'Publication bloquée par la modération.' });

    // Vérifications minimales
    if (!work.word_count || work.word_count < 100) {
      return res.status(400).json({ error: 'Contenu insuffisant. Minimum 100 mots requis.' });
    }

    if (!work.description) {
      return res.status(400).json({ error: 'Description (4ème de couverture) requise.' });
    }

    // TODO: filtre IA anti-spam / plagiat
    // const aiScore = await runAiFilter(work);

    const watermarkId = `LBR-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const threshold = getThreshold(work.type);

    const published = await queryOne(
      `UPDATE works SET
         status = 'published',
         published_at = NOW(),
         watermark_id = $2,
         cagnotte_threshold = $3,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, status, published_at, watermark_id, cagnotte_threshold`,
      [work.id, watermarkId, threshold]
    );

    // Mettre à jour le compteur de l'auteur
    await query('UPDATE users SET total_works = total_works + 1 WHERE id = $1', [req.user.id]);

    res.json({ ...published, message: 'Oeuvre publiée avec succès !' });
  }
);

// Seuils d'impression par type
function getThreshold(type) {
  const thresholds = {
    roman: 50, nouvelle: 25, poesie: 20,
    essai: 30, scenario_film: 35, scenario_serie: 40,
    scenario_court: 15, bd: 30, jeunesse: 25,
    biographie: 35, documentaire: 30
  };
  return thresholds[type] || 35;
}

// ============================================================
// GET /api/works/:id/versions — Historique des versions
// ============================================================
router.get('/:id/versions', authenticate, async (req, res) => {
  const work = await queryOne('SELECT author_id FROM works WHERE id = $1', [req.params.id]);
  if (!work || work.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Accès non autorisé.' });
  }

  const versions = await queryMany(
    `SELECT version_num, word_count, saved_at
     FROM work_versions WHERE work_id = $1
     ORDER BY version_num DESC LIMIT 30`,
    [req.params.id]
  );

  res.json(versions);
});

// ============================================================
// GET /api/works/:id/versions/:num — Restaurer une version
// ============================================================
router.get('/:id/versions/:num', authenticate, async (req, res) => {
  const work = await queryOne('SELECT author_id FROM works WHERE id = $1', [req.params.id]);
  if (!work || work.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Accès non autorisé.' });
  }

  const version = await queryOne(
    'SELECT content_json, word_count, saved_at FROM work_versions WHERE work_id = $1 AND version_num = $2',
    [req.params.id, req.params.num]
  );

  if (!version) return res.status(404).json({ error: 'Version introuvable.' });
  res.json(version);
});

// ============================================================
// DELETE /api/works/:id — Supprimer un brouillon
// ============================================================
router.delete('/:id', authenticate, async (req, res) => {
  const work = await queryOne(
    'SELECT id, author_id, status FROM works WHERE id = $1',
    [req.params.id]
  );

  if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });
  if (work.author_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé.' });
  if (work.status === 'published') {
    return res.status(400).json({ error: 'Impossible de supprimer une oeuvre publiée. Archivez-la.' });
  }

  await query('DELETE FROM works WHERE id = $1', [work.id]);
  res.json({ message: 'Oeuvre supprimée.' });
});

module.exports = router;
