const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');

// Middleware: vérifie le token JWT
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requis.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Vérifier que l'utilisateur existe et est actif
    const user = await queryOne(
      `SELECT id, pseudo, email, account_level, mod_grade, status, warnings_count
       FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable.' });
    }

    if (user.status === 'banned') {
      return res.status(403).json({ error: 'Compte banni définitivement.' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Compte suspendu temporairement.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expiré.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token invalide.' });
  }
};

// Middleware: optionnel (ne bloque pas si pas de token)
const authenticateOptional = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await queryOne(
      'SELECT id, pseudo, email, account_level, mod_grade, status FROM users WHERE id = $1',
      [decoded.userId]
    );
    req.user = user?.status === 'active' ? user : null;
    next();
  } catch {
    req.user = null;
    next();
  }
};

// Middleware: niveau de compte minimum requis
const requireLevel = (minLevel) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  if (req.user.account_level < minLevel) {
    return res.status(403).json({
      error: `Niveau de compte insuffisant. Niveau ${minLevel} requis.`
    });
  }
  next();
};

// Middleware: grade de modération minimum
const requireModGrade = (minGrade) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  if (req.user.mod_grade < minGrade) {
    return res.status(403).json({
      error: `Grade de modération insuffisant. Grade M${minGrade} requis.`
    });
  }
  next();
};

// Middleware: admin uniquement
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  if (req.user.account_level < 10) { // admin = level spécial
    return res.status(403).json({ error: 'Accès administrateur requis.' });
  }
  next();
};

// Helper: générer access token
const generateAccessToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

// Helper: générer refresh token
const generateRefreshToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
  });
};

module.exports = {
  authenticate,
  authenticateOptional,
  requireLevel,
  requireModGrade,
  requireAdmin,
  generateAccessToken,
  generateRefreshToken
};
