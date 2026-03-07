const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { query, queryOne, queryMany, withTransaction } = require('../db');
const { authenticate, requireModGrade } = require('../middleware/auth');

// ============================================================
// POST /api/moderation/report — Signaler un contenu
// ============================================================
router.post('/report',
  authenticate,
  [
    body('reason').isIn([
      'spam', 'plagiat', 'contenu_illicite', 'harcèlement',
      'contenu_adulte_non_marqué', 'violence_excessive', 'autre'
    ]),
    body('description').optional().isLength({ max: 500 }),
    body('workId').optional().isUUID(),
    body('userId').optional().isUUID()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { workId, userId, reason, description } = req.body;
    if (!workId && !userId) return res.status(400).json({ error: 'workId ou userId requis.' });

    // Anti-abus : max 5 signalements par jour
    const todayReports = await queryOne(
      `SELECT COUNT(*) FROM reports WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '24h'`,
      [req.user.id]
    );
    if (parseInt(todayReports.count) >= 5) {
      return res.status(429).json({ error: 'Maximum 5 signalements par 24h.' });
    }

    const report = await queryOne(
      `INSERT INTO reports (reporter_id, work_id, user_id, reason, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [req.user.id, workId || null, userId || null, reason, description || null]
    );

    // Incrémenter le compteur de signalements de l'oeuvre
    if (workId) {
      await query('UPDATE works SET report_count = report_count + 1 WHERE id = $1', [workId]);

      // Auto-floutage si > 5 signalements non traités
      const work = await queryOne('SELECT report_count FROM works WHERE id = $1', [workId]);
      if (work.report_count >= 5) {
        await query(
          `UPDATE works SET status = 'under_review' WHERE id = $1 AND status = 'published'`,
          [workId]
        );
      }
    }

    res.status(201).json({ message: 'Signalement enregistré. Merci.', reportId: report.id });
  }
);

// ============================================================
// GET /api/moderation/queue — File de modération (M1+)
// ============================================================
router.get('/queue', authenticate, requireModGrade(1), async (req, res) => {
  const { status = 'pending', page = 1 } = req.query;
  const offset = (parseInt(page) - 1) * 20;

  const reports = await queryMany(
    `SELECT r.id, r.reason, r.description, r.created_at, r.status,
            rp.pseudo AS reporter_pseudo,
            w.id AS work_id, w.title AS work_title, w.status AS work_status,
            u.pseudo AS reported_user_pseudo
     FROM reports r
     JOIN users rp ON r.reporter_id = rp.id
     LEFT JOIN works w ON r.work_id = w.id
     LEFT JOIN users u ON r.user_id = u.id
     WHERE r.status = $1
     ORDER BY r.created_at ASC
     LIMIT 20 OFFSET $2`,
    [status, offset]
  );

  res.json(reports);
});

// ============================================================
// POST /api/moderation/blur/:workId — Flouter temporairement (M2+)
// ============================================================
router.post('/blur/:workId',
  authenticate,
  requireModGrade(2),
  [body('reason').notEmpty().isLength({ max: 500 })],
  async (req, res) => {
    const work = await queryOne(
      'SELECT id, status, title FROM works WHERE id = $1',
      [req.params.workId]
    );
    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });
    if (work.status !== 'published') return res.status(400).json({ error: 'Oeuvre non publiée.' });

    await query(
      `UPDATE works SET status = 'under_review', updated_at = NOW() WHERE id = $1`,
      [work.id]
    );

    await query(
      `INSERT INTO moderation_actions (moderator_id, target_work_id, action_type, reason, expires_at)
       VALUES ($1, $2, 'blur', $3, NOW() + INTERVAL '48 hours')`,
      [req.user.id, work.id, req.body.reason]
    );

    // Auto-restauration après 48h si pas d'action supplémentaire — à gérer via cron

    res.json({ message: `Oeuvre "${work.title}" floutée pour 48h.` });
  }
);

// ============================================================
// POST /api/moderation/block/:workId — Bloquer une publication (M3+)
// ============================================================
router.post('/block/:workId',
  authenticate,
  requireModGrade(3),
  [
    body('reason').notEmpty().isLength({ max: 500 }),
    body('temporary').optional().isBoolean(),
    body('days').optional().isInt({ min: 1, max: 90 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { reason, temporary = true, days = 7 } = req.body;

    const work = await queryOne('SELECT id, title, author_id FROM works WHERE id = $1', [req.params.workId]);
    if (!work) return res.status(404).json({ error: 'Oeuvre introuvable.' });

    await query(
      `UPDATE works SET status = 'blocked', updated_at = NOW() WHERE id = $1`,
      [work.id]
    );

    const expires = temporary ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
    const actionType = temporary ? 'block_temp' : 'block_perm';

    await query(
      `INSERT INTO moderation_actions (moderator_id, target_work_id, target_user_id, action_type, reason, duration_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, work.id, work.author_id, actionType, reason, temporary ? days : null, expires]
    );

    // Notifier l'auteur
    await query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'work_blocked', 'Publication bloquée', $2)`,
      [work.author_id, `Votre oeuvre "${work.title}" a été bloquée. Motif : ${reason}`]
    );

    res.json({ message: `Oeuvre bloquée${temporary ? ` pour ${days} jours` : ' définitivement'}.` });
  }
);

// ============================================================
// POST /api/moderation/ban/:userId — Bannir un utilisateur (M4+)
// ============================================================
router.post('/ban/:userId',
  authenticate,
  requireModGrade(4),
  [
    body('reason').notEmpty().isLength({ max: 500 }),
    body('permanent').optional().isBoolean(),
    body('days').optional().isInt({ min: 1, max: 365 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { reason, permanent = false, days = 30 } = req.body;

    // Seul l'admin peut bannir définitivement (M5 peut proposer, admin valide)
    if (permanent && req.user.mod_grade < 10) {
      return res.status(403).json({
        error: 'Bannissement définitif : proposition créée, validation admin requise.',
        isPending: true
      });
    }

    const targetUser = await queryOne(
      'SELECT id, pseudo, status, mod_grade FROM users WHERE id = $1',
      [req.params.userId]
    );

    if (!targetUser) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (targetUser.mod_grade >= req.user.mod_grade) {
      return res.status(403).json({ error: 'Vous ne pouvez pas sanctionner un utilisateur de grade supérieur ou égal.' });
    }

    const suspensionUntil = permanent ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await query(
      `UPDATE users SET
         status = $1,
         suspension_until = $2,
         ban_reason = $3,
         ban_at = NOW(),
         warnings_count = warnings_count + 1
       WHERE id = $4`,
      [permanent ? 'banned' : 'suspended', suspensionUntil, reason, targetUser.id]
    );

    await query(
      `INSERT INTO moderation_actions (moderator_id, target_user_id, action_type, reason, duration_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, targetUser.id,
       permanent ? 'ban_perm' : 'ban_temp',
       reason, permanent ? null : days, suspensionUntil]
    );

    res.json({
      message: `@${targetUser.pseudo} ${permanent ? 'banni définitivement' : `suspendu ${days} jours`}.`
    });
  }
);

// ============================================================
// GET /api/moderation/discussions — La Loge (M1+)
// ============================================================
router.get('/discussions', authenticate, requireModGrade(1), async (req, res) => {
  const discussions = await queryMany(
    `SELECT md.id, md.case_ref, md.title, md.status, md.created_at,
            w.title AS work_title, u.pseudo AS user_pseudo,
            op.pseudo AS opened_by_pseudo,
            (SELECT COUNT(*) FROM mod_messages WHERE discussion_id = md.id) AS message_count
     FROM mod_discussions md
     LEFT JOIN works w ON md.work_id = w.id
     LEFT JOIN users u ON md.user_id = u.id
     JOIN users op ON md.opened_by = op.id
     ORDER BY md.created_at DESC`,
    []
  );

  res.json(discussions);
});

// ============================================================
// POST /api/moderation/discussions — Créer une discussion (M1+)
// ============================================================
router.post('/discussions',
  authenticate,
  requireModGrade(1),
  [body('title').notEmpty(), body('workId').optional().isUUID(), body('userId').optional().isUUID()],
  async (req, res) => {
    const { title, workId, userId } = req.body;
    const caseRef = `CASE-${Date.now().toString(36).toUpperCase()}`;

    const discussion = await queryOne(
      `INSERT INTO mod_discussions (case_ref, work_id, user_id, title, opened_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [caseRef, workId || null, userId || null, title, req.user.id]
    );

    res.status(201).json(discussion);
  }
);

module.exports = router;
