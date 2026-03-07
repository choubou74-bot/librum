const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query, queryOne, withTransaction } = require('../db');
const { generateAccessToken, generateRefreshToken, authenticate } = require('../middleware/auth');

// ============================================================
// HELPERS
// ============================================================
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateToken = () => crypto.randomBytes(32).toString('hex');

// Audit log
const audit = async (userId, action, entityType, entityId, req) => {
  await query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entityType, entityId,
     req.ip, req.headers['user-agent']]
  );
};

// ============================================================
// POST /api/auth/register — Étape 1 : email + password
// ============================================================
router.post('/register',
  [
    body('email').isEmail().normalizeEmail().withMessage('Email invalide.'),
    body('password')
      .isLength({ min: 8 }).withMessage('Mot de passe minimum 8 caractères.')
      .matches(/[A-Z]/).withMessage('Doit contenir une majuscule.')
      .matches(/[0-9]/).withMessage('Doit contenir un chiffre.'),
    body('pseudo')
      .trim()
      .isLength({ min: 3, max: 50 }).withMessage('Pseudo entre 3 et 50 caractères.')
      .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Pseudo : lettres, chiffres, _ et - uniquement.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, pseudo } = req.body;

    // Vérifier unicité email + pseudo
    const existing = await queryOne(
      'SELECT id FROM users WHERE email = $1 OR pseudo = $2',
      [email, pseudo]
    );
    if (existing) {
      return res.status(409).json({ error: 'Email ou pseudo déjà utilisé.' });
    }

    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const emailToken = generateToken();

    const user = await queryOne(
      `INSERT INTO users (email, pseudo, password_hash, email_verify_token, account_level)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING id, email, pseudo, account_level`,
      [email, pseudo, passwordHash, emailToken]
    );

    // TODO: envoyer email de vérification
    // await sendVerificationEmail(email, emailToken);

    await audit(user.id, 'user.register', 'user', user.id, req);

    res.status(201).json({
      message: 'Compte créé. Vérifiez votre email.',
      userId: user.id,
      step: 'email_verification'
    });
  }
);

// ============================================================
// POST /api/auth/verify-email
// ============================================================
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token manquant.' });

  const user = await queryOne(
    'SELECT id FROM users WHERE email_verify_token = $1',
    [token]
  );
  if (!user) return res.status(400).json({ error: 'Token invalide ou expiré.' });

  await query(
    'UPDATE users SET email_verified = TRUE, email_verify_token = NULL WHERE id = $1',
    [user.id]
  );

  await audit(user.id, 'user.email_verified', 'user', user.id, req);

  res.json({ message: 'Email vérifié. Ajoutez votre numéro de téléphone.', step: 'phone_required' });
});

// ============================================================
// POST /api/auth/send-phone-code — Envoyer code SMS
// ============================================================
router.post('/send-phone-code', authenticate, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis.' });

  // Vérifier unicité
  const existing = await queryOne(
    'SELECT id FROM users WHERE phone = $1 AND id != $2',
    [phone, req.user.id]
  );
  if (existing) return res.status(409).json({ error: 'Numéro déjà utilisé.' });

  const code = generateCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await query(
    'UPDATE users SET phone = $1, phone_verify_code = $2, phone_verify_exp = $3 WHERE id = $4',
    [phone, code, expires, req.user.id]
  );

  // TODO: envoyer SMS via Twilio
  // await sendSMS(phone, `Votre code LIBRUM : ${code}`);

  // En dev, on retourne le code
  const devCode = process.env.NODE_ENV === 'development' ? { dev_code: code } : {};

  res.json({ message: 'Code envoyé par SMS.', ...devCode });
});

// ============================================================
// POST /api/auth/verify-phone
// ============================================================
router.post('/verify-phone', authenticate, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code manquant.' });

  const user = await queryOne(
    'SELECT phone_verify_code, phone_verify_exp FROM users WHERE id = $1',
    [req.user.id]
  );

  if (!user.phone_verify_code || user.phone_verify_code !== code) {
    return res.status(400).json({ error: 'Code invalide.' });
  }

  if (new Date() > new Date(user.phone_verify_exp)) {
    return res.status(400).json({ error: 'Code expiré. Demandez-en un nouveau.' });
  }

  await query(
    'UPDATE users SET phone_verified = TRUE, phone_verify_code = NULL, phone_verify_exp = NULL WHERE id = $1',
    [req.user.id]
  );

  await audit(req.user.id, 'user.phone_verified', 'user', req.user.id, req);

  res.json({ message: 'Téléphone vérifié. Compte actif.', step: 'complete' });
});

// ============================================================
// POST /api/auth/login
// ============================================================
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    const user = await queryOne(
      `SELECT id, email, pseudo, password_hash, account_level, mod_grade,
              status, warnings_count, locked_until, login_attempts,
              email_verified, phone_verified
       FROM users WHERE email = $1`,
      [email]
    );

    // Compte inexistant — message générique (sécurité)
    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    // Compte verrouillé temporairement
    if (user.locked_until && new Date() < new Date(user.locked_until)) {
      const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({
        error: `Compte temporairement verrouillé. Réessayez dans ${remaining} min.`
      });
    }

    // Vérification mot de passe
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.login_attempts || 0) + 1;
      const updates = { login_attempts: attempts };

      // Verrouillage après 5 tentatives
      if (attempts >= 5) {
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000);
      }

      await query(
        'UPDATE users SET login_attempts = $1, locked_until = $2 WHERE id = $3',
        [updates.login_attempts, updates.locked_until || null, user.id]
      );

      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    // Statuts bloquants
    if (user.status === 'banned') {
      return res.status(403).json({ error: 'Compte banni définitivement.' });
    }

    // Réinitialiser les tentatives
    await query(
      'UPDATE users SET login_attempts = 0, locked_until = NULL, last_active = NOW() WHERE id = $1',
      [user.id]
    );

    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    await audit(user.id, 'user.login', 'user', user.id, req);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        pseudo: user.pseudo,
        email: user.email,
        accountLevel: user.account_level,
        modGrade: user.mod_grade,
        emailVerified: user.email_verified,
        phoneVerified: user.phone_verified
      }
    });
  }
);

// ============================================================
// POST /api/auth/refresh — Renouveler le token
// ============================================================
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token manquant.' });

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await queryOne(
      'SELECT id, status FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!user || user.status === 'banned') {
      return res.status(401).json({ error: 'Token invalide.' });
    }

    const accessToken = generateAccessToken(user.id);
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Refresh token invalide ou expiré.' });
  }
});

// ============================================================
// GET /api/auth/me — Profil courant
// ============================================================
router.get('/me', authenticate, async (req, res) => {
  const user = await queryOne(
    `SELECT id, pseudo, email, bio, avatar_url, website,
            account_level, mod_grade, reputation_score,
            total_votes_cast, total_donations, total_works,
            warnings_count, current_sanction, status,
            votes_remaining, lang, dark_mode,
            email_verified, phone_verified,
            created_at, last_active
     FROM users WHERE id = $1`,
    [req.user.id]
  );

  // Badges
  const badges = await query(
    'SELECT badge_type, awarded_at FROM badges WHERE user_id = $1 ORDER BY awarded_at DESC',
    [req.user.id]
  );

  res.json({ ...user, badges: badges.rows });
});

// ============================================================
// POST /api/auth/forgot-password
// ============================================================
router.post('/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const { email } = req.body;

    const user = await queryOne('SELECT id FROM users WHERE email = $1', [email]);

    // Toujours retourner OK (sécurité : ne pas révéler si l'email existe)
    if (user) {
      const token = generateToken();
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h

      await query(
        'UPDATE users SET reset_token = $1, reset_token_exp = $2 WHERE id = $3',
        [token, expires, user.id]
      );

      // TODO: await sendResetEmail(email, token);
    }

    res.json({ message: 'Si cet email existe, vous recevrez un lien de réinitialisation.' });
  }
);

// ============================================================
// POST /api/auth/reset-password
// ============================================================
router.post('/reset-password',
  [
    body('token').notEmpty(),
    body('password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/)
  ],
  async (req, res) => {
    const { token, password } = req.body;

    const user = await queryOne(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_exp > NOW()',
      [token]
    );

    if (!user) return res.status(400).json({ error: 'Token invalide ou expiré.' });

    const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    await query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_exp = NULL WHERE id = $2',
      [hash, user.id]
    );

    await audit(user.id, 'user.password_reset', 'user', user.id, req);

    res.json({ message: 'Mot de passe réinitialisé. Connectez-vous.' });
  }
);

module.exports = router;
