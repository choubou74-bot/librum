-- ============================================================
-- LIBRUM — Schéma de Base de Données v1.0
-- Du peuple, au peuple.
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Full-text search

-- ============================================================
-- ENUM TYPES
-- ============================================================
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned');
CREATE TYPE work_type AS ENUM (
  'roman', 'nouvelle', 'poesie', 'essai',
  'scenario_film', 'scenario_serie', 'scenario_court',
  'bd', 'jeunesse', 'biographie', 'documentaire'
);
CREATE TYPE work_status AS ENUM (
  'draft', 'published', 'under_review', 'blocked', 'archived'
);
CREATE TYPE mod_action_type AS ENUM (
  'warning', 'blur', 'block_temp', 'block_perm',
  'ban_temp', 'ban_perm', 'unban', 'restore'
);
CREATE TYPE sanction_type AS ENUM (
  'yellow_1', 'yellow_2', 'orange', 'red'
);
CREATE TYPE badge_type AS ENUM (
  'vip_bronze', 'vip_argent', 'vip_or',
  'sentinelle', 'gardien', 'moderateur', 'moderateur_senior', 'archonte',
  'premier_livre', 'gagnant_mensuel', 'livre_dor',
  'ami_librum', 'traducteur', 'veteran'
);
CREATE TYPE donation_status AS ENUM ('pending', 'confirmed', 'refunded', 'failed');

-- ============================================================
-- TABLE: users
-- ============================================================
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email               VARCHAR(255) UNIQUE NOT NULL,
  email_verified      BOOLEAN DEFAULT FALSE,
  phone               VARCHAR(30) UNIQUE,
  phone_verified      BOOLEAN DEFAULT FALSE,
  pseudo              VARCHAR(50) UNIQUE NOT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  avatar_url          VARCHAR(500),
  bio                 TEXT,
  website             VARCHAR(255),

  -- Niveaux & grades
  account_level       SMALLINT DEFAULT 1 CHECK (account_level BETWEEN 0 AND 6),
  mod_grade           SMALLINT DEFAULT 0 CHECK (mod_grade BETWEEN 0 AND 5),

  -- Réputation
  reputation_score    DECIMAL(3,2) DEFAULT 0.00,
  total_votes_cast    INTEGER DEFAULT 0,
  total_donations     DECIMAL(10,2) DEFAULT 0.00,
  total_works         INTEGER DEFAULT 0,

  -- Sanctions
  warnings_count      SMALLINT DEFAULT 0,
  current_sanction    sanction_type,
  suspension_until    TIMESTAMP,
  status              user_status DEFAULT 'active',
  ban_reason          TEXT,
  ban_at              TIMESTAMP,

  -- Activité
  votes_remaining     SMALLINT DEFAULT 5, -- reset mensuel
  last_vote_reset     DATE DEFAULT CURRENT_DATE,
  last_active         TIMESTAMP DEFAULT NOW(),
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW(),

  -- Sécurité
  email_verify_token  VARCHAR(255),
  phone_verify_code   VARCHAR(10),
  phone_verify_exp    TIMESTAMP,
  reset_token         VARCHAR(255),
  reset_token_exp     TIMESTAMP,
  login_attempts      SMALLINT DEFAULT 0,
  locked_until        TIMESTAMP,

  -- Préférences
  lang                VARCHAR(5) DEFAULT 'fr',
  dark_mode           BOOLEAN DEFAULT FALSE,
  notif_email         BOOLEAN DEFAULT TRUE,
  notif_push          BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_pseudo ON users(pseudo);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_mod_grade ON users(mod_grade);

-- ============================================================
-- TABLE: works (oeuvres)
-- ============================================================
CREATE TABLE works (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Métadonnées
  title               VARCHAR(255) NOT NULL,
  type                work_type NOT NULL,
  genre               VARCHAR(100),
  subgenre            VARCHAR(100),
  description         TEXT,
  tags                VARCHAR(50)[],
  language            VARCHAR(5) DEFAULT 'fr',
  cover_url           VARCHAR(500),

  -- Contenu
  content_json        JSONB, -- {chapters: [{id, title, content}]}
  word_count          INTEGER DEFAULT 0,
  estimated_pages     INTEGER DEFAULT 0,
  reading_time_min    INTEGER DEFAULT 0,

  -- Publication
  status              work_status DEFAULT 'draft',
  published_at        TIMESTAMP,
  watermark_id        VARCHAR(100) UNIQUE,

  -- Évaluation
  avg_rating          DECIMAL(3,2) DEFAULT 0.00,
  vote_count          INTEGER DEFAULT 0,
  view_count          INTEGER DEFAULT 0,

  -- Cagnotte
  cagnotte_pepites    BIGINT DEFAULT 0,
  -- seuil calculé dynamiquement via vote_count + LC.getTier()
  -- cagnotte_threshold supprimé v2 — seuil progressif
  cagnotte_pepites_cache BIGINT DEFAULT 0,
  cagnotte_donors     INTEGER DEFAULT 0,
  is_printed          BOOLEAN DEFAULT FALSE,
  printed_at          TIMESTAMP,
  print_order_id      VARCHAR(255),
  print_address_enc   TEXT, -- chiffré

  -- Modération
  ai_filter_score     DECIMAL(5,2),
  content_warnings    VARCHAR(50)[],
  is_adult_content    BOOLEAN DEFAULT FALSE,
  report_count        INTEGER DEFAULT 0,

  -- Traductions
  translations_json   JSONB, -- {en: {...}, ar: {...}, ...}

  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_works_author ON works(author_id);
CREATE INDEX idx_works_status ON works(status);
CREATE INDEX idx_works_type ON works(type);
CREATE INDEX idx_works_published ON works(published_at DESC);
CREATE INDEX idx_works_rating ON works(avg_rating DESC);
CREATE INDEX idx_works_cagnotte ON works(cagnotte_pepites DESC);
CREATE INDEX idx_works_title_trgm ON works USING GIN (title gin_trgm_ops);
CREATE INDEX idx_works_description_trgm ON works USING GIN (description gin_trgm_ops);

-- ============================================================
-- TABLE: work_versions (historique)
-- ============================================================
CREATE TABLE work_versions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_id     UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL,
  content_json JSONB,
  word_count  INTEGER,
  saved_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_work_versions ON work_versions(work_id, version_num DESC);

-- ============================================================
-- TABLE: votes
-- ============================================================
CREATE TABLE votes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id     UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  is_anonymous BOOLEAN DEFAULT FALSE,
  vote_weight DECIMAL(3,2) DEFAULT 1.00,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, work_id)
);
CREATE INDEX idx_votes_work ON votes(work_id);
CREATE INDEX idx_votes_user ON votes(user_id);

-- ============================================================
-- TABLE: donations
-- ============================================================
CREATE TABLE donations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  work_id             UUID NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  amount_eur          DECIMAL(10,2) NOT NULL CHECK (amount_eur >= 0.10),
  amount_pepites      BIGINT NOT NULL CHECK (amount_pepites >= 1),
  currency            VARCHAR(3) DEFAULT 'EUR',
  stripe_payment_id   VARCHAR(255) UNIQUE,
  stripe_client_secret VARCHAR(255),
  status              donation_status DEFAULT 'pending',
  confirmed_at        TIMESTAMP,
  refunded_at         TIMESTAMP,
  created_at          TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_donations_work ON donations(work_id);
CREATE INDEX idx_donations_user ON donations(user_id);
CREATE INDEX idx_donations_status ON donations(status);

-- ============================================================
-- TABLE: badges
-- ============================================================
CREATE TABLE badges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_type  badge_type NOT NULL,
  awarded_by  UUID REFERENCES users(id),
  awarded_at  TIMESTAMP DEFAULT NOW(),
  note        TEXT,
  UNIQUE (user_id, badge_type)
);
CREATE INDEX idx_badges_user ON badges(user_id);

-- ============================================================
-- TABLE: moderation_actions
-- ============================================================
CREATE TABLE moderation_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  moderator_id    UUID NOT NULL REFERENCES users(id),
  target_user_id  UUID REFERENCES users(id),
  target_work_id  UUID REFERENCES works(id),
  action_type     mod_action_type NOT NULL,
  reason          TEXT NOT NULL,
  duration_days   INTEGER,
  expires_at      TIMESTAMP,
  is_reversed     BOOLEAN DEFAULT FALSE,
  reversed_at     TIMESTAMP,
  reversed_by     UUID REFERENCES users(id),
  reverse_reason  TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_mod_actions_moderator ON moderation_actions(moderator_id);
CREATE INDEX idx_mod_actions_target_user ON moderation_actions(target_user_id);
CREATE INDEX idx_mod_actions_target_work ON moderation_actions(target_work_id);

-- ============================================================
-- TABLE: reports (signalements)
-- ============================================================
CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id   UUID NOT NULL REFERENCES users(id),
  work_id       UUID REFERENCES works(id),
  user_id       UUID REFERENCES users(id),
  comment_id    UUID,
  reason        VARCHAR(100) NOT NULL,
  description   TEXT,
  status        VARCHAR(20) DEFAULT 'pending', -- pending, reviewed, dismissed, actioned
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_work ON reports(work_id);

-- ============================================================
-- TABLE: mod_discussions (La Loge)
-- ============================================================
CREATE TABLE mod_discussions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_ref    VARCHAR(50) UNIQUE NOT NULL,
  work_id     UUID REFERENCES works(id),
  user_id     UUID REFERENCES users(id),
  report_id   UUID REFERENCES reports(id),
  title       TEXT NOT NULL,
  status      VARCHAR(20) DEFAULT 'open', -- open, resolved, escalated
  resolution  TEXT,
  opened_by   UUID NOT NULL REFERENCES users(id),
  closed_by   UUID REFERENCES users(id),
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE mod_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discussion_id   UUID NOT NULL REFERENCES mod_discussions(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLE: book_of_gold (Livre d'Or)
-- ============================================================
CREATE TABLE book_of_gold (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_id         UUID NOT NULL REFERENCES works(id),
  author_id       UUID NOT NULL REFERENCES users(id),
  year            SMALLINT NOT NULL,
  month           SMALLINT NOT NULL,
  category        work_type NOT NULL,
  final_rating    DECIMAL(3,2),
  vote_count      INTEGER,
  cagnotte_pepites BIGINT DEFAULT 0,
  tier_level      SMALLINT DEFAULT 1,
  tirage          INTEGER DEFAULT 300,
  cagnotte_total  DECIMAL(10,2), -- deprecated, gardé pour compat
  author_quote    TEXT,
  printed_at      TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (year, month, category)
);

-- ============================================================
-- TABLE: notifications
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(50) NOT NULL,
  title       VARCHAR(255),
  body        TEXT,
  payload     JSONB,
  read_at     TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at);

-- ============================================================
-- TABLE: follows (abonnements auteurs)
-- ============================================================
CREATE TABLE follows (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (follower_id, following_id)
);

-- ============================================================
-- TABLE: ip_blacklist
-- ============================================================
CREATE TABLE ip_blacklist (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ip_address  INET NOT NULL,
  reason      TEXT,
  expires_at  TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_ip_blacklist ON ip_blacklist(ip_address);

-- ============================================================
-- TABLE: audit_logs (immuable)
-- ============================================================
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  ip_address  INET,
  user_agent  TEXT,
  payload     JSONB,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ============================================================
-- VIEWS utiles
-- ============================================================

-- Vue catalogue public
CREATE VIEW v_catalog AS
SELECT
  w.id, w.title, w.type, w.genre, w.description, w.cover_url,
  w.language, w.word_count, w.avg_rating, w.vote_count,
  w.cagnotte_pepites, w.cagnotte_donors,
  w.is_printed, w.published_at, w.content_warnings, w.is_adult_content,
  w.tags, w.reading_time_min,
  u.pseudo AS author_pseudo, u.avatar_url AS author_avatar,
  u.reputation_score AS author_reputation
FROM works w
JOIN users u ON w.author_id = u.id
WHERE w.status = 'published'
ORDER BY w.published_at DESC;

-- Vue classement mensuel
CREATE VIEW v_monthly_ranking AS
SELECT
  w.type,
  w.id, w.title, w.author_id,
  u.pseudo AS author_pseudo,
  w.avg_rating, w.vote_count,
  w.cagnotte_pepites,
  RANK() OVER (PARTITION BY w.type ORDER BY w.avg_rating DESC, w.vote_count DESC) AS rank_in_category
FROM works w
JOIN users u ON w.author_id = u.id
WHERE w.status = 'published'
  AND w.published_at >= date_trunc('month', NOW());

-- ============================================================
-- FONCTIONS
-- ============================================================

-- Recalcule la moyenne des votes d'une oeuvre
CREATE OR REPLACE FUNCTION recalc_work_rating(work_uuid UUID)
RETURNS VOID AS $$
  UPDATE works
  SET
    avg_rating = (SELECT COALESCE(AVG(rating * vote_weight), 0) FROM votes WHERE work_id = work_uuid),
    vote_count = (SELECT COUNT(*) FROM votes WHERE work_id = work_uuid),
    updated_at = NOW()
  WHERE id = work_uuid;
$$ LANGUAGE SQL;

-- Trigger recalcul rating après vote
CREATE OR REPLACE FUNCTION trigger_recalc_rating()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_work_rating(COALESCE(NEW.work_id, OLD.work_id));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_vote_change
AFTER INSERT OR UPDATE OR DELETE ON votes
FOR EACH ROW EXECUTE FUNCTION trigger_recalc_rating();

-- Trigger mise à jour cagnotte après don confirmé
CREATE OR REPLACE FUNCTION trigger_update_cagnotte()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (OLD.status IS NULL OR OLD.status != 'confirmed') THEN
    UPDATE works
    SET
      cagnotte_pepites = cagnotte_pepites + (NEW.amount_pepites),
      cagnotte_donors = cagnotte_donors + 1,
      updated_at = NOW()
    WHERE id = NEW.work_id;
  END IF;
  IF NEW.status = 'refunded' AND OLD.status = 'confirmed' THEN
    UPDATE works
    SET
      cagnotte_pepites = GREATEST(0, cagnotte_pepites - NEW.amount_pepites),
      cagnotte_donors = GREATEST(0, cagnotte_donors - 1),
      updated_at = NOW()
    WHERE id = NEW.work_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_donation_status
AFTER INSERT OR UPDATE ON donations
FOR EACH ROW EXECUTE FUNCTION trigger_update_cagnotte();

-- Reset mensuel des votes
CREATE OR REPLACE FUNCTION reset_monthly_votes()
RETURNS VOID AS $$
  UPDATE users
  SET votes_remaining = 5, last_vote_reset = CURRENT_DATE
  WHERE last_vote_reset < date_trunc('month', CURRENT_DATE);
$$ LANGUAGE SQL;

-- ============================================================
-- TABLE: reading_progress (suivi lecture pour éligibilité vote)
-- ============================================================
CREATE TABLE IF NOT EXISTS reading_progress (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id      UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  progress_pct SMALLINT DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  last_seen_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, work_id)
);

-- ============================================================
-- TABLE: follows
-- ============================================================
CREATE TABLE IF NOT EXISTS follows (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (follower_id, following_id)
);

-- ============================================================
-- TABLE: pepites_log (historique gains/dépenses pépites)
-- ============================================================
CREATE TABLE IF NOT EXISTS pepites_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  reason     VARCHAR(100) NOT NULL,  -- 'publish','vote','receive_vote','referral','donation'
  ref_id     UUID,                   -- id de l'œuvre ou du don concerné
  created_at TIMESTAMP DEFAULT NOW()
);

-- Colonne pepites_balance si absente
ALTER TABLE users ADD COLUMN IF NOT EXISTS pepites_balance BIGINT DEFAULT 0;

-- UNIQUE sur work_id dans book_of_gold (une œuvre = une entrée)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_of_gold_work_unique') THEN
    ALTER TABLE book_of_gold ADD CONSTRAINT book_of_gold_work_unique UNIQUE (work_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower       ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following      ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_pepites_log_user       ON pepites_log(user_id);
