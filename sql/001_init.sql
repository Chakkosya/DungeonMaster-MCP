CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY, name text NOT NULL, key_hash text UNIQUE NOT NULL, prefix text NOT NULL,
  permissions text[] NOT NULL, enabled boolean NOT NULL DEFAULT true, revoked boolean NOT NULL DEFAULT false,
  expires_at timestamptz, last_used_at timestamptz, last_source text,
  use_count bigint NOT NULL DEFAULT 0, error_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_key_groups (
  key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, group_id text NOT NULL,
  PRIMARY KEY(key_id, group_id)
);
CREATE TABLE IF NOT EXISTS worlds (
  id uuid PRIMARY KEY, group_id text NOT NULL, name text NOT NULL, owner_id text NOT NULL,
  status text NOT NULL DEFAULT 'setup', settings jsonb NOT NULL DEFAULT '{}',
  state jsonb NOT NULL DEFAULT '{}', version bigint NOT NULL DEFAULT 0,
  important_actions integer NOT NULL DEFAULT 0, last_autosave_at timestamptz,
  autosave_requested boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  save_sequence integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worlds_group_idx ON worlds(group_id);
CREATE TABLE IF NOT EXISTS group_active_worlds (
  group_id text PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS members (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, user_id text NOT NULL,
  ready boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, role text NOT NULL DEFAULT 'player',
  preference jsonb NOT NULL DEFAULT '{}', joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(world_id,user_id)
);
CREATE TABLE IF NOT EXISTS characters (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id text NOT NULL, name text NOT NULL, sheet jsonb NOT NULL,
  UNIQUE(world_id,user_id), FOREIGN KEY(world_id,user_id) REFERENCES members(world_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS story (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  public jsonb NOT NULL DEFAULT '{}', private jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS npcs (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name text NOT NULL, visibility text NOT NULL CHECK(visibility IN ('public','private')),
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS quests (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name text NOT NULL, visibility text NOT NULL CHECK(visibility IN ('public','private')),
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id text NOT NULL, character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  message_id text NOT NULL, message_time timestamptz, text text NOT NULL, status text NOT NULL DEFAULT 'pending',
  resolution jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,message_id)
);
CREATE TABLE IF NOT EXISTS game_events (
  id bigserial PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_events_world_idx ON game_events(world_id,id);
CREATE TABLE IF NOT EXISTS dice_rolls (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  action_id uuid, character_id uuid, expression text NOT NULL, raw jsonb NOT NULL,
  modifier integer NOT NULL, total integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS combats (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  state jsonb NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS saves (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('auto','manual')), version bigint NOT NULL,
  name text NOT NULL, note text NOT NULL DEFAULT '', snapshot bytea NOT NULL,
  size_bytes integer NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,kind,version)
);
CREATE TABLE IF NOT EXISTS world_branches (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name text NOT NULL, snapshot bytea, size_bytes integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_branch_per_world ON world_branches(world_id) WHERE active;
CREATE SEQUENCE IF NOT EXISTS manual_save_version_seq;
CREATE TABLE IF NOT EXISTS server_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  world_quota_bytes bigint NOT NULL DEFAULT 209715200,
  server_quota_bytes bigint NOT NULL DEFAULT 2147483648,
  manual_save_limit integer NOT NULL DEFAULT 5,
  recycle_save_limit integer NOT NULL DEFAULT 10,
  recycle_quota_bytes bigint NOT NULL DEFAULT 104857600,
  backup_quota_bytes bigint NOT NULL DEFAULT 10737418240,
  daily_backup_retention integer NOT NULL DEFAULT 7,
  manual_backup_retention integer NOT NULL DEFAULT 10
);
INSERT INTO server_settings(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS saves_world_idx ON saves(world_id,kind,created_at);
CREATE TABLE IF NOT EXISTS idempotency (
  key text PRIMARY KEY, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS confirmations (
  token uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id text NOT NULL, kind text NOT NULL, target_id uuid,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS world_exports (
  id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  group_id text NOT NULL, owner_id text NOT NULL, data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS world_imports (
  id uuid PRIMARY KEY, group_id text NOT NULL, user_id text NOT NULL,
  expected_chunks integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS world_import_chunks (
  import_id uuid NOT NULL REFERENCES world_imports(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL, data bytea NOT NULL,
  PRIMARY KEY(import_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS backup_records (
  id uuid PRIMARY KEY, filename text UNIQUE NOT NULL, status text NOT NULL,
  size_bytes bigint, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE members ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS message_time timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS recycle_save_limit integer NOT NULL DEFAULT 10;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS recycle_quota_bytes bigint NOT NULL DEFAULT 104857600;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS backup_quota_bytes bigint NOT NULL DEFAULT 10737418240;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE backup_records ADD COLUMN IF NOT EXISTS error text;
DROP TABLE IF EXISTS world_join_requests;
