# ReasonFrame deployment

Local PostgreSQL, Redis, MinIO, Go control plane, and the Node AI service.

## Prerequisites

- Docker Engine with Compose v2.24+ (`env_file.required` support).
- Go 1.26 for `make build-backend`; Node.js 24 for `make build-ai`.
- An LLM endpoint/model if you want jobs to run. The stack starts without one,
  but job creation or authoring will fail until `LLM_*` is configured.

## First start

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env: set LLM_API_KEY (and optional TTS/auth/budgets).
# Provider/model order and budgets come from deploy/llm_config.json, which is
# baked into the AI image at /app/deploy/llm_config.json. Set LLM_CONFIG_PATH
# to use another file; legacy LLM_ENDPOINT/URL/MODEL env values apply only when
# no config file is present. LLM_MODEL can override the primary model for
# debugging.
make infra-up
```

`make infra-up` copies the example environment if `deploy/.env` is missing and
then runs:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

The one-shot `migrate` service runs before the API and workers. The API waits
for MinIO, PostgreSQL, Redis, the AI gRPC health check, and successful
migrations.

Validate the Compose model without starting anything:

```bash
make compose-config
# or
docker compose -f deploy/compose.yaml --env-file deploy/.env.example config
```

## Services and ports

| Service | Host access | Notes |
| --- | --- | --- |
| `api` | `127.0.0.1:4310` | `/health` is unauthenticated; artifact downloads stream through the API |
| `postgres` | `127.0.0.1:5432` | `postgres:16-alpine`, persistent volume, `pg_isready` health check |
| `redis` | `127.0.0.1:6379` | `redis:7-alpine`, AOF `everysec`, persistent volume |
| `minio` | `127.0.0.1:9000` API, `127.0.0.1:9001` console | Development-only loopback mapping; not publicly exposed |
| `ai-service` | internal only, `ai-service:50051` | One container serves `author`, `prepare`, `render`, and `ingest_audio` |
| `worker` | none | Consumes `author,prepare` |
| `worker-render` | none | Consumes `render`; keep concurrency low |
| `reconciler` | none | Requeues stale work and marks expired leases; single instance via PG advisory lock |

All long-running services use `restart: unless-stopped`. MinIO is initialized by
`minio-init`, which creates `S3_BUCKET` (default `reasonframe`) and sets the
bucket policy to private. Clients should use the API download endpoint rather
than MinIO directly; `deploy/.env.example` leaves `S3_ACCESS_KEY` and
`S3_SECRET_KEY` empty so the Compose file falls back to the local MinIO root
credentials. Do not reuse those credentials outside local development.

## Migrations

Migrations run automatically on `make infra-up`. To run them explicitly:

```bash
make migrate
# or
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm migrate
```

The backend image stores SQL migrations at `/app/migrations` and also supports
binaries that embed them.

## Workers and queues

Default queues:

```text
worker          author,prepare
worker-render   render
```

Run an ad hoc worker with an explicit queue list (the image entrypoint is `rf`):

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps \
  worker worker --queues author,prepare

docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps \
  worker-render worker --queues render
```

Reconciler (single instance, advisory-locked by the backend):

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps \
  reconciler
```

Useful commands:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env ps
docker compose -f deploy/compose.yaml --env-file deploy/.env logs -f api worker
make infra-down     # keeps named volumes; add -v manually to wipe local data
```

## AI image and browser

`deploy/ai-service.Dockerfile` is built from the repository root and includes:

- Node.js 24 and the root `package-lock.json` dependencies.
- FFmpeg/ffprobe, Debian Chromium, and CJK/emoji fonts.
- A `/opt/venv` virtualenv with `requirements-tts.txt` (`edge-tts`).
- `deploy/llm_config.json` at `/app/deploy/llm_config.json` (provider/model order).
- Non-root user `rf` (uid/gid 10001) and an ephemeral `/scratch` directory.

The default browser path is `/usr/bin/chromium`
(`HYPERFRAMES_BROWSER_PATH`). If HyperFrames needs a different build, for
example `chrome-headless-shell`, mount or install it and override
`HYPERFRAMES_BROWSER_PATH` in `deploy/.env`. The AI service is stateless:
`/scratch` is container-local and is not mounted as a shared volume.

## Assumptions for backend and ai-service

The deployment files expect the concurrent implementation work to provide:

- `backend/cmd/rf` as the single Go binary (Go 1.26 module at `backend/go.mod`),
  with commands `api`, `worker --queues author,prepare`, `worker --queues
  render`, `reconciler`, and `migrate`. The image entrypoint is `/usr/local/bin/rf`.
- Backend migrations in `backend/migrations` (or embedded in the binary) and an
  API that honors `HOST=0.0.0.0`, `PORT=4310`, and `GET /health`.
- Backend environment names used by `deploy/.env.example`: `DATABASE_URL`,
  `REDIS_URL`, `S3_*`, `AI_*_ADDR`, `AUTH_MODE`, `STATIC_API_KEY`,
  `INTERNAL_TOKEN`, `PUBLIC_BASE_URL`, `WORKER_CONCURRENCY_*`,
  `RECONCILE_INTERVAL`, and the LLM settings used for `/health`.
- The AI service build context is the repository root. The image includes
  `ai-service/` and `proto/`; its entrypoint uses the `ai-service` `start`
  script and falls back to `ai-service/dist/src/index.js` or `tsx`. It must
  listen on `GRPC_LISTEN_ADDR` (default `0.0.0.0:50051`).
- AI configuration uses `S3_*`, `LLM_*`, `TTS_*`, `REASONFRAME_*`,
  `TASK_TIMEOUT_*_MS`, `MAX_SCRATCH_BYTES`, `AI_CAPABILITIES`, and
  `AI_INTERNAL_TOKEN` from the same environment file.
- Empty `STATIC_API_KEY` / `AI_INTERNAL_TOKEN` mean authentication is disabled;
  set them before exposing the stack beyond localhost.
