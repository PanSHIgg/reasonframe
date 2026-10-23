# 模型与 Agent 配置

LLM 的 provider/model 顺序来自 `deploy/llm_config.json`（AI 镜像内为 `/app/deploy/llm_config.json`）。`ai-service` 默认读取自身根目录上一级的该文件；`LLM_CONFIG_PATH` 可覆盖（相对路径从 `ai-service` 根目录解析）。只有文件不存在时才使用旧式纯环境变量配置：环境变量 > `reasonframe.config.json` > 内置默认值。配置文件存在但无效时服务拒绝启动；显式设置 `LLM_CONFIG_PATH` 但文件不存在也拒绝启动。配置在启动时读取，修改后重启服务。AI 服务内部持有有序的 typed profile 列表；`GET /v1/config` 返回后端已知的主模型、Agent 和渲染预算，始终省略 API Key。

## LLM 配置文件

```json
{
  "providers": {
    "opencode": {
      "endpoint": "completions",
      "url": "https://opencode.ai/inference/go/openai/v1",
      "apiKeyEnv": "LLM_API_KEY"
    }
  },
  "models": [
    { "provider": "opencode", "model": "longcat-2.5-preview-free", "contextWindow": 1000000, "maxTokens": 131072, "thinkingLevel": "xhigh" },
    { "provider": "opencode", "model": "beam-free", "contextWindow": 1048576, "maxTokens": 131072, "thinkingLevel": "xhigh" },
    { "provider": "opencode", "model": "minimax-m3.1-flash", "contextWindow": 1000000, "maxTokens": 131072, "thinkingLevel": "xhigh" }
  ]
}
```

| 字段 | 必填 | 用途 |
| --- | --- | --- |
| `providers.<name>.endpoint` | 是 | `responses`、`completions` 或 `messages` |
| `providers.<name>.url` | 是 | 基础 URL 或标准完整端点，校验规则与旧式 `LLM_URL` 相同 |
| `providers.<name>.apiKeyEnv` | 否 | 提供密钥的环境变量名，默认 `LLM_API_KEY`；文件本身绝不能包含密钥 |
| `models[].provider` | 是 | 必须引用 `providers` 中的名称 |
| `models[].model` | 是 | 传给供应商的模型名称 |
| `models[].contextWindow` | 否 | 模型上下文容量，8192～2000000 token；省略时用 `reasonframe.config.json` 或默认值 |
| `models[].maxTokens` | 否 | 单次最大输出，1024～524288 token，必须小于该模型上下文容量 |
| `models[].thinkingLevel` | 否 | `off/minimal/low/medium/high/xhigh` |

优先级与回退规则：

1. `models` 数组顺序就是 profile 顺序，attempt 0 使用第一个，attempt 1 使用第二个，之后循环。只有下一次任务重试才会切换 profile；单次请求内部的 Pi/SDK 重试仍使用同一 profile，绝不在请求中途切换。
2. `providers[].apiKeyEnv` 指向的变量提供密钥。某个 provider 缺少密钥时其 model 不进入可用 profile；全部缺失时模型未配置，但服务仍可启动。
3. 文件存在时忽略 `LLM_ENDPOINT`、`LLM_URL`、`LLM_CONTEXT_WINDOW`、`LLM_MAX_TOKENS`、`LLM_THINKING_LEVEL`；这些变量只在文件不存在时构成旧式配置。`LLM_REQUEST_TIMEOUT_MS`、`LLM_MAX_ATTEMPTS`、`LLM_RETRY_DELAY_MS`、`LLM_TEMPERATURE` 是运行时策略，始终生效。
4. 可选 `LLM_MODEL` 仅用于调试：若与文件中的模型同名，会将该 profile 移到首位；否则替换主 profile 的模型名称并保留原 provider 与预算。

## 模型请求

| 环境变量 | JSON 字段 | 生效方式 | 默认值 | 用途 |
| --- | --- | --- | --- | --- |
| `LLM_CONFIG_PATH` | 无 | 文件路径 | `../deploy/llm_config.json` | 覆盖 LLM 配置文件位置 |
| `LLM_API_KEY` | 无 | 密钥 | 无 | 默认 provider 密钥；也可由 `apiKeyEnv` 指向其他变量 |
| `LLM_MODEL` | 无 | 调试覆盖 | 无 | 覆盖主模型 |
| `LLM_ENDPOINT` | `llm.endpoint` | 仅文件不存在 | 无 | `responses`、`completions` 或 `messages` |
| `LLM_URL` | `llm.url` | 仅文件不存在 | 无 | 基础 URL 或标准完整端点 |
| `LLM_CONTEXT_WINDOW` | `llm.contextWindow` | 仅文件不存在 | 128000 | 模型上下文容量，8192～2000000 token |
| `LLM_MAX_TOKENS` | `llm.maxTokens` | 仅文件不存在 | 8192 | 每次请求的最大输出，1024～524288 token，必须小于上下文容量 |
| `LLM_REQUEST_TIMEOUT_MS` | `llm.requestTimeoutMs` | 始终 | 120000 | SDK HTTP 请求超时，100～3600000 毫秒 |
| `LLM_MAX_ATTEMPTS` | `llm.maxAttempts` | 始终 | 3 | 单次模型响应最多尝试次数，含第一次，1～10 |
| `LLM_RETRY_DELAY_MS` | `llm.retryDelayMs` | 始终 | 1000 | 指数退避的初始等待，0～60000 毫秒 |
| `LLM_THINKING_LEVEL` | `llm.thinkingLevel` | 仅文件不存在 | off | `off/minimal/low/medium/high/xhigh` |
| `LLM_TEMPERATURE` | `llm.temperature` | 始终 | 不传 | 留空沿用模型默认值；Messages 为 0～1，其他端点为 0～2 |

上下文容量是模型实际限制的声明，不会扩大供应商的限制。最大输出会直接传入每次 API 请求，不只用于模型注册。思考等级通过 Pi 的对应协议适配器传递；必须选择模型支持的等级。思考 token 与输出 token 的具体计费、预算规则由供应商决定。并非所有模型支持 temperature，未设置时不发送该参数；Anthropic 启用思考时由 SDK 按协议处理 temperature。

请求超时交给各协议 SDK 执行；流式响应的超时细节遵循 SDK。完整作者与审核过程另外受 Agent 总时限约束。

## 配音

| 环境变量 | JSON 字段 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `TTS_PROVIDER` | `tts.provider` | 未设置 | `edge`：直接调用本地 Python edge-tts CLI，无常驻服务；`http`：使用 `TTS_URL` 适配器 |
| `TTS_VOICE` | `tts.voice` | `zh-CN-XiaoxiaoNeural` | Edge 声音名 |
| `TTS_PYTHON` | `tts.python` | `.venv/bin/python` | Edge provider 使用的 Python 解释器 |
| `TTS_URL` | `tts.url` | 无 | HTTP provider 的完整适配地址 |
| `TTS_API_KEY` | `tts.apiKey` | 无 | HTTP provider 的可选 Bearer key |

`TTS_PROVIDER=edge` 时不需要启动 4311 端口；答案审核通过后的 `PREPARE` 整篇合成和视频阶段的重对齐共用 `ai-service/scripts/edge-tts-cli.py`。`TTS_PROVIDER=http` 时必须提供 `TTS_URL`，请求/返回契约见 [tts.md](tts.md)。两个 provider 都只发送完整讲稿一次，不接受分句或本地拼接。


OpenCode 端点自动携带理象自身的 User-Agent 和 `x-opencode-session`。会话 ID 与真实 Pi 会话一致，同一会话的工具循环与重试保持不变，作者和独立审核使用不同 ID，满足 Go 的路由要求。`cd ai-service && npm run check:model` 使用实际配置测试现有样例的代码编辑、校验与结构化审核，报告和会话保存在 `.reasonframe/model-check-*/`；审核是否批准内容单独记录。

2026-10-20 的真实联调中，`minimax-m3.1-flash` 的一次几何审核输出了 8192 个思考 token 后被截断；临时提高到 32768 后完成了审核。`deploy/llm_config.json` 将 MiniMax 作为第三级保底 profile，当前配置为：

```json
{ "model": "minimax-m3.1-flash", "contextWindow": 1000000, "maxTokens": 131072, "thinkingLevel": "xhigh" }
```

规格来源：[MiniMax 官方模型与上下文表](https://platform.minimax.io/docs/api-reference/text-anthropic-api#supported-models)和[官方 Chat Completions 参数](https://platform.minimax.io/docs/api-reference/text-chat-openai)。官方上下文精确值为 1,000,000 token；输出预算推荐 131,072，上限 524,288，包含思考 token。上下文由输入、会话历史和生成内容共用；最大输出是单次上限，不要求每次生成到这个长度。

`LLM_TEMPERATURE` 留空沿用官方固定值 1，`top_p` 沿用官方固定值 0.95，无需额外传参。M3.1 Flash 始终思考，不支持关闭，默认 `reasoning_effort=max`；当前 profile 使用 `thinkingLevel=xhigh`，Pi 会发送通用思考等级参数，实际深度由供应商解释，不代表可以关闭该模型的思考。

[OpenCode Go 的 models.dev 目录](https://models.dev/api.json)记录输出为 512,000，与 MiniMax 官方文档有差异。2026-10-20 使用当前 Go 端点及 `minimax-m3.1-flash`，携带 `max_tokens=524288` 的简短实测请求返回 HTTP 200 和 `OK`。此检查确认参数被接受，没有实际生成 512K 长输出或填满 1M 上下文。请求超时、重试和 Agent 预算仍采用项目设置，属于应用运行策略。

模型请求重试由 Pi 会话执行，供应商 SDK 内层自动重试为 0，避免两层重试相乘。只对 Pi 识别的暂时性错误重试，例如限流、服务端错误、网络故障和请求超时；鉴权失败不重试。等待按 `retryDelayMs × 2^(已重试次数-1)` 增长，取消任务可以打断等待。SSE 的 `agent.retry` 事件包含下一次尝试序号、最多尝试次数和等待时间。成功完成一个模型响应后，下一轮工具循环重新获得单响应的尝试预算。多 profile 回退不改变上述单请求重试：同一 attempt 内始终使用同一 profile，只有后端发起下一次任务 attempt 时才按顺序切换。

## Agent 与画面返修

| 环境变量 | JSON 字段 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `REASONFRAME_AGENT_TIMEOUT_MS` | `agent.timeoutMs` | 3600000 | 一次答案/视频作者、审核及内容返修的总时限，1000～21600000 毫秒 |
| `REASONFRAME_AGENT_MAX_ATTEMPTS` | `agent.maxAttempts` | 3 | 内容生成、校验与审核最多轮数，含初次，1～10 |
| `REASONFRAME_AGENT_MAX_TOOL_CALLS` | `agent.maxToolCalls` | 80 | 每个独立会话的实际工具执行上限，1～1000 |
| `REASONFRAME_AGENT_MAX_TURNS` | `agent.maxTurns` | 40 | 每个独立会话的模型请求总上限，1～1000，包含重试；Compose 示例为 80 |
| `REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS` | `agent.visualMaxRepairAttempts` | 1 | 浏览器或 HyperFrames 检查失败后的额外自动返修次数，0～10 |

`LLM_MAX_ATTEMPTS=3` 代表一次响应最多请求 3 次；`REASONFRAME_AGENT_MAX_ATTEMPTS=3` 代表初次生成加最多 2 次内容返修。这两个参数分别应对网络问题和内容问题。

工具次数和模型轮数按会话累计，不在内容返修时重置。作者会话与每个独立审核会话分别计数；画面返修会启动新的一次作者与审核流程，并重新获得总时限。预算超限会终止当前任务，记录 `AGENT_TOOL_LIMIT`、`AGENT_TURN_LIMIT` 或 `AGENT_TIMEOUT`。工具预算在执行工具之前检查，超限的文件写入不会执行。

例如默认 3 次内容尝试、1 次画面返修，最多启动 2 次作者流程，每次至多 3 次独立审核；每个会话仍受模型轮数、工具次数及时间限制。这些是每个会话/阶段的上限，不是整项任务的 token 或金额总配额。自动上下文压缩保持关闭；需要更长任务时应选择更大上下文并调整输出和轮数预算。

## 其他运行预算

| 环境变量 | JSON 字段 | 默认值 |
| --- | --- | --- |
| `AI_MAX_TASKS` | AI 服务并发任务数 | 2，范围 1～64 |
| `REASONFRAME_RENDER_WORKERS` | `render.workers` | 2，范围 1～8 |
| `REASONFRAME_RENDER_BITRATE` | `render.bitrate` | 8M，固定视频码率，支持如 6M、8000k |
| `REASONFRAME_RENDER_TIMEOUT_MS` | `render.timeoutMs` | 1800000 毫秒，范围 1000～7200000 |
| `TASK_TIMEOUT_AUTHOR_MS` | AI author 阶段硬上限 | 1200000 毫秒（Compose 示例 21600000） |
| `TASK_TIMEOUT_PREPARE_MS` | AI prepare 阶段硬上限 | 900000 毫秒（Compose 示例 21600000） |
| `TASK_TIMEOUT_RENDER_MS` | AI render 阶段硬上限 | 2700000 毫秒（Compose 示例 10800000） |
| `TASK_TIMEOUT_INGEST_AUDIO_MS` | AI ingest 阶段硬上限 | 300000 毫秒 |

模型连接信息只影响 LLM；全文 TTS 仍为一次请求，不应用 LLM 的重试参数。所有数值在服务启动时校验，无效范围、非整数预算、未知 JSON 配置字段或输出上限不小于上下文容量都会拒绝启动。
