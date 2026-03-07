# LIBRUM — Du peuple, au peuple.

> Plateforme littéraire libre, gratuite et démocratique.  
> Zero commission. Zero gatekeeping. Forever free.

---

## Architecture

```
librum/
├── start.sh                    # Script de démarrage
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js            # Serveur Express + Socket.io
│       ├── db/
│       │   ├── schema.sql      # Schéma PostgreSQL complet (20 tables)
│       │   └── index.js        # Pool + helpers
│       ├── middleware/
│       │   └── auth.js         # JWT + niveaux + grades mod
│       └── routes/
│           ├── auth.js         # Register, login, 2FA
│           ├── works.js        # CRUD œuvres + versioning
│           ├── votes.js        # Système de votes
│           ├── donations.js    # Stripe + WebSocket live
│           ├── catalog.js      # Catalogue + recherche
│           ├── moderation.js   # Signalements + actions
│           ├── users.js        # Profils
│           ├── reader.js       # Contenu lecture
│           ├── bookOfGold.js   # Livre d'Or
│           └── webhooks.js     # Stripe webhooks
└── frontend/
    ├── index.html              # Landing page
    ├── auth.html               # Inscription / connexion
    ├── editor.html             # Éditeur complet + IA
    ├── catalog.html            # Catalogue filtrable
    ├── work.html               # Fiche œuvre + cagnotte live
    ├── reader.html             # Lecteur immersif
    ├── dashboard.html          # Dashboard auteur
    ├── moderation.html         # La Chambre (modérateurs)
    └── livredor.html           # Livre d'Or
```

---

## Démarrage rapide

```bash
# 1. Cloner et configurer
cp backend/.env.example backend/.env
# Éditez backend/.env avec vos valeurs

# 2. Démarrer
chmod +x start.sh
./start.sh

# 3. Avec données de démo
./start.sh --seed
```

---

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Backend | Node.js 18+ / Express |
| Base de données | PostgreSQL 14+ |
| Cache | Redis |
| Temps réel | Socket.io (cagnotte live) |
| Auth | JWT + Refresh Token + 2FA SMS |
| Paiements | Stripe |
| IA Co-auteur | Anthropic Claude API |
| PDF | PDFKit (watermark) |
| SMS | Twilio |
| Stockage | AWS S3 / Cloudflare R2 |
| Impression | TheBookEdition API / Lulu fallback |
| Hébergement cible | OVH VPS (RGPD/Europe) |

---

## Variables d'environnement requises

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/librum
REDIS_URL=redis://localhost:6379
JWT_SECRET=votre_secret_fort_64_chars
JWT_REFRESH_SECRET=autre_secret_fort
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
ANTHROPIC_API_KEY=sk-ant-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=librum-works
```

---

## Fonctionnalités implémentées

### Auth (Phase 0 ✅)
- [x] Inscription en 4 étapes (identité → email → téléphone → code SMS)
- [x] Brute-force protection (5 tentatives → blocage 15min)
- [x] JWT + refresh token rotation
- [x] Niveaux 0→6 + grades modérateurs M1→M5 + ADM
- [x] Double vérification obligatoire (email + téléphone)

### Éditeur (Phase 1 ✅)
- [x] Éditeur riche multi-chapitres
- [x] Mode Roman / Mode Scénario (Hollywood formatting)
- [x] Autosauvegarde toutes les 30s
- [x] Stats temps réel (mots / pages / temps lecture)
- [x] IA Co-auteur : corriger, reformuler, continuer, analyser, synopsis, débloquer
- [x] Détection d'inactivité → suggestion IA
- [x] Modal de publication avec validation

### Catalogue (Phase 1 ✅)
- [x] Filtres par type, tri, recherche full-text
- [x] Vue grille / liste
- [x] Barres de cagnotte animées
- [x] Section "proches de l'impression"
- [x] Pagination

### Œuvre (Phase 2 ✅)
- [x] Fiche complète avec extrait lisible
- [x] Cagnotte live via WebSocket
- [x] Système de votes avec notation 1-5★
- [x] Profil auteur + bouton suivre
- [x] Signalement
- [x] Horodatage watermark

### Lecteur (Phase 2 ✅)
- [x] Lecteur immersif plein écran
- [x] Barre de progression
- [x] Paramètres : taille, police, thème (jour/sépia/nuit), interligne
- [x] Table des matières
- [x] Marque-page
- [x] Prompt vote à 80% de lecture
- [x] Raccourcis clavier (←→ PageUp/Down)

### Dashboard (Phase 3 ✅)
- [x] Stats : lectures, note, cagnotte, abonnés
- [x] Graphique lectures 30 jours
- [x] Tableau des œuvres avec statuts
- [x] Activité récente en temps réel
- [x] Notifications
- [x] Gestion votes mensuels
- [x] Paramètres profil

### Modération (Phase 3 ✅)
- [x] Le Prétoire : file de signalements priorisés
- [x] Actions graduées : flouter (M2+), bloquer (M3+), bannir (M4+)
- [x] La Loge : messagerie privée modérateurs
- [x] Historique des décisions (auditées, contestables)
- [x] Système de cartons (Jaune→Orange→Rouge)
- [x] Charte du modérateur

### Livre d'Or (Phase 3 ✅)
- [x] Gagnants par catégorie et par mois
- [x] Filtre par année
- [x] Cartes winners avec cagnotte atteinte

---

## Feuille de route restante

### Phase 4 — Mobile (semaines 17-20)
- [ ] Flutter app (iOS + Android)
- [ ] Notifications push
- [ ] Mode hors ligne (PWA)
- [ ] Export FDX (Final Draft)
- [ ] Génération couverture (Claude + Imagen)
- [ ] Traduction 10 langues

### Phase 5 — Scale (semaines 21-26)
- [ ] CDN pour les PDFs (Cloudflare R2)
- [ ] Elasticsearch pour la recherche
- [ ] Intégration TheBookEdition API
- [ ] Intégration Lulu API (fallback)
- [ ] RGPD : export données, droit à l'oubli
- [ ] Tests E2E (Playwright)
- [ ] CI/CD (GitHub Actions → OVH)

---

## Modèle économique

| Source | Montant estimé |
|--------|---------------|
| Dons volontaires (2% des membres) | ~60€/mois |
| API IA premium (>100 req/mois) | ~40€/mois |
| Subventions culturelles (CNL, etc.) | ~100€/mois |
| **Total estimé** | **~200€/mois** |
| **Coût infrastructure OVH** | **75-120€/mois** |

---

## Propriété intellectuelle

Chaque œuvre publiée sur LIBRUM bénéficie de :
- Un horodatage immutable à la publication (preuve d'antériorité)
- Un watermark PDF : `LBR-[ID_AUTEUR]-[TIMESTAMP_UNIX]`
- Conservation de l'identité réelle (email + téléphone) pour réquisitions légales
- Aucune cession de droits — la plateforme est témoin, pas propriétaire

---

*LIBRUM v1.0 — Développé avec Claude (Anthropic)*  
*"Un livre est un rêve que vous tenez dans vos mains." — Neil Gaiman*
