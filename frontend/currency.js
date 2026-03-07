/**
 * LIBRUM — Système monétaire & niveaux d'édition
 * ─────────────────────────────────────────────────
 * 🪙 Pépite  = 0,10€       (unité de base)
 * 🏅 Lingot  = 10 000🪙     = 1 000€
 *
 * Tirage progressif selon popularité de l'œuvre :
 *   Niveau 1 →  300 ex  · seuil  15 000🪙 =  1 500€
 *   Niveau 2 →  500 ex  · seuil  25 000🪙 =  2 500€
 *   Niveau 3 → 1 000 ex · seuil  35 000🪙 =  3 500€
 *   Niveau 4 → 2 000 ex · seuil  60 000🪙 =  6 000€
 *   Niveau 5 → 5 000 ex · seuil 120 000🪙 = 12 000€
 */

const LC = {

  // ── Constantes de base ────────────────────────────────
  PEPITE_TO_EUR      : 0.10,
  EUR_TO_PEPITE      : 10,
  PEPITES_PER_LINGOT : 10000,

  // ── Niveaux d'édition progressifs ────────────────────
  TIERS: [
    {
      level       : 1,
      label       : 'Auteur émergent',
      icon        : '🌱',
      votes_min   : 0,
      votes_max   : 199,
      tirage      : 300,
      cost_eur    : 1500,
      seuil_pepites: 15000,   // 1 lingot + 5 000🪙
      description : '300 exemplaires · Tirage découverte',
    },
    {
      level       : 2,
      label       : 'Auteur confirmé',
      icon        : '📖',
      votes_min   : 200,
      votes_max   : 499,
      tirage      : 500,
      cost_eur    : 2500,
      seuil_pepites: 25000,   // 2 lingots + 5 000🪙
      description : '500 exemplaires · Diffusion régionale',
    },
    {
      level       : 3,
      label       : 'Auteur reconnu',
      icon        : '⭐',
      votes_min   : 500,
      votes_max   : 999,
      tirage      : 1000,
      cost_eur    : 3500,
      seuil_pepites: 35000,   // 3 lingots + 5 000🪙
      description : '1 000 exemplaires · Distribution nationale',
    },
    {
      level       : 4,
      label       : 'Auteur populaire',
      icon        : '🔥',
      votes_min   : 1000,
      votes_max   : 1999,
      tirage      : 2000,
      cost_eur    : 6000,
      seuil_pepites: 60000,   // 6 lingots
      description : '2 000 exemplaires · FNAC, Amazon, librairies',
    },
    {
      level       : 5,
      label       : 'Phénomène communautaire',
      icon        : '🏆',
      votes_min   : 2000,
      votes_max   : Infinity,
      tirage      : 5000,
      cost_eur    : 12000,
      seuil_pepites: 120000,  // 12 lingots
      description : '5 000 exemplaires · Distribution nationale + export',
    },
  ],

  // ── Gains par activité ────────────────────────────────
  REWARDS: {
    publish       : 5,    // Publier une œuvre
    receive_vote  : 1,    // Recevoir un vote
    give_vote     : 1,    // Voter pour une œuvre
    referral      : 10,   // Parrainer un membre
    work_printed  : 50,   // Œuvre imprimée → Livre d'Or
    daily_login   : 1,    // Connexion quotidienne
    first_work    : 20,   // Première publication
  },

  // ── Résolution du niveau selon le nombre de votes ────
  getTier(vote_count) {
    return this.TIERS.find(t => vote_count >= t.votes_min && vote_count <= t.votes_max)
      || this.TIERS[0];
  },

  // ── Conversions ───────────────────────────────────────
  eurToPepites(eur)    { return Math.round(eur * this.EUR_TO_PEPITE); },
  pepitesToEur(p)      { return (p * this.PEPITE_TO_EUR).toFixed(2); },
  pepitesToLingots(p)  { return Math.floor(p / this.PEPITES_PER_LINGOT); },
  remainder(p)         { return p % this.PEPITES_PER_LINGOT; },
  progressPct(current, seuil) { return Math.min(100, Math.round(current / seuil * 100)); },

  // ── Formatage ─────────────────────────────────────────
  /**
   * Formate un montant en pépites
   * @param {number} pepites
   * @param {'auto'|'pepite'|'lingot'|'compact'} mode
   */
  format(pepites, mode = 'auto') {
    const l = this.pepitesToLingots(pepites);
    const r = this.remainder(pepites);

    if (mode === 'pepite' || pepites < 10000) {
      return `${pepites.toLocaleString('fr')} 🪙`;
    }
    if (mode === 'compact') {
      return r === 0 ? `${l} 🏅` : `${l} 🏅 ${r.toLocaleString('fr')} 🪙`;
    }
    if (mode === 'lingot' || r === 0) {
      return `${l} lingot${l > 1 ? 's' : ''} 🏅`;
    }
    // auto
    return r === 0
      ? `${l} lingot${l > 1 ? 's' : ''} 🏅`
      : `${l} lingot${l > 1 ? 's' : ''} 🏅 + ${r.toLocaleString('fr')} 🪙`;
  },

  /**
   * Formate le seuil d'une œuvre selon son niveau
   */
  formatSeuil(vote_count) {
    const tier = this.getTier(vote_count);
    return this.format(tier.seuil_pepites, 'auto');
  },

  /**
   * Icône selon le montant
   */
  icon(pepites) {
    if (pepites >= 100000) return '🏆';
    if (pepites >= 10000)  return '🏅';
    return '🪙';
  },
};

// Export Node.js + browser
if (typeof module !== 'undefined') module.exports = LC;
else window.LC = LC;
