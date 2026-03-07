// routes/bookOfGold.js
const express = require('express');
const router = express.Router();
const { queryMany } = require('../db');

router.get('/', async (req, res) => {
  const { year } = req.query;
  const params = year ? [parseInt(year)] : [];
  const whereYear = year ? 'WHERE bg.year = $1' : '';

  const entries = await queryMany(
    `SELECT bg.id, bg.year, bg.month, bg.category,
            bg.final_rating, bg.vote_count, bg.cagnotte_total,
            bg.author_quote, bg.printed_at,
            w.title, w.cover_url, w.type,
            u.pseudo AS author_pseudo, u.avatar_url AS author_avatar
     FROM book_of_gold bg
     JOIN works w ON bg.work_id = w.id
     JOIN users u ON bg.author_id = u.id
     ${whereYear}
     ORDER BY bg.year DESC, bg.month DESC`,
    params
  );

  res.json(entries);
});

module.exports = router;
