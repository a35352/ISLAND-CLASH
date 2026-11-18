CREATE SCHEMA island_clash;
REVOKE ALL ON SCHEMA island_clash FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE island_clash.ic_users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL CHECK(username ~ '^[A-Za-z0-9_]{3,16}$'),
  username_key TEXT NOT NULL UNIQUE,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player','admin','owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_reserved CHECK (
    username_key = lower(username) AND (role = 'owner') = (username_key = 'britbox')
  )
);

CREATE TABLE island_clash.ic_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES island_clash.ic_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE island_clash.ic_inventory (
  user_id UUID NOT NULL REFERENCES island_clash.ic_users(id) ON DELETE CASCADE,
  asset TEXT NOT NULL CHECK(asset IN ('gold','tokens','pass_xp','pass_levels','island','skin','pet','trail')),
  item TEXT NOT NULL DEFAULT '',
  qty BIGINT NOT NULL DEFAULT 0 CHECK(qty BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(user_id,asset,item)
);

CREATE TABLE island_clash.ic_notices (
  id UUID PRIMARY KEY,
  author_id UUID REFERENCES island_clash.ic_users(id) ON DELETE SET NULL,
  message TEXT NOT NULL CHECK(char_length(message) BETWEEN 1 AND 400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE island_clash.ic_reports (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES island_clash.ic_users(id),
  kind TEXT NOT NULL CHECK(kind IN ('bug','contact','admin_application')),
  message TEXT NOT NULL CHECK(char_length(message) BETWEEN 1 AND 700),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE island_clash.ic_codes (
  code TEXT PRIMARY KEY CHECK(code ~ '^[A-Z0-9_-]{4,24}$'),
  asset TEXT NOT NULL CHECK(asset IN ('gold','tokens','pass_xp','pass_levels','island','skin','pet','trail')),
  item TEXT NOT NULL DEFAULT '',
  qty BIGINT NOT NULL CHECK(qty BETWEEN 1 AND 1000000),
  max_uses INT NOT NULL CHECK(max_uses BETWEEN 1 AND 10000),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES island_clash.ic_users(id),
  disabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE island_clash.ic_code_uses (
  code TEXT NOT NULL REFERENCES island_clash.ic_codes(code) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES island_clash.ic_users(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(code,user_id)
);

CREATE TABLE island_clash.ic_state (
  key TEXT PRIMARY KEY CHECK(key IN ('shutdown','event')),
  value JSONB NOT NULL CHECK(jsonb_typeof(value) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ic_sessions_user_idx ON island_clash.ic_sessions(user_id);
CREATE INDEX ic_sessions_expiry_idx ON island_clash.ic_sessions(expires_at);
CREATE INDEX ic_notices_author_idx ON island_clash.ic_notices(author_id);
CREATE INDEX ic_notices_recent_idx ON island_clash.ic_notices(created_at DESC);
CREATE INDEX ic_reports_user_idx ON island_clash.ic_reports(user_id);
CREATE INDEX ic_reports_recent_idx ON island_clash.ic_reports(created_at DESC);
CREATE INDEX ic_codes_creator_idx ON island_clash.ic_codes(created_by);
CREATE INDEX ic_code_uses_user_idx ON island_clash.ic_code_uses(user_id);

CREATE TABLE island_clash.ic_vault (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL CHECK(asset IN ('gold','tokens','skin','pet','trail')),
  item TEXT NOT NULL,
  qty BIGINT NOT NULL CHECK(qty BETWEEN 1 AND 1000000),
  expires_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  claimed_by UUID REFERENCES island_clash.ic_users(id)
);
CREATE UNIQUE INDEX ic_vault_active_idx ON island_clash.ic_vault ((true)) WHERE closed_at IS NULL;
CREATE INDEX ic_vault_claimed_idx ON island_clash.ic_vault(claimed_by);

CREATE TABLE island_clash.ic_admin_invitations (
  user_id UUID PRIMARY KEY REFERENCES island_clash.ic_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE island_clash.ic_solo_saves (
  user_id UUID PRIMARY KEY REFERENCES island_clash.ic_users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  data JSONB NOT NULL CHECK(jsonb_typeof(data) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON ALL TABLES IN SCHEMA island_clash FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA island_clash FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE island_clash.ic_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_code_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_admin_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE island_clash.ic_solo_saves ENABLE ROW LEVEL SECURITY;
