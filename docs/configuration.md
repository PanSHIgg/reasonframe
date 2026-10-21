# 模型与 Agent 配置

优先级为环境变量（包括 `.env`）> JSON 配置文件 > 内置默认值。配置在启动时读取，修改后重启服务。`GET /v1/config` 返回实际模型、Agent 和渲染预算，始终省略 API Key。

## 模型请求

| 环境变量 | JSON 字段 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `LLM_ENDPOINT` | `llm.endpoint` | 无 | `responses`、`completions` 或 `messages` |
| `LLM_URL` | `llm.url` | 无 | 基础 URL 或标准完整端点 |
| `LLM_API_KEY` | `llm.apiKey` | 无 | API Key |
| `LLM_MODEL` | `llm.model` | 无 | 模型名称 |
| `LLM_CONTEXT_WINDOW` | `llm.contextWindow` | 128000 | 模型上下文容量，8192～2000000 token |
| `LLM_MAX_TOKENS` | `llm.maxTokens` | 8192 | 每次请求的最大输出，1024～524288 token，必须小于上下文容量 |
| `LLM_REQUEST_TIMEOUT_MS` | `llm.requestTimeoutMs` | 120000 | SDK HTTP 请求超时，100～3600000 毫秒 |
| `LLM_MAX_ATTEMPTS` | `llm.maxAttempts` | 3 | 单次模型响应最多尝试次数，含第一次，1～10 |
| `LLM_RETRY_DELAY_MS` | `llm.retryDelayMs` | 1000 | 指数退避的初始等待，0～60000 毫秒 |
| `LLM_THINKING_LEVEL` | `llm.thinkingLevel` | off | `off/minimal/low/medium/high/xhigh` |
| `LLM_TEMPERATURE` | `llm.temperature` | 不传 | 留空沿用模型默认值；Messages 为 0～1，其他端点为 0～2 |

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

`TTS_PROVIDER=edge` 时不需要启动 4311 端口；作者 agent 的 `synthesize_narration` 工具和任务审核后的自动合成共用 `scripts/edge-tts-cli.py`。`TTS_PROVIDER=http` 时必须提供 `TTS_URL`，请求/返回契约见 [tts.md](tts.md)。两个 provider 都只发送完整讲稿一次，不接受分句或本地拼接。


OpenCode 端点自动携带理象自身的 User-Agent 和 `x-opencode-session`。会话 ID 与真实 Pi 会话一致，同一会话的工具循环与重试保持不变，作者和独立审核使用不同 ID，满足 Go 的路由要求。`npm run check:model` 使用实际配置测试现有样例的代码编辑、校验与结构化审核，报告和会话保存在 `.reasonframe/model-check-*/`；审核是否批准内容单独记录。

2026-10-20 的真实联调中，`minimax-m3.1-flash-free` 的一次几何审核输出了 8192 个思考 token 后被截断；临时提高到 32768 后完成了审核。当前本地 `.env` 已按 MiniMax M3.1 Flash 官方上限配置：

```dotenv
LLM_CONTEXT_WINDOW=1000000
LLM_MAX_TOKENS=524288
```

规格来源：[MiniMax 官方模型与上下文表](https://platform.minimax.io/docs/api-reference/text-anthropic-api#supported-models)和[官方 Chat Completions 参数](https://platform.minimax.io/docs/api-reference/text-chat-openai)。官方上下文精确值为 1,000,000 token；输出预算推荐 131,072，上限 524,288，包含思考 token。上下文由输入、会话历史和生成内容共用；最大输出是单次上限，不要求每次生成到这个长度。

`LLM_TEMPERATURE` 留空沿用官方固定值 1，`top_p` 沿用官方固定值 0.95，无需额外传参。M3.1 Flash 始终思考，不支持关闭，默认 `reasoning_effort=max`；当前 `LLM_THINKING_LEVEL=off` 使 Pi 不发送通用思考等级参数，由供应商使用默认深度，不代表关闭该模型的思考。

[OpenCode Go 的 models.dev 目录](https://models.dev/api.json)记录输出为 512,000，与 MiniMax 官方文档有差异。2026-10-20 使用当前 Go 端点及 `minimax-m3.1-flash-free`，携带 `max_tokens=524288` 的简短实测请求返回 HTTP 200 和 `OK`。此检查确认参数被接受，没有实际生成 512K 长输出或填满 1M 上下文。请求超时、重试和 Agent 预算仍采用项目设置，属于应用运行策略。

模型请求重试由 Pi 会话执行，供应商 SDK 内层自动重试为 0，避免两层重试相乘。只对 Pi 识别的暂时性错误重试，例如限流、服务端错误、网络故障和请求超时；鉴权失败不重试。等待按 `retryDelayMs × 2^(已重试次数-1)` 增长，取消任务可以打断等待。SSE 的 `agent.retry` 事件包含下一次尝试序号、最多尝试次数和等待时间。成功完成一个模型响应后，下一轮工具循环重新获得单响应的尝试预算。

## Agent 与画面返修

| 环境变量 | JSON 字段 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `REASONFRAME_AGENT_TIMEOUT_MS` | `agent.timeoutMs` | 600000 | 一次作者、审核及内容返修的总时限，1000～3600000 毫秒 |
| `REASONFRAME_AGENT_MAX_ATTEMPTS` | `agent.maxAttempts` | 3 | 内容生成、校验与审核最多轮数，含初次，1～10 |
| `REASONFRAME_AGENT_MAX_TOOL_CALLS` | `agent.maxToolCalls` | 80 | 每个独立会话的实际工具执行上限，1～1000 |
| `REASONFRAME_AGENT_MAX_TURNS` | `agent.maxTurns` | 40 | 每个独立会话的模型请求总上限，1～1000，包含重试 |
| `REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS` | `agent.visualMaxRepairAttempts` | 1 | 浏览器或 HyperFrames 检查失败后的额外自动返修次数，0～10 |

`LLM_MAX_ATTEMPTS=3` 代表一次响应最多请求 3 次；`REASONFRAME_AGENT_MAX_ATTEMPTS=3` 代表初次生成加最多 2 次内容返修。这两个参数分别应对网络问题和内容问题。

工具次数和模型轮数按会话累计，不在内容返修时重置。作者会话与每个独立审核会话分别计数；画面返修会启动新的一次作者与审核流程，并重新获得总时限。预算超限会终止当前任务，记录 `AGENT_TOOL_LIMIT`、`AGENT_TURN_LIMIT` 或 `AGENT_TIMEOUT`。工具预算在执行工具之前检查，超限的文件写入不会执行。

例如默认 3 次内容尝试、1 次画面返修，最多启动 2 次作者流程，每次至多 3 次独立审核；每个会话仍受模型轮数、工具次数及时间限制。这些是每个会话/阶段的上限，不是整项任务的 token 或金额总配额。自动上下文压缩保持关闭；需要更长任务时应选择更大上下文并调整输出和轮数预算。

## 其他运行预算

| 环境变量 | JSON 字段 | 默认值 |
| --- | --- | --- |
| `REASONFRAME_CONCURRENCY` | `server.concurrency` | 1，范围 1～8 |
| `REASONFRAME_RENDER_WORKERS` | `render.workers` | 2，范围 1～8 |
| `REASONFRAME_RENDER_BITRATE` | `render.bitrate` | 8M，固定视频码率，支持如 6M、8000k |
| `REASONFRAME_RENDER_TIMEOUT_MS` | `render.timeoutMs` | 1800000 毫秒，范围 1000～7200000 |

模型连接信息只影响 LLM；全文 TTS 仍为一次请求，不应用 LLM 的重试参数。所有数值在服务启动时校验，无效范围、非整数预算、未知 JSON 配置字段或输出上限不小于上下文容量都会拒绝启动。
