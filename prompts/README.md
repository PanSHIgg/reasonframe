# Agent 提示词

作者和审核者的系统提示词不再写在 TypeScript 字符串里。每次任务按题目 `scope.subject` 自动组合：

```text
prompts/base/{author|reviewer}.md
        +
prompts/subjects/{math|physics|chemistry}.md
```

最终系统提示词 = 基础角色提示词 + 分隔线 + 对应科目参考。

| 文件 | 作用 |
| --- | --- |
| `base/author.md` | 作者的工具使用、讲稿结构、文字和画面基本要求 |
| `base/reviewer.md` | 审核者的独立解题、逐字文字审计、逻辑/易懂性/版式审核顺序 |
| `subjects/math.md` | 数学的定义域、证明、几何、代数变形和反例检查 |
| `subjects/physics.md` | 物理的模型、受力/场图、方向、单位、守恒条件和极限检查 |
| `subjects/chemistry.md` | 化学的方程式配平、守恒、计量、条件、有效数字和机理检查 |

查看组合结果：

```bash
cat prompts/base/author.md
cat prompts/subjects/physics.md
```

加载逻辑在 `core/prompts.ts`，按 `role + subject` 缓存。修改提示词后重启服务即可生效；不需要改 `core/pi.ts`。
