# 交给 Opus 5.5 的任务：答案渲染、字幕条前端、问题流程前端

先读 `docs/fork/interview-redesign/SPEC.md`，重点是第 3、4.2、6、7 节。这份任务书只讲你这一块。三项任务互不依赖，按下面的顺序做，每项单独提交。

## 工作区和分支

- 在会话自己的 worktree 和分支里工作（分支基于 `custom` 的最新提交）。新 worktree 里先装依赖：`npm install`。
- 不要改主检出 `/Users/plus/NexQ`，不要动别人的工作区。
- 提交信息用英文。**不要合进 `custom`，不要推送，不要打包安装 App，不要运行 `npx tauri dev`**（会和正在用的正式版抢端口和数据）。
- 不读用户的钥匙串，不用用户的 Key 调付费 API，测试一律用假数据。
- `~/.nexq/eval/interviews/` 是用户真实面试的转写，这项任务用不到，不要读。

## 你负责的文件

- `src/components/AnswerMarkdown.tsx` 和它的样式、测试；`package.json` 里为它加的依赖
- `src/captions/**`、`src/lib/captions/**`、`src/settings/CaptionSettings.tsx`；语言文件里 `captions` 命名空间
- `src/overlay/questionFlow.ts` 和它的测试；`src/stores/questionStore.ts`、`src/lib/autoAnswer.ts`、`src/lib/questionDetection/**`
- `src/lib/userAction.ts`、`src/lib/ipc.ts` 里为 `skipQueryRewrite` 做的小改动

## 不要碰的文件

- `src/overlay/OverlayView.tsx`、`QuestionStrip.tsx`、`AIResponsePanel.tsx`、`ModeButtons.tsx`、`ResponseProgress.tsx`、`ResponseHistoryList.tsx`、`TranscriptPanel.tsx`、`QuestionPredictions.tsx`：答案窗的布局，Antigravity 在改。问题条只通过 `useQuestionFlow()` 用你的逻辑，接口见 SPEC 3.6，不要改它的形状（要加字段可以，在汇报里说明）。
- `src-tauri/**`：Codex 在改。事件载荷以 SPEC 第 3 节为准。
- 语言文件里 `overlay` 和其他已有的命名空间（只在确实属于你的组件时加键）。

## 任务 1：答案渲染（SPEC 第 6 节）

`src/components/AnswerMarkdown.tsx` 现在是个空壳，只是包了一层 `ReactMarkdown`。所有显示模型输出的地方已经都改成用它。

1. 排版样式：标题、段落间距、有序/无序列表（含嵌套）、引用、行内代码、代码块、表格（带边框，窄窗口里可以横向滚动）、分隔线、链接。项目没有装 typography 插件，现有的 `prose` 类不起作用，不要依赖它；样式写成组件自己的 CSS，用 `em` 做间距，让外层传进来的字号、颜色、行高（悬浮窗的排版设置）继续生效。亮色和暗色主题下都要能看。
2. 公式：`remark-math` + `rehype-katex`。KaTeX 的 CSS 和字体从 npm 包里打进应用（离线可用，不走 CDN），只带 woff2 就够。
   - 渲染前做定界符转换：`\( … \)` → `$ … $`，`\[ … \]` → `$$ … $$`；代码块和行内代码里的内容不动。
   - 像 `$5 和 $10` 这样的金额不能被当成公式。
   - 流式输出时公式没闭合：先原样显示，闭合后渲染；不能抛错，不能让整段答案闪烁或重排得很厉害。
   - `throwOnError: false`，不开 `trust`。
3. 上游的防护保留：图片不加载，链接要确认后才用系统浏览器打开（`src/lib/answerMarkdown.tsx`）。
4. 性能：长答案流式输出时每个字都会重新解析，量一下 5000 字的答案在流式状态下的渲染耗时，明显卡顿就做节流或分段缓存，并在汇报里写出测量结果。
5. 测试：定界符转换（含代码块、金额、未闭合三种情况）、列表和表格渲染出正确的结构、公式渲染出 KaTeX 的节点、图片不加载。
6. 用预览页（`npm run harness`，场景 `?scene=markdown`）确认实际效果，汇报里附截图。场景里的示例答案包含标题、嵌套列表、表格、行内公式和独立公式，可以按需补充。

## 任务 2：字幕条前端（SPEC 3.1–3.3）

`src/captions/CaptionsWindow.tsx`、`src/lib/captions/` 下的类型和窗口辅助函数、`configStore` 里的设置项、`captions` 命名空间都已经有空壳。

1. **切分函数**（`src/lib/captions/cues.ts`，纯函数，重点测试）：输入是一行的原文（已确定的部分和还在识别的尾巴）、翻译分块（可能没有）、整行译文和是否还在翻译，输出 `CaptionCue[]`。规则见 SPEC 3.3。
   - 有分块时只在块边界断开。
   - 没有分块时的句子对齐写在 `src/lib/captions/align.ts`：句数相同一一配对；不同时按长度比例做单调对齐（动态规划，允许 1 对 1、1 对 2、2 对 1）；英中之间的长度比按字符数估算并可配置。
   - 同一行的字幕 id 要稳定：行在变长时，已经完成的字幕的 id 和内容不能变。
2. **数据**：字幕窗口自己订阅 `transcript_update`、`transcript_final`、`translation_result`，按 `captionsParties` 过滤，只保留最近几行。翻译分块从 `translation_result` 的 `chunks` 取；这个字段由 Codex 在加，没有它时走整行对齐的路径，两条路径都要有测试。
3. **界面**：
   - 透明背景上的文字要看得清：文字加描边或阴影；底色是黑色，不透明度由 `captionsBgOpacity` 控制，0 时完全透明。
   - 每条字幕原文一段、译文一段（按 `captionsShow` 决定显示哪些），每种语言最多两行，超出时显示末尾部分。还在识别/翻译中的文字显示成暗色。
   - 显示最近 `captionsCueCount` 条，旧的变暗；没有新内容 `captionsFadeSeconds` 秒后整体淡出，有新内容立刻恢复。
   - 新字幕出现和旧字幕退场要平稳，不能整块跳动。
   - 鼠标移上去时出现一排小控件：字号加减、底色不透明度、锁定（鼠标穿透）、关闭。锁定后这排控件不再出现，只能从答案窗解锁。
   - 整个条可以拖动；可以拖边缘改宽度；位置和大小记进 `captionsBounds`。第一次显示时放在当前屏幕底部居中，宽度取屏幕宽度的 70%（不超过 1000px）。
   - `captionsParties` 是 `both` 时，每条字幕前加一个小的说话方标记。
4. **窗口控制**（`src/lib/captions/window.ts`）：`showCaptions()`、`hideCaptions()`、`toggleCaptions()`、`setCaptionsLocked()`。会议开始时如果 `captionsEnabled` 就显示，会议结束时隐藏并解锁。答案窗标题栏的按钮会调用这些函数（按钮本身由 Antigravity 放）。
5. **设置页**（`src/settings/CaptionSettings.tsx`，并在设置导航里加一项）：SPEC 3.2 表里的全部设置项，带一个实时预览。
6. 文字走 i18n，`captions` 命名空间，en 和 zh-CN 两份。
7. 用预览页确认效果（`?view=captions`，有逐步"说话"的假数据），汇报里附截图：透明底、半透明底、只显示译文三种。

## 任务 3：问题流程前端（SPEC 3.4、3.5、4.2）

`src/overlay/questionFlow.ts` 现在装着从旧的 `QuestionDetector.tsx` 里搬出来的逻辑：监听 `question_detection_pending` / `question_detection_result`，按行管理问题卡片，固定等 1.5 秒后自动回答，用户一说话就取消。

1. 改成监听 `question_event`（`upsert` / `remove`），按问题 id 维护列表。旧的两个事件和按行、按 revision 的逻辑删掉。
2. 自动回答的状态机照 SPEC 4.2 的七条实现。几个容易错的地方：
   - "用户已经在说话"的判断：从转写事件里统计用户在这个问题出现之后说了多少词、持续了多久；短应答不算。
   - 提前回答被修订或否决时要先停掉再决定是否重答，停止和重新开始之间不能和别的回答抢（沿用 `inTurn` 那套排队）。
   - 每个问题最多自动重答一次。
   - 用户手动发起的回答永远优先（`runYourAction`、`makeWayForYou` 现有规则不变）。
3. 规则模式下 Cartesia / Deepgram Flux 的"说完了"信号那套逻辑保持上游的行为和测试。
4. 自动回答调用 `runUserAction("Assist", question.text, { requestId, skipQueryRewrite: true })`；`skipQueryRewrite` 一路传到后端的 `skip_query_rewrite`。用户手动点的回答不传。
5. `useQuestionFlow()` 返回 SPEC 3.6 定义的形状。返回从布局切换或设置页回来时，未回答的旧问题保持为可点状态，不要补答（现有行为）。
6. 日志：沿用 `logAutoAnswer`，事件名补上新出现的情况（提前回答、因修订重答、因否决停止、因用户已在回答而跳过），只记计数和耗时。
7. 测试：把现有 `QuestionDetector.test.tsx` 里和逻辑有关的用例迁到 `questionFlow.test.ts` 并按新事件改写；新增覆盖 SPEC 4.2 的每一条，以及"问题被修订但只是标点不同时不重答"。

## 提交前的检查

```bash
npx tsc --noEmit
```

```bash
npm test
```

```bash
node scripts/i18n-check.mjs
```

## 汇报

用中文，包含：分支名和各次提交、每项任务做了什么、检查结果、预览页截图、流式渲染的性能测量、和 SPEC 不一致或你认为 SPEC 有问题的地方、需要 Codex 或 Antigravity 配合的地方。
