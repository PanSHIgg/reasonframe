# Contributing

感谢参与 ReasonFrame。这个仓库同时包含 Go 控制面、Node AI 执行面和 Compose 部署，改动前请先确认影响范围。

## 开发环境

- Go 1.26（`backend/`）
- Node.js 24 + npm（`ai-service/`）
- Docker Engine + Compose v2.24+（完整链路）

```bash
make test
make build
make compose-config
```

`make test` 不需要外部 PostgreSQL、Redis、MinIO 或模型 key；`make infra-up` 才会启动完整栈。

## 提交前

1. Go 改动运行 `gofmt -w` 和 `go test ./...`。
2. AI 改动运行 `npm test`、`npm run test:ai`、`npm run build`。
3. Compose/环境变量改动运行 `make compose-config`。
4. 同步更新受影响的文档（README、`docs/`、`deploy/README.md` 或 `ai-service/README.md`）。
5. 确认没有提交 `.env`、API key、`workspaces/`、`.reasonframe/` 或生成视频。

## 提交规范

使用 Conventional Commits，例如：

```text
feat(backend): add job retry from prepare
fix(ai): keep approved narration immutable across video repairs
docs: clarify TTS import contract
chore: ignore local render artifacts
```

一个 commit 只做一件可解释的事。重构与行为变更尽量分开；生成物、格式化噪声和无关文件不要混入。

## Pull Request

- 说明问题、改动和验证命令。
- 涉及质量门、审核提示词、checkpoint 或 gRPC 契约时，说明兼容性和旧数据的影响。
- 涉及模型生成代码执行、Chromium、文件路径或密钥时，说明安全边界。
- UI/视频相关改动尽量附关键帧或成片片段；不要提交完整大视频。

## 代码约定

- 遵循现有模块边界：HTTP/状态机在 `backend/`，作者/审核/TTS/渲染在 `ai-service/`。
- 不要绕过独立审核或在失败时伪造批准；质量门变更需要同步更新测试。
- 不要新增未使用依赖；新增依赖需说明用途和许可证影响。
- 不在日志、错误消息或文档中输出密钥、完整请求头或用户上传内容。

## 安全

安全问题不要开公开 issue，请按 [SECURITY.md](SECURITY.md) 报告。
