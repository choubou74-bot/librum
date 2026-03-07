require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { createServer } = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

const app = express();
const httpServer = createServer(app);

// ============================================================
// SOCKET.IO — Cagnotte live
// ============================================================
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Stocker io pour l'utiliser dans les routes
app.set('io', io);

io.on('connection', (socket) => {
  console.log('Client connecté:', socket.id);

  // Rejoindre la room d'une oeuvre pour recevoir les updates cagnotte
  socket.on('join:work', (workId) => {
    socket.join(`work:${workId}`);
  });

  socket.on('leave:work', (workId) => {
    socket.leave(`work:${workId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
  });
});

// ============================================================
// MIDDLEWARES GLOBAUX
// ============================================================
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting global
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Réessayez dans quelques instants.' }
});
app.use(globalLimiter);

// Rate limiting strict pour auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' }
});

// ============================================================
// ROUTES
// ============================================================
const authRoutes       = require('./routes/auth');
const worksRoutes      = require('./routes/works');
const votesRoutes      = require('./routes/votes');
const donationsRoutes  = require('./routes/donations');
const usersRoutes      = require('./routes/users');
const moderationRoutes = require('./routes/moderation');
const catalogRoutes    = require('./routes/catalog');
const readerRoutes     = require('./routes/reader');
const bookOfGoldRoutes = require('./routes/bookOfGold');
const webhookRoutes    = require('./routes/webhooks');

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/works', worksRoutes);
app.use('/api/votes', votesRoutes);
app.use('/api/donations', donationsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/reader', readerRoutes);
app.use('/api/book-of-gold', bookOfGoldRoutes);
app.use('/api/webhooks', webhookRoutes);

// Healthcheck
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    platform: 'LIBRUM',
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// GESTION D'ERREURS
// ============================================================
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);

  // Erreur de validation
  if (err.type === 'validation') {
    return res.status(400).json({ error: err.message, details: err.details });
  }

  // Erreur d'authentification
  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  // Erreur base de données
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Cette valeur existe déjà.' });
  }

  // Erreur générique
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500
      ? 'Erreur interne. Notre équipe a été notifiée.'
      : err.message
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

// ============================================================
// DÉMARRAGE
// ============================================================
const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   LIBRUM API — v1.0.0               ║
  ║   Du peuple, au peuple.             ║
  ║   Port: ${PORT}                        ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}             ║
  ╚══════════════════════════════════════╝
  `);
});

module.exports = { app, io };
