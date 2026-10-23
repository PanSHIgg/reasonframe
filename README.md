# 理象 · ReasonFrame

输入数理化题目、学段与知识范围、补充要求，后台用 Pi 编辑讲解稿和 HyperFrames 源码，经过校验、独立审核、TTS、对齐、渲染和成片检查后生成视频。

当前仓库处于两套入口的切换期：

- `ai-service/` 是已迁移的 Node/TypeScript AI 执行面，包含原有 Pi、校验、TTS、渲染和样例测试。
- `backend/` 是新的 Go 控制面，负责 HTTP API、PostgreSQL、Redis/Asynq、MinIO 和 SSE。
- `deploy/` 提供本地 Compose 和镜像构建；旧的 Express 入口已移除。

目标架构、数据模型和迁移计划见 [docs/architecture.md](docs/architecture.md)。

## 仓库结构

```text
backend/       Go 控制面：api / worker / reconciler / migrate
ai-service/    Node AI 执行面：gRPC、Pi、TTS、编译、检查、样例与测试
deploy/        Compose、镜像、环境示例
proto/         Go 与 TypeScript 共用的 gRPC 契约
docs/          架构、工作流、配置、TTS、文档索引
workspaces/    本地运行产物，不提交
```

Node 工程配置、锁文件、`core/`、`shared/`、模板、提示词、脚本、测试和样例都在 `ai-service/` 内；根目录不再有 `package.json` 或 `server/`。

## 快速开始

### Docker Compose

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，至少填写 LLM_API_KEY；provider/model 顺序由
# deploy/llm_config.json 提供（镜像内为 /app/deploy/llm_config.json）。
make infra-up
```

API 默认监听 `http://127.0.0.1:4310`。`make infra-up` 会先运行迁移，再启动 PostgreSQL、Redis、MinIO、API、worker、render worker、reconciler 和 AI 服务。MinIO 只映射到本机回环地址，产物通过 Go API 下载。

```bash
curl -X POST http://127.0.0.1:4310/v1/jobs \
  -H 'Content-Type: application/json' \
  --data-binary @ai-service/examples/solid-geometry/request.json

curl http://127.0.0.1:4310/v1/jobs/JOB_ID
curl -N http://127.0.0.1:4310/v1/jobs/JOB_ID/events
```

### 本地运行 AI 服务

```bash
cd ai-service
npm ci
cp .env.example .env
# 编辑 ai-service/.env 中的 LLM_*；可选 TTS_*
npm run build
npm start
```

AI 服务通过 gRPC 接收 Go worker 的任务；单独启动时默认监听 `127.0.0.1:50051`。详细契约见 [ai-service/README.md](ai-service/README.md)。

### Go 控制面

```bash
cd backend
go test ./...
go run ./cmd/rf migrate
go run ./cmd/rf api
go run ./cmd/rf worker --queues author,prepare
go run ./cmd/rf worker --queues render
go run ./cmd/rf reconciler
```

环境变量和部署假设见 [backend/README.md](backend/README.md)。

## 常用命令

```bash
make test           # AI 核心测试、AI gRPC 测试、Go 测试
make build          # Go 二进制 + AI TypeScript
make compose-config # 校验 Compose
make infra-up       # 启动完整本地栈
make infra-down     # 停止容器（保留卷）
```

## 流水线

```text
POST /v1/jobs
  -> Go API 写入 PostgreSQL，入队 Asynq author
  -> Go worker 调用 AI gRPC RunTask
  -> author：作者 + 校验 + 独立审核 + 内容返修
  -> prepare：TTS 或等待音频、词级对齐、编译、浏览器/HyperFrames 检查
  -> render：渲染、转码、成片验证、发布视频
  -> Go 写入事件与产物元数据，SSE 从 PostgreSQL 重放
```

`prepare` 在未配置 TTS 或 `audio=provided` 时进入 `awaiting_audio`；上传完整 MP3 和词表后继续。视觉/HyperFrames 检查失败可在预算内回到作者返修；讲稿不变时复用已验证音频和视频缓存。

## 质量门

- 讲稿结构、公式、数值断言和独立审核。
- 全文词表覆盖、时间顺序、字幕对齐、高亮对象可见性和任意 seek 一致性。
- 真实浏览器布局、动画、过渡、HyperFrames 检查。
- 成片分辨率、帧率、音轨、完整解码、异常黑帧/静音和逐场景 SSIM。
- 源码、审核提示词、音频、时间线和视频摘要绑定；旧审核不会因源码改动继续有效。

数值检查和模型审核提供质量证据，不是数学形式化证明。当前已验证的题型和样例见 `ai-service/examples/`。

## 文档

- [docs/architecture.md](docs/architecture.md)：Go 控制面、AI 执行面、PG/Redis/MinIO、异步任务
- [docs/workflow.md](docs/workflow.md)：流水线与阶段
- [ai-service/docs/authoring.md](ai-service/docs/authoring.md)：agent 源码契约
- [docs/configuration.md](docs/configuration.md)：模型、Agent、TTS、渲染配置
- [docs/tts.md](docs/tts.md)：Edge TTS 与外部 TTS 契约
- [docs/README.md](docs/README.md)：文档索引

## 边界

- 当前是多实例控制面骨架，尚未完成真实模型成功样片、OTel/Prometheus、限流、多租户和对象保留策略。
- AI 服务会执行模型生成的 JavaScript/CSS 并启动 Chromium；生产环境必须按不可信代码隔离，限制网络、CPU、内存和临时磁盘。
- 旧的 Express HTTP 入口、`JobManager`/`JobStore` 和常驻 TTS server 已删除；生产编排以 Go 控制面和 `ai-service/src/tasks/` 为准，历史记录保留在 `docs/progress-2026-10.md`。
