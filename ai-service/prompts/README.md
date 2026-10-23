# Agent 提示词

系统提示词不再写在 TypeScript 字符串里。每次任务按题目 `scope.subject` 自动组合：

```text
prompts/base/{answer-author|answer-reviewer|video-author|video-reviewer}.md
        +
prompts/subjects/{math|physics|chemistry}.md
```

最终系统提示词 = 基础角色提示词 + 分隔线 + 对应科目参考。

| 文件 | 作用 |
| --- | --- |
| `base/answer-author.md` | 答案作者的独立解题、answer.json、claims/数值断言、整篇讲稿和 TTS 可读性要求 |
| `base/answer-reviewer.md` | 答案审核者的独立解题、逐字文字审计、逻辑/易懂性和讲稿审核；只读工具 |
| `base/video-author.md` | 视频作者把已批准答案/旁白转成 lesson.json、visual.js、style.css；不能改写答案或旁白 |
| `base/video-reviewer.md` | 视频审核者核对答案忠实度、符号/高亮、真实预览帧、版式和浏览器检查；只读工具 |
| `subjects/math.md` | 数学的定义域、证明、几何、代数变形和反例检查 |
| `subjects/physics.md` | 物理的模型、受力/场图、方向、单位、守恒条件和极限检查 |
| `subjects/chemistry.md` | 化学的方程式配平、守恒、计量、条件、有效数字和机理检查 |

查看组合结果：

```bash
cat prompts/base/answer-author.md
cat prompts/base/video-reviewer.md
cat prompts/subjects/physics.md
```

加载逻辑在 `core/prompts.ts`，按 `role + subject` 缓存。修改提示词后重启服务即可生效；不需要改 `core/pi.ts`。

答案审核报告绑定 `answer_sha256`、`script_sha256` 和答案审核提示词摘要；视频审核报告绑定最终 `source_sha256`、`script_sha256`、`answer_sha256` 和视频审核提示词摘要。答案、旁白、画面源码或对应提示词变化后旧批准自动失效。
