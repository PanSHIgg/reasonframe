# ReasonFrame Go 控制面

这是 `docs/architecture.md` 中描述的控制面实现：HTTP API、PostgreSQL 事实源、Asynq
队列、MinIO 对象存储、AI gRPC 客户端、worker 和 reconciler。AI 工作流仍在
`ai-service/`（TypeScript）中执行；本目录不包含作者、审核、TTS、渲染或数学逻辑。

## 构建与测试

```bash
cd backend
gofmt -w .
go mod tidy
go build ./...
go test ./...
```

`go test` 只覆盖纯逻辑（配置、鉴权、状态机、输入/上传/词表校验、API 错误映射），
不需要 PostgreSQL、Redis、MinIO 或 AI 服务。

## 命令

单一二进制，通过子命令启动：

```bash
go run ./cmd/rf migrate
go run ./cmd/rf api
go run ./cmd/rf worker --queues author,prepare
go run ./cmd/rf worker --queues render
go run ./cmd/rf reconciler
```

- `migrate`：在 PostgreSQL advisory lock 下按文件名顺序执行 `migrations/*.sql`，
  记录到 `schema_migrations`，并确保 `default` 账户存在。
- `api`：HTTP API、SSE（PG 重放 + LISTEN/NOTIFY）、上传、下载、取消/重试。
- `worker --queues author,prepare`：按指定队列启动 Asynq server；`--queues render`
  可单独部署渲染 worker。并发由 `WORKER_CONCURRENCY_*` 控制。
- `reconciler`：持有 `pg_try_advisory_lock`，补偿丢失的 queued 任务，标记租约过期的
  running 任务为 `INTERRUPTED`，清理过期 upload 记录和对象。

## 配置

环境变量在启动时解析并校验。`api` 需要 PG/Redis/MinIO；`worker` 需要 PG/Redis 和三个
AI 地址；`reconciler` 需要 PG/Redis；`migrate` 只需要 PG。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL URL，必填 | 无 |
| `REDIS_URL` | Redis URL（Asynq、取消频道、就绪检查） | 无 |
| `S3_ENDPOINT` | MinIO host:port，可带 http(s):// | 无 |
| `S3_REGION` | S3 region | `us-east-1` |
| `S3_BUCKET` | 已存在的私有 bucket | 无 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 对象存储凭据 | 无 |
| `S3_USE_SSL` | 覆盖 endpoint scheme 推断 | 由 scheme 决定 |
| `AI_AUTHOR_ADDR` | author 阶段 gRPC `host:port` | 无 |
| `AI_PREPARE_ADDR` | prepare 阶段 gRPC 地址 | 无 |
| `AI_RENDER_ADDR` | render 阶段 gRPC 地址 | 无 |
| `AI_INGEST_ADDR` | ingest_audio gRPC 地址 | 等于 `AI_PREPARE_ADDR` |
| `AI_INTERNAL_TOKEN` / `INTERNAL_TOKEN` | 可选 gRPC `authorization: Bearer` | 空 |
| `AUTH_MODE` | `static` 或 `db` | `static` |
| `STATIC_API_KEY` | static 模式 Bearer key；留空表示不鉴权 | 空 |
| `PUBLIC_BASE_URL` | 对外基础 URL，仅用于脱敏配置展示 | 空 |
| `MAX_IMAGE_BYTES` | 单张图片上限 | `8388608` |
| `MAX_AUDIO_BYTES` | 整段 MP3 上限 | `44000000` |
| `ACCOUNT_MAX_ACTIVE_JOBS` | 每账户 running 上限 | `2` |
| `ACCOUNT_MAX_QUEUED_JOBS` | 每账户 queued 上限 | `10` |
| `WORKER_CONCURRENCY_AUTHOR` | author 并发 | `2` |
| `WORKER_CONCURRENCY_PREPARE` | prepare/ingest 并发 | `1` |
| `WORKER_CONCURRENCY_RENDER` | render 并发 | `1` |
| `RECONCILE_INTERVAL` | 补偿扫描间隔（Go duration 或秒） | `30s` |
| `SHUTDOWN_TIMEOUT` | 优雅退出等待 | `20s` |
| `HOST` / `PORT` / `API_ADDR` | 监听地址，默认 `127.0.0.1:4310` | `127.0.0.1:4310` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 接受并校验，当前为 no-op | 空 |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | `info` |

为了兼容现有 `/v1/config`，也读取 `LLM_*`、`TTS_*`、`REASONFRAME_*` 的公开字段；
`LLM_API_KEY` 永不返回，也不持久化。Go 不负责模型请求。

静态模式兼容现有行为：`STATIC_API_KEY` 为空时所有 `/v1` 请求放行；设置后按
`Authorization: Bearer <key>` 做 SHA-256 + constant-time 比较。静态模式使用
`default` 账户。数据库模式接受 `rf_live_<key_id>_<secret>`，按 `key_prefix` 查
`api_keys`，再用 Argon2id PHC 哈希校验。scopes 已读取但当前未做路由级强制。

## 数据库

`migrations/0001_init.sql` 创建 `accounts`、`api_keys`、`jobs`、`job_runs`、
`job_events`、`artifacts`、`uploads`、`usage_records`、枚举和索引。
`0002_default_account.sql` 写入固定 UUID 的 `default` 账户。

在架构文档 schema 基础上新增了 `jobs.checkpoint jsonb`：AI 的 checkpoint 必须持久化，
下一个阶段需要原样传回 `checkpoint_json`。其余表字段与索引遵循文档。

## API

保持现有 `/v1` 语义；完整契约在 `api/openapi.yaml`，运行时 `/openapi.json` 提供 JSON。
与现有 Express 服务一致，配置了鉴权时 `/openapi.json` 也需要 Bearer token；`/health`
与 `/health/ready` 公开。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活、`modelConfigured` |
| GET | `/health/ready` | PG、Redis、MinIO、所有已配置 AI 地址 |
| GET | `/openapi.json` | OpenAPI 3.1 |
| GET | `/v1/config` | 脱敏配置 |
| POST | `/v1/jobs` | 创建任务；`Idempotency-Key`、`images[].base64` 或 `uploadId`；202 + `Location` |
| GET | `/v1/jobs` | 默认最新 100 条，支持 `limit` 和 keyset `cursor` |
| GET | `/v1/jobs/{id}` | 状态、阶段、错误、当前 ready 产物 |
| POST | `/v1/jobs/{id}/cancel` | PG 置 cancelled、删除待执行 Asynq 任务、发布 Redis 取消信号 |
| POST | `/v1/jobs/{id}/retry` | failed/cancelled 重试，按已停阶段恢复 |
| POST | `/v1/jobs/{id}/audio` | base64 + words，或 `audioUploadId`/`wordsUploadId` |
| GET | `/v1/jobs/{id}/narration` | 从 MinIO 返回讲稿和 `scriptSha256` |
| GET | `/v1/jobs/{id}/events` | SSE；`Last-Event-ID` 或 `?after=`；15 秒心跳 |
| GET/HEAD | `/v1/jobs/{id}/artifacts/{name}` | Go 代理 MinIO，Range、Content-Disposition、nosniff |
| POST | `/v1/uploads` | multipart 或 raw body；`kind=image|audio|words`；返回 id/sha256 |

错误格式为 `{"error":{"code":"...","message":"..."}}`。映射保持现有约定：400/422
输入、401 未认证、403 越权、404 不存在、409 状态/幂等冲突、413 过大、429 配额、
503 依赖不可用、500 内部错误。

## 队列、状态与事件

- 任务类型与队列：`author -> author`，`prepare -> prepare`，`render -> render`，
  `ingest_audio -> prepare`。
- Asynq task ID 为 `{job_id}:{phase}:{attempt}:{auto_repairs}`，payload 只包含
  `job_id`、`phase`、`attempt`、`auto_repairs`、`traceparent`。
- 超时：默认 author 6h、prepare 6h、render 3h、ingest 10m，可用 `TASK_TIMEOUT_*_MS` 覆盖；基础设施错误交给 Asynq
  指数退避，领域失败 ack 后等待用户 retry。
- worker 先用 `UPDATE ... WHERE status/phase/version` CAS 领取任务，创建 `job_runs`，
  流式写 `job_events` 并在同一事务 `pg_notify('job_events', ...)`。阶段完成时在
  同一事务写 job 状态、checkpoint、artifacts、usage 和事件，提交后才投递下一阶段。
- 可返修视觉失败（`VISUAL_CHECK_FAILED`/`HYPERFRAMES_CHECK_FAILED` 且
  `auto_repairs < max_auto_repairs`）回到 author，写入 `repair.queued`。
- `VIDEO_CHECK_FAILED` 第一次 render 失败会重试同一阶段一次；再次失败则任务失败。
- prepare 返回 `awaiting_audio` 时释放 worker，上传音频后通过 `ingest_audio`
  校验，成功后重新投递 prepare。
- SSE 事件 ID 直接使用 `job_events.id`；LISTEN 断线重连后广播所有连接从 PG 补读。
- reconciler 每轮重新投递超过 60 秒没有 active task 的 queued 任务；租约过期的
  running 任务标记失败/`INTERRUPTED`，要求显式 retry。

## 已实现 / 未实现

已实现：

- 完整 migrations 与嵌入式迁移 runner、默认账户。
- pgx 事务 store：job CRUD、CAS 领取/推进、事件、artifacts 版本、uploads、runs、usage。
- API、SSE、上传、Range 下载、静态与数据库鉴权、账户隔离、幂等、配额计数。
- Asynq 三队列、确定性 task ID、取消频道、worker gRPC 流、重试分类、下一阶段投递。
- MinIO put/get/stat/remove、基于 PG 重放的 SSE listener、reconciler 单实例锁。
- OpenAPI 3.1 YAML、脱敏配置、健康检查、纯单元测试。

当前限制/未实现：

- 未实现 Redis 滑动窗口限流；创建任务只做账户 active/queued 计数配额。
- DB 模式的 scopes 已存储和解析，但未按路由强制；也没有 API Key 管理接口。
- OpenTelemetry 只解析配置，未接入 exporter；日志为 JSON stdout。
- 未实现 `rf migrate-fs`、任务软删除、90 天对象保留策略、预签名下载 `?redirect=1`。
- `ingest_audio` 的深层音频/词表覆盖校验由 AI 服务执行；Go 侧做 base64、大小、
  MP3 magic、词表 schema/scriptSha 绑定校验。
- 取消依赖 gRPC context 传播；未额外调用 `PipelineService.Cancel`（proto 已保留）。
- 未提供 Prometheus 指标、asynqmon 或 DLQ 自动处理。
- `/health/ready` 在未配置 AI 地址时会返回 503，这是部署配置问题而非进程故障。
- Go 不因 LLM 未配置而拒绝创建任务；模型配置和可用性由 AI 服务负责（`/health` 的
  `modelConfigured` 仅反映本进程可见的 `LLM_*`）。
- 已 attach 到任务的 upload 行不参与过期清理，避免删除 job 仍引用的对象；长期对象
  保留和删除策略（90 天）尚未实现。

## 假设

- MinIO bucket 已由部署创建；服务不会自动创建。
- AI 服务负责把产物上传到 result 中的 `object_key`，Go 只记录元数据并通过代理下载。
- author 成功的 checkpoint 必须包含合法的 `source_sha256` 和 `script_sha256`，否则任务
  以 `INVALID_AI_RESULT` 失败。prepare/render 的 checkpoint 字段按 proto 原样保存。
- 音频导入使用 checkpoint 内部标记 `audio_ingested`，reconciler 据此选择
  `ingest_audio` 或 `prepare`，不会把未校验的音频直接送进 prepare。
- `job_events` notification channel 固定为 `job_events`；payload 只含 `jobId` 和 event id。

## 示例

```bash
export DATABASE_URL='postgres://rf:rf@127.0.0.1:5432/reasonframe?sslmode=disable'
export REDIS_URL='redis://127.0.0.1:6379/0'
export S3_ENDPOINT='http://127.0.0.1:9000'
export S3_BUCKET='reasonframe'
export S3_ACCESS_KEY='minioadmin'
export S3_SECRET_KEY='minioadmin'
export AI_PREPARE_ADDR='127.0.0.1:50052'
export AI_AUTHOR_ADDR='127.0.0.1:50051'
export AI_RENDER_ADDR='127.0.0.1:50053'
export AUTH_MODE='static'
export STATIC_API_KEY='dev-secret'

go run ./cmd/rf migrate
go run ./cmd/rf api &
go run ./cmd/rf worker &
go run ./cmd/rf reconciler &

curl -sS -H 'Authorization: Bearer dev-secret' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"problem":"Prove that n a_n is arithmetic.","scope":{"subject":"math","grade":"Grade 12"}}' \
  http://127.0.0.1:4310/v1/jobs
```
