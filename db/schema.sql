-- Curious Media / Lead Intelligence (PostgreSQL / Supabase Schema)
-- Holds the whole platform: watchlist, signals, leads, outreach, and user accounts.

-- ---------------------------------------------------------------------------
-- People on the team
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- What we watch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,               -- display name, e.g. "TATA.ev"
  keywords   JSONB NOT NULL DEFAULT '[]'::jsonb, -- JSON array of search variants
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sites (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,                      -- short label, e.g. "livemint"
  domain     TEXT NOT NULL UNIQUE,               -- e.g. "livemint.com"
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Topic keywords that an article must also mention (optional narrowing).
CREATE TABLE IF NOT EXISTS topics (
  id      SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL UNIQUE,
  active  BOOLEAN NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Leads: one row per company on the watchlist. Holds all outreach state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'new',
  -- new | working | contacted | replied | qualified | won | lost
  owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contact_name      TEXT,
  contact_role      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  last_contacted_at TIMESTAMPTZ,
  next_followup_at  TIMESTAMPTZ,
  last_signal_at    TIMESTAMPTZ,
  score             INTEGER NOT NULL DEFAULT 0,   -- highest recent signal score
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Signals: one row per article. URL is the dedupe key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  id             SERIAL PRIMARY KEY,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company        TEXT NOT NULL,
  title          TEXT,
  url            TEXT NOT NULL UNIQUE,
  author         TEXT,
  published      TIMESTAMPTZ,
  site           TEXT,
  section_title  TEXT,
  body           TEXT,
  summary        TEXT,
  why_it_matters TEXT,
  signal_type    TEXT NOT NULL DEFAULT 'other',
  score          INTEGER NOT NULL DEFAULT 40,
  enriched       BOOLEAN NOT NULL DEFAULT false,
  run_id         INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_lead    ON signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_type    ON signals(signal_type);

-- ---------------------------------------------------------------------------
-- Outreach log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,   -- note | email | call | linkedin | meeting | status | claim
  body       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_lead ON activity(lead_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Scrape run history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id           SERIAL PRIMARY KEY,
  trigger      TEXT NOT NULL DEFAULT 'manual',   -- manual | schedule | startup
  status       TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
  queries      INTEGER NOT NULL DEFAULT 0,
  fetched      INTEGER NOT NULL DEFAULT 0,
  new_signals  INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  message      TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
