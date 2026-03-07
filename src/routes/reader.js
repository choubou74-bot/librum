// routes/reader.js
const express = require('express');
const router = express.Router();
const { queryOne } = require('../db');
const { authenticateOptional } = require('../middleware/auth');

// Contenu d'une oeuvre pour lecture
router.get('/:id', authenticateOptional, async (req, res) => {
  const work = await queryOne(
    `SELECT w.id, w.title, w.type, w.content_json, w.word_count,
            w.reading_time_min, w.cover_url, w.language,
            w.is_adult_content, w.content_warnings,
            u.pseudo AS author_pseudo
     FROM works w JOIN users u ON w.author_id = u.id
     WHERE w.id = $1 AND w.status = 'published'`,
    [req.params.id]
  );
  if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });
  if (work.is_adult_content && !req.query.confirmed) {
    return res.status(200).json({ requiresConfirmation: true, title: work.title });
  }
  res.json(work);
});

module.exports = router;
