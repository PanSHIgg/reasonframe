# Documentation

ReasonFrame 的文档按“先跑起来，再看边界，最后看实现”的顺序组织。

## 先读

| 文档 | 适合谁 | 内容 |
| --- | --- | --- |
| [../README.md](../README.md) | 所有人 | 项目概览、架构图、快速开始、API 和质量门 |
| [configuration.md](configuration.md) | 部署者 | 模型 provider/顺序、Agent 预算、TTS、渲染 |
| [workflow.md](workflow.md) | 使用/调试者 | 三阶段流水线、双审核循环、失败恢复 |

## 深入

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 系统边界、数据模型、状态机、API、部署与迁移 |
| [tts.md](tts.md) | Edge TTS、外部 TTS、整篇音频与词级对齐契约 |
| [../ai-service/docs/authoring.md](../ai-service/docs/authoring.md) | agent 可编辑源码、lesson/cue 契约 |
| [../ai-service/README.md](../ai-service/README.md) | AI gRPC 服务、spec/checkpoint、阶段行为 |
| [../backend/README.md](../backend/README.md) | Go 控制面命令、配置、API、队列 |
| [../deploy/README.md](../deploy/README.md) | Compose 服务、端口、镜像、运维命令 |

## 历史记录

| 文档 | 内容 |
| --- | --- |
| [implementation-notes.md](implementation-notes.md) | 首版实现中的质量问题与边界 |
| [progress-2026-10.md](progress-2026-10.md) | 2026-10 的开发进度、验证数据和未完成项 |

历史文档只用于追溯，不应作为当前接口的唯一依据；当前行为以代码、OpenAPI 和本索引中的主要文档为准。
