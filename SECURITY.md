# Security Policy

## Supported versions

当前仅维护 `main` 分支。项目处于 alpha 阶段，不承诺旧版本的安全修复。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability**（Private vulnerability reporting）私下报告。不要在公开 issue、讨论区或 PR 中披露未修复漏洞、密钥或可复现的攻击细节。

报告时尽量包含：

- 受影响组件和版本/commit；
- 复现步骤或最小样例；
- 影响范围（密钥泄露、任意代码执行、跨任务数据访问、拒绝服务等）；
- 建议修复方向（如有）。

## 威胁模型

ReasonFrame 会执行模型生成的 JavaScript/CSS，并用 Chromium 截图/渲染。模型输出、上传图片/音频、TTS 文本和外部模型响应都应视为不可信输入。

高风险边界：

- **生成代码执行**：`ai-service` 在 Chromium 中加载任务生成的 `visual.js`/`style.css`；生产环境必须按不可信代码隔离。
- **密钥**：`LLM_API_KEY`、TTS key、S3/MinIO 凭据和 `STATIC_API_KEY` 只能通过环境变量或密钥管理注入，不能进入仓库、日志、事件或产物。
- **对象存储**：MinIO 默认只绑定回环地址；不要直接暴露 bucket，产物应通过 API 下载。
- **多租户**：当前是单账户/早期多账户骨架，不应直接作为公网多租户服务部署。
- **资源消耗**：模型、TTS、Chromium 和 FFmpeg 都可能被恶意输入拖垮；需要并发、CPU、内存、磁盘和出站网络限制。

## Hardening checklist

- 使用非 root 用户运行 AI 服务，限制 scratch/workspace 配额。
- 将 AI/render 服务放在独立网络，禁止访问云元数据和控制面网络。
- 设置 `STATIC_API_KEY`/内部 token，启用 TLS 和反向代理鉴权。
- 不要把 MinIO、PostgreSQL、Redis 端口暴露到公网。
- 定期轮换模型、TTS 和对象存储凭据。
- 对上传文件做大小/类型校验，对任务设置并发和速率限制。
- 在发布前检查日志、错误响应和 artifact 元数据是否包含敏感信息。
