# AI 执行服务

`ai-service/` 是 ReasonFrame 自包含的 Node AI 执行面。它通过 gRPC server-streaming 接收 Go worker 的
`RunTask`，按阶段执行现有 `core/` 工作流，并向 MinIO/S3（或本地对象目录）同步检查点和产物。

设计来源：[docs/architecture.md](../docs/architecture.md) 第 6、8、10 节。服务只执行
`author`、`prepare`、`render`、`ingest_audio`，不承载 HTTP API、数据库状态机或队列。

## 构建与运行

```bash
cd ai-service
npm ci
npm run build                    # tsc -p tsconfig.json -> dist/
npm start                        # 读取 .env，监听 GRPC_LISTEN_ADDR（默认 127.0.0.1:50051）

npm run test:ai                  # gRPC/契约/本地存储/阶段测试
npm test                         # 核心 Pi、质量门与回归测试
```

服务启动后使用 `../proto/pipeline/v1/pipeline.proto` 动态加载契约，不需要生成 TypeScript 代码。

## gRPC 契约

`RunTask` 请求字段：

| 字段 | 说明 |
| --- | --- |
| `task_id`、`job_id` | 必需；`task_id` 同时用于取消和 scratch 目录 |
| `type` | `AUTHOR`、`PREPARE`、`RENDER`、`INGEST_AUDIO` |
| `attempt` | 用户可见重试次数；产物对象版本默认为 `attempt + 1` |
| `auto_repairs` | 视觉返修次数；大于 0 时 AUTHOR 强制重走答案作者/答案审核 |
| `spec_json` | UTF-8 JSON，见下节 |
| `checkpoint_json` | UTF-8 JSON；Go 原样保存并回传，见下节 |
| `trace_json` | W3C traceparent/tracestate，当前只解析，不改变执行 |
| `deadline_unix_ms` | 0 表示无外部 deadline；否则取它与阶段超时的较小值 |

流事件：

- `stage`：`{"stage":"answering|answer_reviewing|video_authoring|video_reviewing|verifying|synthesizing|aligning|building|checking|rendering|validating|uploading|completed|awaiting_audio|failed"}`。
- `progress`：`{"kind":"agent.tool|agent.request|agent.usage|tts.cache_hit|video.reused|...", ...}`。
- `artifact`：`{"artifact":{name,object_key,mime_type,size_bytes,sha256}}`。
- `usage`：provider/model/token/audio/render 汇总；最终 result 中也有同一份 usage。
- `result`：唯一的终态事件，包含 `TaskResult`。

`TaskResult.status` 取值：`completed`、`awaiting_audio`、`failed`、`retryable`。
只有 `verifyVideo`（或绑定完全匹配的已验证缓存）通过后，`video` artifact 才会出现。

`Cancel` 按 `task_id` 或 `job_id` 中止活跃任务；空请求不会取消全部任务。gRPC context 取消与
deadline 都会映射为 `AbortSignal`，并传递到 LLM 会话、TTS 子进程、Chromium 和 FFmpeg 进程组。

`Health` 返回模型/TTS 配置、ffmpeg、Chromium、对象存储（本地模式视为 ready）、活跃/最大任务数和
`AI_CAPABILITIES`。

## `spec_json` 形状

推荐由 Go 写入规范化输入，图片使用对象引用而不是 base64：

```json
{
  "schemaVersion": 1,
  "jobId": "uuid",
  "input": {
    "problem": "题目文本",
    "images": [
      {
        "mimeType": "image/png",
        "objectKey": "jobs/<job_id>/input/problem-1.png",
        "sha256": "<64 hex>",
        "sizeBytes": 123456
      }
    ],
    "scope": {"subject": "math", "grade": "高中", "topics": ["立体几何"], "allowedMethods": [], "forbiddenMethods": []},
    "supplements": "",
    "options": {"template": "auto", "fps": 24, "quality": "looks", "audio": "auto"}
  }
}
```

- `input` 通过 `shared/schema.ts` 的 `JobInputSchema`（去掉内联 `images`）校验，默认值一致。
- 图片引用支持 `objectKey`、`base64`、`path`（相对 `LOCAL_INPUT_DIR`）。未提供引用时默认读取
  `jobs/<job_id>/input/problem-<n>.<ext>`。
- 如果省略 `input`，服务尝试读取 `inputObjectKey` 或默认的
  `jobs/<job_id>/input/request.json`；该对象应包含同样的 canonical input。
- `INGEST_AUDIO` 额外支持：

```json
{
  "audio": {"objectKey": "jobs/<job_id>/input/audio.mp3", "sha256": "<64 hex>", "mimeType": "audio/mpeg"},
  "words": {"objectKey": "jobs/<job_id>/input/words.json", "sha256": "<64 hex>"}
}
```

`words` 也可以直接内联完整 `WordTableSchema` JSON。开发环境允许 `audio.base64` 和
`words.base64`（或内联词表）。

`artifactVersion` 可覆盖对象版本；未设置时为 `attempt + 1`。

## `checkpoint_json` 形状

服务输出 snake_case，Go 可原样保存。字段至少包含：

```json
{
  "schema_version": 1,
  "job_id": "uuid",
  "phase": "author|prepare|render|done",
  "phase_status": {
    "author": "completed",
    "prepare": "completed",
    "render": "pending",
    "ingest_audio": "completed"
  },
  "source_sha256": "<64 hex>",
  "script_sha256": "<64 hex>",
  "answer_sha256": "<64 hex>",
  "audio_sha256": "<64 hex>",
  "timeline_sha256": "<64 hex>",
  "video_sha256": "<64 hex>",
  "build_sha256": "<64 hex>",
  "image_sha256": ["<64 hex>"],
  "answer_review": {
    "object_key": "jobs/<job_id>/artifacts/1/answer_review",
    "sha256": "<64 hex>",
    "approved": true,
    "kind": "answer",
    "prompt_sha256": "<64 hex>",
    "answer_sha256": "<64 hex>",
    "script_sha256": "<64 hex>"
  },
  "video_review": {
    "object_key": "jobs/<job_id>/artifacts/1/video_review",
    "sha256": "<64 hex>",
    "approved": true,
    "kind": "video",
    "prompt_sha256": "<64 hex>",
    "source_sha256": "<64 hex>",
    "answer_sha256": "<64 hex>",
    "script_sha256": "<64 hex>"
  },
  "review": {
    "object_key": "jobs/<job_id>/artifacts/1/review",
    "sha256": "<64 hex>",
    "approved": true,
    "kind": "video",
    "prompt_sha256": "<64 hex>",
    "source_sha256": "<64 hex>"
  },
  "artifacts": [
    {
      "name": "timeline",
      "object_key": "jobs/<job_id>/artifacts/1/timeline",
      "work_key": "jobs/<job_id>/work/timeline.json",
      "mime_type": "application/json",
      "size_bytes": 12345,
      "sha256": "<64 hex>"
    }
  ],
  "auxiliary": [
    {"object_key": "jobs/<job_id>/work/reports/frames/native/at-1.25s.png", "path": "reports/frames/native/at-1.25s.png", "sha256": "<64 hex>", "size_bytes": 12345}
  ],
  "cache": {"tts_key": "cache/tts/<hash>", "render_key": "cache/render/<hash>"},
  "repair": {"requested": true, "failed_phase": "prepare", "reason": "VISUAL_CHECK_FAILED", "message": "..."},
  "error": {"code": "VISUAL_CHECK_FAILED", "message": "..."},
  "updated_at": "2026-10-22T00:00:00.000Z"
}
```

- `artifacts` 同时接受数组和 `{name: {...}}` 映射；也接受 camelCase 字段。
- `artifacts[].object_key` 是 Go 下载用的公开 artifact；`work_key` 是阶段恢复用的可覆盖工作副本。
- `timeline_sha256` 固定为 `sha256(JSON.stringify(timeline))`，与 `core/quality.ts` 的视频绑定一致。
- `build_sha256` 是 `render/index.html`、`render/index.motion.json` 与 `render/assets/**` 的内容摘要。
  RENDER 会重编译并复核该摘要，防止 prepare 检查过的清单与 render 实际构建不一致。
- AUTHOR 返回的 `source_sha256` 是已批准答案摘要（`answer_sha256`），`script_sha256` 是整篇旁白摘要；
  PREPARE 视频审核通过后把 `source_sha256` 更新为最终 `lesson.json + src/visual.js + src/style.css` 摘要。
- `repair` 由可返修错误（`VISUAL_CHECK_FAILED`、`HYPERFRAMES_CHECK_FAILED`、`VIDEO_QUALITY_GATE_FAILED`、
  `ANSWER_REVISION_REQUIRED`）设置；AUTHOR 在 `auto_repairs > 0` 或该标记存在时不会复用旧批准。
- 失败时服务尽力上传已有 checkpoint（含 `error`），不会掩盖原始错误。

## 阶段行为与幂等

**AUTHOR**

- 从对象存储恢复 `answer`/`answer_review`，校验 `answer_sha256`、讲稿摘要和答案审核提示词摘要。
  有效且非返修时直接返回 checkpoint，不调用模型。
- 否则运行 `PiEngine.answerAndReview`：答案作者会话在审核返修轮次之间保留；每轮答案审核都是新的
  Pi 会话，只读 `answer.json`、`request.json` 和答案检查报告。审核通过后上传 `answer`、
  `answer_review`、`answer_check`、`answer_math`、`narration` 和兼容的 `review` 别名。
- 答案变化会清理下游视频/音频状态；仅答案 claims/model 变化但旁白未变时保留音频并只让视频源码失效。
- `AUTHOR` 完成时还没有 `lesson.json`；这是预期行为，视频源码由 `PREPARE` 生成。

**PREPARE**

- 恢复已批准的 `answer`，校验 `answer_sha256`/`script_sha256`；复用摘要匹配的音频/时间线，避免重复 TTS。
- 音频已存在且摘要匹配时直接复用；`audio=provided` 或未配置 TTS 且无可用音频时返回
  `awaiting_audio`，不失败。音频准备好后才进入视频循环。
- 视频作者读取 `answer.json`，生成 `lesson.json`、`src/visual.js`、`src/style.css`；视频作者会话在
  视频审核返修轮次之间保留，视频审核者每轮使用全新只读 Pi 会话。视频作者不能改写已批准答案或旁白。
- 每轮视频作者结束后，服务按当前 lesson 重新对齐已有音频、编译、运行真实浏览器/HyperFrames 检查，
  再把实际预览帧和报告交给视频审核者。审核通过后上传 `lesson`、`visual_source`、`style_source`、
  `video_review`、兼容的 `review`、音频、时间线、检查报告和参考帧。
- 已批准的视频源码在重试时直接复用，不重新调用视频作者/审核者；视觉/HyperFrames 失败返回
  `repairable=true`，checkpoint 记录 `repair`。
- `PREPARE` 不发布或验证最终视频；最终渲染仍是 `RENDER`。

**RENDER**

- 恢复 prepare 产物，重新编译并核对 `build_sha256`。
- 先尝试已完成的 checkpoint 视频，再尝试 `cache/render/<key>.mp4` + `.quality.json`；
  只有 `validatedCandidate` 的源码/时间线/构建/视频/校验器绑定全部匹配时才复用。
- 否则渲染、转码、`verifyVideo`（规格、帧数、音轨、黑帧、SSIM），通过后写 `reports/quality.json`
  并最后发布 `video` artifact。
- 缓存视频只存验证后的文件；验证失败返回 `retryable=true` 且不发布视频。

**INGEST_AUDIO**

- 从 checkpoint 恢复已批准答案，下载/解码 MP3，校验词表、脚本摘要、时间顺序和 MP3 完整性。
- 通过 `saveAudio` 以答案旁白骨架写音频、词表、时间线和初步对齐报告；使下游 video/timeline 状态失效，
  并把 `prepare` 重新置为 `pending`。视频作者随后按最终 lesson 重新对齐，不会重新合成音频。

## 对象存储与工作区

配置了完整 `S3_*` 时使用 S3/MinIO（`forcePathStyle`，`x-amz-meta-sha256`），否则使用本地对象目录
`LOCAL_OBJECT_STORE`（默认 `.reasonframe/ai-objects`）。两者暴露相同接口，读取时复核 SHA-256。
`AI_OBJECT_STORE=local|s3` 可显式选择模式；只配置部分 S3 字段会启动失败。

```text
jobs/{job_id}/input/request.json
jobs/{job_id}/input/problem-1.png
jobs/{job_id}/work/answer.json
jobs/{job_id}/work/lesson.json
jobs/{job_id}/work/visual.js
jobs/{job_id}/work/style.css
jobs/{job_id}/work/narration.txt
jobs/{job_id}/work/words.json
jobs/{job_id}/work/timeline.json
jobs/{job_id}/work/narration.mp3
jobs/{job_id}/work/reports/*.json
jobs/{job_id}/work/checkpoint.json
jobs/{job_id}/work/checkpoints/{phase}.json
jobs/{job_id}/work/reports/frames/**
jobs/{job_id}/artifacts/{version}/{name}
cache/tts/{cache_key}.mp3
cache/tts/{cache_key}.words.json
cache/render/{cache_key}.mp4
cache/render/{cache_key}.quality.json
```

每个任务在 `SCRATCH_DIR/{job_id}/{task_id}/` 下使用独立工作区，目录布局保持 `core/*` 期望的
`lesson.json`、`src/`、`inputs/`、`render/`、`reports/`、`sessions/`。阶段结束（成功或失败）
默认清理 scratch；`AI_KEEP_SCRATCH=1` 保留用于调试。`MAX_SCRATCH_BYTES` 在阶段边界检查。

本地开发时可以直接把输入放进 `LOCAL_OBJECT_STORE/jobs/<job>/input/`，或使用
`image.base64`/`audio.base64`。产物和 checkpoint 都写在同一本地对象目录，便于检查。

## 环境变量

沿用现有 `LLM_*`、`TTS_*`、`REASONFRAME_*`、`HYPERFRAMES_*`，新增：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GRPC_LISTEN_ADDR` | `127.0.0.1:50051` | gRPC 监听地址 |
| `AI_CAPABILITIES` | 全部 | `author,prepare,render,ingest_audio` 子集 |
| `AI_MAX_TASKS` | `2` | 本进程活跃任务上限 |
| `SCRATCH_DIR` | `.reasonframe/ai-scratch` | 每任务 scratch 根目录 |
| `MAX_SCRATCH_BYTES` | `4000000000` | scratch 配额 |
| `AI_KEEP_SCRATCH` | `false` | 保留任务目录用于调试 |
| `LOCAL_OBJECT_STORE` | `.reasonframe/ai-objects` | 无 S3 时的对象根目录 |
| `LOCAL_INPUT_DIR` | `REASONFRAME_STATE_DIR` | `spec` 中本地 `path` 的根目录 |
| `AI_OBJECT_STORE` | 自动 | `local` 或 `s3` |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 无 | S3/MinIO 必填四项 |
| `S3_REGION` | `us-east-1` | S3 区域 |
| `S3_USE_SSL` | 由 endpoint 推断 | `true/false` |
| `TASK_TIMEOUT_AUTHOR_MS` | 1200000 | 作者阶段；Compose 示例覆盖为 21600000 |
| `TASK_TIMEOUT_PREPARE_MS` | 900000 | 准备阶段；Compose 示例覆盖为 21600000 |
| `TASK_TIMEOUT_RENDER_MS` | 2700000 | 渲染阶段；Compose 示例覆盖为 10800000 |
| `TASK_TIMEOUT_INGEST_AUDIO_MS` | 300000 | 音频导入 |
| `AI_INTERNAL_TOKEN` | 无 | 仅供后续鉴权扩展使用，当前不强制 |

## 当前边界与后续工作

- 未实现 gRPC metadata 中的 `AI_INTERNAL_TOKEN`/mTLS 校验；生产应通过网络策略或 mTLS 限制访问。
- `trace_json` 已解析但未接入 OpenTelemetry；日志目前为启动/关闭 JSON 行。
- 渲染缓存与 TTS 缓存已按架构键设计，但未做跨任务的容量淘汰；依赖 MinIO 生命周期策略。
- 未实现按任务实时进度百分比（只上报阶段和 agent 事件）；Go 可据此合并进度。
- 完整 RENDER 需要可用的 Chromium/FFmpeg/HyperFrames；无这些依赖时 Health 会返回对应 false，
  阶段失败会返回结构化错误而不是崩溃。
