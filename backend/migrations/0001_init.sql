CREATE TYPE job_status AS ENUM ('queued', 'running', 'awaiting_audio', 'completed', 'failed', 'cancelled');
CREATE TYPE job_phase AS ENUM ('author', 'prepare', 'render', 'done');
CREATE TYPE artifact_state AS ENUM ('pending', 'ready', 'rejected');

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  key_hash bytea NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_account_idx ON api_keys(account_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  status job_status NOT NULL DEFAULT 'queued',
  phase job_phase NOT NULL DEFAULT 'author',
  stage text NOT NULL DEFAULT 'queued',
  priority smallint NOT NULL DEFAULT 0,
  input jsonb NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  request_sha256 text,
  attempt int NOT NULL DEFAULT 0,
  auto_repairs int NOT NULL DEFAULT 0,
  max_auto_repairs int NOT NULL DEFAULT 1,
  source_sha256 text,
  script_sha256 text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  active_task_id text,
  lease_expires_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE UNIQUE INDEX jobs_idempotency_uq
  ON jobs(account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_account_created_idx ON jobs(account_id, created_at DESC, id);
CREATE INDEX jobs_status_updated_idx ON jobs(status, updated_at);
CREATE INDEX jobs_lease_idx ON jobs(lease_expires_at) WHERE status = 'running';

CREATE TABLE job_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  phase job_phase NOT NULL,
  task_id text NOT NULL,
  run_attempt int NOT NULL DEFAULT 0,
  worker_id text NOT NULL,
  status text NOT NULL,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (task_id, run_attempt)
);
CREATE INDEX job_runs_job_idx ON job_runs(job_id, started_at DESC);
CREATE INDEX job_runs_heartbeat_idx ON job_runs(status, heartbeat_at);

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  stage text,
  task_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events(job_id, id);
CREATE INDEX job_events_created_idx ON job_events(created_at);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name text NOT NULL,
  version int NOT NULL DEFAULT 1,
  object_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  state artifact_state NOT NULL DEFAULT 'ready',
  is_current boolean NOT NULL DEFAULT true,
  source_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, name, version)
);
CREATE UNIQUE INDEX artifacts_current_uq ON artifacts(job_id, name) WHERE is_current;
CREATE INDEX artifacts_job_idx ON artifacts(job_id, is_current, state);

CREATE TABLE uploads (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  state text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_account_idx ON uploads(account_id, created_at DESC);
CREATE INDEX uploads_expiry_idx ON uploads(expires_at);

CREATE TABLE usage_records (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  phase job_phase NOT NULL,
  provider text NOT NULL,
  model text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  audio_chars bigint NOT NULL DEFAULT 0,
  render_seconds numeric(12, 3) NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_job_idx ON usage_records(job_id, created_at);
