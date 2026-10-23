# 理象作者约定

你负责把原题变成一份经过独立审核的答案与讲稿，再把它制作成 HyperFrames 视觉课程。工作流分为两个串行循环：

1. **答案循环（AUTHOR）**：答案作者独立解题，写入 `answer.json`（答案、claims、model、solution 和整篇旁白脚本）；答案审核者用全新上下文审核答案正确性、推理、文字和讲稿可朗读性。只有答案审核通过后，`AUTHOR` 才完成。
2. **视频循环（PREPARE）**：视频作者读取已批准的 `answer.json`，生成 `lesson.json`、`src/visual.js`、`src/style.css`；服务用已有音频真实编译并渲染预览帧，视频审核者用全新上下文审核实际帧、答案忠实度、narration 和版式。只有视频审核通过，`PREPARE` 才继续到最终检查并返回可渲染状态；最终视频仍由 `RENDER` 发布。

系统提示词由 `prompts/base/{answer-author|answer-reviewer|video-author|video-reviewer}.md` 加上 `prompts/subjects/{math|physics|chemistry}.md` 组成，服务按题目的 `scope.subject` 自动选择。`AUTHORING.md` 是字段约定和工具说明，不是科目提示词；修改科目策略请改 `prompts/subjects/`。答案审核报告绑定 `answer_sha256`、`script_sha256` 和答案审核提示词摘要；视频审核报告绑定最终 `source_sha256`、`script_sha256`、`answer_sha256` 和视频审核提示词摘要。答案、旁白、画面源码或对应提示词变化后旧批准自动失效。

## 答案阶段：answer.json

答案作者只编辑 `answer.json`，不能创建画面源码。新任务用 `write_answer` 创建完整对象，修改用 `update_answer` 批量提交 JSON Pointer；`validate_answer` 返回结构、公式和数值检查。答案审核者只读，用 `read_answer`/`read_file`/`validate_answer` 读取，并调用 `submit_answer_review` 提交结构化审核。

`answer.json` 的稳定字段：

- `title`、`subtitle`、`chapters`、`scenes` 是讲解骨架。每个 scene 有稳定的 `id`、`title`、`chapter` 和 `beats`；`beats[].say` 是实际朗读文本，`caption` 是可选字幕。场景顺序就是讲解顺序。
- `solution` 是完整文字解答；`expectedAnswer` 是最终答案；`assumptions` 记录题面缺失或图片不确定之处。
- `model` 放解题使用的有限实数、向量和矩阵；图形和 claims 必须引用同一份 model。
- `claims` 至少覆盖题设、关键推导和最终答案；`kind` 为 given/derivation/answer。

`update_answer` 的 changes 为 `[{"pointer":"/scenes/0/beats/0/say","text":"新的旁白"}]`，一次提交所有相关字段。每项选择一个明确类型：text（字符串）、number（数值）、boolean（布尔值）、numbers（数值数组）、strings（字符串数组），复杂对象/数组用 json 传一段合法 JSON。指针使用从 0 开始的数组下标，父节点和数组下标必须存在，字段名中的 `/` 编码为 `~1`，`~` 编码为 `~0`。LaTeX 用 text 直接传，不要把字符串再 JSON 编码；工具响应显示的 JSON 转义不是额外的内容。全部修改通过结构校验后才原子保存；无效修改保留上一个有效文件。

`claims` 的 `left`/`right` 是表达式，`eq/lt/lte/gt/gte` 比较两边数值。不要使用“答案=答案”或“1=1”充当验证。验证器允许 + - * / ^、sqrt/abs/sin/cos/tan/asin/acos/atan/exp/log/log10/min/max/sum/dot/cross/norm/det/transpose/flatten/lusolve/multiply/divide/add/subtract；常量 pi/e，数组和 model 符号。向量减法写 subtract(C,A)。向量关系转为标量，例如 norm(cross(subtract(C,B),subtract(D,A)))=0。只接受有限实数标量结果。幂指数使用 0..12 的常数。tolerance 为相对容差（默认 1e-9），absoluteTolerance 为绝对容差（默认 0）；浮点计算的几何零值需显式给出合适绝对容差。物理、化学中的微小非零量不能用大绝对容差掩盖，优先先无量纲化。数值断言不能代替逻辑证明；独立审核还会检查推理、条件与学段限制。

## 视频阶段：lesson.json 与画面源码

视频作者可编辑 `lesson.json`、`src/visual.js`、`src/style.css`。`write_lesson`/`update_lesson` 写入完整 lesson；CSS/JS 用 `write_file`/`edit_file`。`validate_lesson` 返回结构、公式、数值、答案绑定和浏览器预览状态；`validate_preview` 会按当前 lesson 重新对齐已有音频并刷新真实浏览器报告，不导出视频。视频审核者只读，用 `read_answer`、`read_lesson`、`list_frames`、`read_frames`、`validate_preview` 检查，并调用 `submit_video_review`。

**答案绑定是硬约束。** `lesson.json` 的 `title`、`subtitle`、`expectedAnswer`、`assumptions`、`chapters`、`claims` 必须与 `answer.json` 完全一致；`model` 必须包含 `answer.json` 的全部符号且值完全相同（可以为画面补充新符号）；scenes 的数量、顺序、`id`、`title`、`chapter` 和每个 scene 的 `beats`（`say` 与 `caption`）必须与 `answer.json` 完全一致。视频作者只能添加 blocks、cues、reveals、entities、note 和视觉源码，不能增删、重排或改写已批准旁白。若审核要求改答案或旁白，流水线会回到答案阶段，而不是让视频作者直接改。

用 read_lesson 读取结构化字段，避免嵌套 JSON 转义。新任务先调用 list_files：readable 只列实际存在的文件，notCreated 列尚未生成的允许路径。没有 lesson.json 是正常情况，应按 schema 用 write_lesson 创建；报告由校验和渲染步骤生成。read_file 返回 exists=false 时，不要改成 ./ 前缀或绝对路径反复读取。

lesson.json 是讲稿、数学模型、实体、公式、验证断言和导演提示的唯一数据源。不得将题目的必要条件自行补齐；条件不足或图片无法辨认时，在 answer.json 的 assumptions 中明确记录。坐标、参数放入 model；entities 的 vertices 引用 model 中的三维点，二维模型把 z 写成 0。每个 scene.claimIds 关联相应断言。

## 讲解顺序与文字标准（Polya 四步）

作者和审核者共同使用下面的顺序。它不是排版建议，而是内容质量门。

1. **理解题目**：先交代已知、未知/所求、条件、限制和问题类型；不能一上来写公式或给答案。
2. **制定计划**：说明为什么选这个方法，以及方法适用的条件；再开始推导。
3. **执行计划**：一步只做一件事，写清依据（定义、定理、定律、几何关系或代数变形）和结果；不要跳步，不要用“显然”“易得”掩盖关键推理。
4. **回看**：检查量纲/单位、符号、边界情况，确认回答了原题，再给最终结论。
5. **选择题逐项判断**：A/B/C/D 每一项都先给证据，再给该项结论；错误的普遍性说法要有反例或一般性否定证明；最终答案只在全部选项判断完后汇总，不能提前泄露。
6. **多问题目按问作答**：每一问单独收束，不把后面的结论提前使用。
7. **面向学生表达**：先定义符号再使用；一句话只表达一个重点；公式前后用自然语言说明它在做什么。

文字、公式和图中符号必须同名且在画面首次使用时可见；A/B 与 Q₁/Q₂ 之类的中途换名视为通用错误。

文字先于逻辑检查。标题、题干、选项、场景标题、标签、单位、字母上下标、字幕和旁白都要逐字校对；错字、漏字、重复字、同音字、错标点、全半角混用、错误字母/数字/单位、显示文字与旁白不一致，都属于必须返修的问题。答案正确但文字有错或讲解跳跃，不能通过审核。

## 整篇配音与导演提示

- 每个 scene 有 beats，每个 beat.say 是实际朗读文本。服务把所有 say 顺序合成一篇，一次发给 TTS；答案审核通过后，PREPARE 会合成整篇音频，视频阶段只复用已批准讲稿，不重新配音。
- say 必须可以直接交给中文 TTS。把 f′(x)、r²、(−2)^m 等记法改写成“函数 f 在 x 处的导数”“r 的平方”“负二的 m 次方”，显示公式保留在 lesson blocks/caption。区分下标 n+1 与在第 n 项上加 1，例如读“数列 b 的第 n 加一项，比第 n 项大一”。带多个因子的分母应说清整个分母的分组，避免将分式读成连乘。
- cues 中 beat 是本场从 0 开始的句段索引；anchor 必须是该 say 中可精确找到的词句；objects 是 entities 的完整 id（如 line:AB、plane:PAD）。同一句的多个提示按照朗读顺序排列，且需落在不同词边界；若同一 anchor 出现多次，显式写 occurrence（从 1 开始）。
- 每个 blocks 元素恰好对应一个 reveals 元素；reveal 用 beat/anchor 定义公式何时出现。展示顺序可以跟随推理；不能把一页完整答案提前放出。
- 稿件通过审核后会绑定源文件摘要。改稿会使旧音频失效；没有完整 MP3 与精确词表不能导出成片。

## 画面源码

src/visual.js 是普通浏览器 JavaScript，不是模块。定义：

```js
window.ReasonFrameVisual = {
  render({scene, time, duration, phase, context}) {
    // window.LESSON_DATA = {lesson, model, entities, timeline}
    // time 是本场局部时间；phase 为正在讲的 beat 索引。
    // context = {active, seen, firstTimes, beatStarts, age, cueIndex}
    // 返回 viewBox="0 0 900 650" 内的 SVG 内容。
    return '<g data-object="line:AB" data-focus="1">...</g>';
  }
};
```

context.beatStarts 是本场每个 beat 的准确起始秒数，索引从 0 开始。整段动画用 `time - context.beatStarts[目标beat]` 计算进度。context.firstTimes 是以实体 id 为键的首次高亮时间表，不是 beat 时间表；context.age 只是当前 cue 已播放的秒数，换 cue 时会重置，不能用它控制跨 cue 的移动。数组直接传 JSON 数组，例如 `[110,245,0]`，不要传 `{"item":[...]}`；数值使用 JSON 数字。

每个被讲到的实体都要绘制一个具有准确 data-object 的组；被选中时 data-focus="1"，未选中时为 "0"。高亮要体现在颜色、线宽、面填充和背景实体变暗上，不能只改标签。线与面必须是独立实体。当前场景所有 active 实体都必须可见且在画面内。

默认使用浅色纸面主题：纸面 `#F7F5EE`、正文 `#20201C`，蓝/琥珀/绿/紫（`#2F6690`/`#A66B12`/`#4F7A55`/`#785A96`）只用于数学语义。不要黑底、纯黑背景、高饱和霓虹、装饰性卡片、渐变背景或界面按钮。排版要有呼吸感；右侧公式过长时拆分为有推理顺序的块。所有标签必须避开点、线、坐标轴和其他文字，字幕、焦点行和说明之间留出间距；不能出现文字重叠、裁切或压住标记。源码保持 UTF-8，中文正常显示，LaTeX 使用单个反斜线；出现替换字符、常见乱码或 KaTeX 错误必须修复。src/style.css 可调整排版，但不能移除字幕、改变画布 1920×1080 或隐藏审核检查对象。外部资源、网络请求、随机数、Date.now、requestAnimationFrame 驱动的动画均禁用；动画必须由传入的 time 决定，任意顺序 seek 要得到相同画面。只用本地字体和 GSAP/KaTeX。

服务生成 render/index.html、暂停的 GSAP 时间线及 hf-seek 接口。你编辑的源码会成为该 HyperFrames 项目的一部分。浏览器校验将逐一检查 cue 高亮、整句字幕、版式、文字重叠、标记碰撞、裁切、乱码/KaTeX 错误、背景主题和确定性；之后运行 HyperFrames check。视频审核必须在真实预览帧上确认这些项目。reports/visual.json 会列出 overlap、markerOverlaps 和 garbled；作者和审核者都可用 list_frames/read_frames 查看真实截图。检查失败会保留报告，不能绕过。

视频作者和视频审核者都可以调用 validate_preview，服务会按当前 lesson 重新编译并用真实浏览器刷新 visual/hyperframes 报告；不重新配音，不导出视频。返修后不要把旧失败报告当作当前结论，读取 sourceSha256 匹配的 reports/preview.json，必要时调用 validate_preview。没有音频时该工具返回 available=false，此时先完成回答/音频导入；最终浏览器与成片质量门始终保留。

共享运行时让首场解释面板从第0帧可见，以保持首屏标题静态可见；公式仍按各自 reveal 显示。首场标题没有父容器淡入，后续场景可以淡入。

## 版式与审核

- 默认浅色纸面；若用户明确要求暗色才使用暗色，并保持同等对比度。
- 标签与圆点、折线、坐标轴、其他标签之间至少留出视觉间隙；公式过长时拆行或缩小，不要压到相邻块。
- reports/visual.json 中的 overlaps、markerOverlaps、outside、garbled 必须为空；出现任何一项都要修 src/visual.js 或 src/style.css，不能只改文字说明。
- 答案审核者先逐字校对答案文字、逻辑和讲稿，再检查 narrationComplete 和 answerComplete；textClean、reasoningClear、narrationComplete、answerComplete 任一为 false 都不能批准。
- 视频审核者必须先核对 lesson 与已批准 answer.json 的一致性，再逐字校对可见文字和旁白，检查讲解逻辑与易懂性；textClean、reasoningClear、narrationComplete、layoutClean 任一为 false 都不能批准。
- 视频审核者必须查看至少每个场景的检查帧和关键 cue 帧，确认没有文字重叠、裁切、错位、乱码或公式渲染错误；layoutClean 才能为 true。
