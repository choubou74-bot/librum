#!/bin/bash
# ============================================================
# LIBRUM — Script de démarrage complet
# ============================================================

set -e

GREEN='\033[0;32m'
GOLD='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${GOLD}  ██╗     ██╗██████╗ ██████╗ ██╗   ██╗███╗   ███╗${NC}"
echo -e "${GOLD}  ██║     ██║██╔══██╗██╔══██╗██║   ██║████╗ ████║${NC}"
echo -e "${GOLD}  ██║     ██║██████╔╝██████╔╝██║   ██║██╔████╔██║${NC}"
echo -e "${GOLD}  ██║     ██║██╔══██╗██╔══██╗██║   ██║██║╚██╔╝██║${NC}"
echo -e "${GOLD}  ███████╗██║██████╔╝██║  ██║╚██████╔╝██║ ╚═╝ ██║${NC}"
echo -e "${GOLD}  ╚══════╝╚═╝╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝${NC}"
echo ""
echo -e "${GOLD}  Du peuple, au peuple.${NC}"
echo ""

# ─── VÉRIFICATION DES DÉPENDANCES ───────────────────────────
echo -e "${GREEN}[1/5] Vérification des dépendances...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js non trouvé. Installez Node.js >= 18${NC}"; exit 1
fi

if ! command -v psql &> /dev/null; then
    echo -e "${RED}❌ PostgreSQL non trouvé. Installez PostgreSQL >= 14${NC}"; exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js >= 18 requis (actuel: $(node -v))${NC}"; exit 1
fi

echo "   ✓ Node.js $(node -v)"
echo "   ✓ PostgreSQL détecté"

# ─── INSTALLATION DES DÉPENDANCES NPM ──────────────────────
echo -e "${GREEN}[2/5] Installation des packages npm...${NC}"
cd "$(dirname "$0")/backend"

if [ ! -d "node_modules" ]; then
    npm install --silent
    echo "   ✓ Packages installés"
else
    echo "   ✓ node_modules déjà présent"
fi

# ─── CONFIGURATION ENVIRONNEMENT ────────────────────────────
echo -e "${GREEN}[3/5] Configuration de l'environnement...${NC}"

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "   ✓ .env créé depuis .env.example"
        echo ""
        echo -e "${GOLD}  ⚠️  IMPORTANT: Éditez backend/.env avec vos vraies valeurs :${NC}"
        echo "     - DATABASE_URL (PostgreSQL)"
        echo "     - JWT_SECRET (clé secrète forte)"
        echo "     - STRIPE_SECRET_KEY"
        echo "     - ANTHROPIC_API_KEY"
        echo "     - TWILIO_* (optionnel en dev)"
        echo ""
    else
        echo -e "${RED}❌ .env.example manquant${NC}"; exit 1
    fi
else
    echo "   ✓ .env existant"
fi

# ─── BASE DE DONNÉES ─────────────────────────────────────────
echo -e "${GREEN}[4/5] Initialisation de la base de données...${NC}"

source .env 2>/dev/null || true
DB_URL="${DATABASE_URL:-postgresql://librum_user:librum_pass@localhost:5432/librum}"

# Extraire les infos de connexion
DB_HOST=$(echo $DB_URL | sed 's/.*@\([^:]*\).*/\1/')
DB_PORT=$(echo $DB_URL | sed 's/.*:\([0-9]*\)\/.*/\1/')
DB_NAME=$(echo $DB_URL | sed 's/.*\/\(.*\)/\1/')
DB_USER=$(echo $DB_URL | sed 's/.*\/\/\([^:]*\).*/\1/')

# Créer la DB si elle n'existe pas
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "CREATE DATABASE $DB_NAME" 2>/dev/null || true

# Appliquer le schéma
if [ -f "src/db/schema.sql" ]; then
    psql "$DB_URL" -f src/db/schema.sql -q 2>/dev/null && echo "   ✓ Schéma appliqué" || echo "   ⚠ Schéma déjà appliqué ou erreur mineure"
fi

# Données de démo
if [ "$1" == "--seed" ]; then
    echo "   Injection des données de démo..."
    psql "$DB_URL" << 'SEED'
INSERT INTO users (pseudo, email, email_verified, phone, phone_verified, account_level, password_hash)
VALUES 
  ('ousmane_n', 'ousmane@demo.com', true, '+221700000001', true, 3, '$2b$12$demo_hash_placeholder'),
  ('nadia_m', 'nadia@demo.com', true, '+33600000002', true, 2, '$2b$12$demo_hash_placeholder'),
  ('farida_z', 'farida@demo.com', true, '+33600000003', true, 2, '$2b$12$demo_hash_placeholder')
ON CONFLICT (email) DO NOTHING;
SEED
    echo "   ✓ Données de démo injectées"
fi

# ─── DÉMARRAGE DU SERVEUR ────────────────────────────────────
echo -e "${GREEN}[5/5] Démarrage du serveur LIBRUM...${NC}"
echo ""
echo -e "${GOLD}  🚀 Backend  → http://localhost:3001${NC}"
echo -e "${GOLD}  📚 Frontend → Ouvrez frontend/index.html${NC}"
echo ""
echo -e "  Appuyez sur ${RED}Ctrl+C${NC} pour arrêter."
echo ""

# Lancer le serveur
NODE_ENV=${NODE_ENV:-development} node src/index.js
