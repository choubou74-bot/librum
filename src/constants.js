// ══════════════════════════════════════════════════════════════
// LIBRUM — Constantes monétaires et niveaux d'édition
// Source unique de vérité (utilisé par donations, webhooks, bookOfGold)
// ══════════════════════════════════════════════════════════════

// Conversion pépites ↔ euros
const EUR_TO_PEPITE = 10;       // 1€ = 10 pépites
const PEPITE_TO_EUR = 0.10;     // 1 pépite = 0,10€
const MIN_PEPITES   = 1;        // minimum 1 pépite = 0,10€

// Niveaux progressifs d'édition (doit correspondre à currency.js frontend)
// 🌱 Niveau 1 → 🏆 Niveau 5
const TIERS = [
  { level: 1, votes_min: 0,    votes_max: 199,      seuil: 15000,  tirage: 300  },
  { level: 2, votes_min: 200,  votes_max: 499,      seuil: 25000,  tirage: 500  },
  { level: 3, votes_min: 500,  votes_max: 999,      seuil: 35000,  tirage: 1000 },
  { level: 4, votes_min: 1000, votes_max: 1999,     seuil: 60000,  tirage: 2000 },
  { level: 5, votes_min: 2000, votes_max: Infinity,  seuil: 120000, tirage: 5000 },
];

// Labels pour affichage
const TIER_LABELS = ['Émergent', 'Confirmé', 'Reconnu', 'Populaire', 'Phénomène'];

/**
 * Retourne le tier correspondant au nombre de votes
 * @param {number} voteCount - Nombre de votes de l'œuvre
 * @returns {Object} Tier object avec level, votes_min, votes_max, seuil, tirage
 */
function getTier(voteCount) {
  return TIERS.find(t => voteCount >= t.votes_min && voteCount <= t.votes_max) || TIERS[0];
}

/**
 * Retourne le label du tier
 * @param {number} level - Niveau du tier (1-5)
 * @returns {string} Label
 */
function getTierLabel(level) {
  return TIER_LABELS[level - 1] || '—';
}

module.exports = {
  EUR_TO_PEPITE,
  PEPITE_TO_EUR,
  MIN_PEPITES,
  TIERS,
  TIER_LABELS,
  getTier,
  getTierLabel,
};
