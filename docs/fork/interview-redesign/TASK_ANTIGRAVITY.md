# 交给 Antigravity 的任务：答案窗重构

先读 `docs/fork/interview-redesign/SPEC.md` 的第 1、2、3.6、5 节。这份任务书只讲你这一块。

## 背景

NexQ Plus 是 NexQ（Tauri 2 + React + Rust 的会议/面试助手）的自用分支。会议中的悬浮窗现在是左右两栏：左边转写，右边上面问题、下面答案。实际面试时问题卡片和各种控件把答案挤得只剩一条缝，转写栏又挡住会议画面。

这次把悬浮窗改成"答案窗"：问题条 1–2 行，答案占满剩余高度，转写按需打开。对方说的话另有一个独立的字幕条窗口显示（别人在做，不归你）。

## 工作区和分支

- 工作区：`/Users/plus/NexQ/.worktrees/answer-window`，分支 `agy/answer-window`，已经建好，依赖也装好了。只在这个目录里工作。
- 不要改主检出 `/Users/plus/NexQ`，不要动 `.claude/worktrees/` 和 `.worktrees/` 里别人的工作区。
- 做完在自己的分支上提交（可以分几次提交，提交信息用英文）。**不要合进 `custom`，不要推送，不要打包安装 App，不要运行 `npx tauri dev`**（会和正在用的正式版抢端口和数据）。
- 只读写这个工作区里的文件。不要读用户主目录下的应用数据和密钥：`~/Library/Application Support/com.plus.nexq`、`~/.nexq`、钥匙串。预览页里的数据全是合成的，够用了。

## 你负责的文件

- `src/overlay/OverlayView.tsx`（整体布局、标题栏、"更多"菜单、转写抽屉）
- `src/overlay/QuestionStrip.tsx`（问题条的界面）
- `src/overlay/AIResponsePanel.tsx`、`ResponseProgress.tsx`、`ResponseHistoryList.tsx`、`ModeButtons.tsx`
- `src/overlay/TranscriptPanel.tsx`（只改它怎么被放进抽屉，以及它自己的排版控件收进浮层；转写行 `TranscriptLine.tsx` 的行为不要动）
- `src/overlay/QuestionPredictions.tsx`（收成小按钮 + 浮层）
- 需要的话可以在 `src/overlay/` 下新建组件文件
- 对应的测试文件
- 语言文件里 `overlay` 命名空间的 en 和 zh-CN（只加键，不要整文件重排；别的命名空间不要改）
- 预览页里答案窗的场景：`harness/scenes.ts` 中 `seedOverlayScene` 及它用到的函数。重构后转写默认关闭，`transcript` 场景要改成打开转写抽屉的状态。同一个文件里的字幕脚本（`playCaptionScript` 及其后面的部分）和 `harness/fixtures/*.md` 不归你，不要动。

## 不要碰的文件

- `src/overlay/questionFlow.ts` 和 `questionFlow.test.tsx`：问题列表和自动回答的逻辑，别人在重写。你只通过 `useQuestionFlow()` 拿数据和回调，接口见 SPEC 3.6。接口不够用就在汇报里提，不要自己改。问题条的测试写在 `QuestionStrip.test.tsx`（已有 16 个用例，用假的 `useQuestionFlow` 驱动）。
- `src/components/AnswerMarkdown.tsx`：答案的 Markdown 和公式渲染，别人在做。你只管把 `<AnswerMarkdown content={…} streaming={…} style={…} />` 放在对的位置，不要自己处理排版样式和公式，也不要再直接用 `ReactMarkdown`。
- `src/captions/**`、`src/lib/captions/**`、`src/settings/**`、`src/stores/**`（除非只是读）、`src-tauri/**`。
- `src/lib/types.ts`、`src/lib/events.ts`、`src/lib/ipc.ts`：需要新字段或新命令时在汇报里提。

## 要做的

按 SPEC 第 5 节实现。逐项说明：

1. **标题栏**压成一行。保留在标题栏上的：拖动区、会议名、计时、录制标记、字幕条开关、转写开关、隐身、透明度、"更多"菜单、结束会议。其余现有按钮全部收进"更多"菜单，一个都不能丢：两侧静音、翻译开关和它的显示方式/全部翻译/目标语言、发言统计、书签、通话记录、开发日志、设置、最小化、模式标记和场景名可以放进菜单顶部。
   - 字幕条开关调用 `src/lib/captions/window.ts` 里现成的 `toggleCaptions()`，按下状态用 `useCaptionsVisible()`（`src/lib/captions/useCaptionsVisible.ts`）。锁定按钮调用 `setCaptionsLocked()`，状态读 `configStore` 的 `captionsLocked`。这几个函数已经能用，直接调用，不要改它们。
2. **问题条**（`QuestionStrip.tsx`）：
   - 默认一行，最多两行，超出截断；总高度不超过 72px。
   - 悬停或点击时用浮层显示全文，浮层不能把答案区往下推。
   - 状态标记：识别中、可回答、回答中、已回答、待点击（对应 `FlowQuestion.status`）。
   - 上一个/下一个可以翻看之前的问题；"回答"按钮和关闭按钮。
   - 没有问题时只显示一行很淡的占位文字。
   - 预测的问题（`QuestionPredictions`）收成一个带数量的小按钮，点开是浮层。
3. **模式按钮**一行显示，放不下时横向滚动，不换行。上游新加的"提问"输入（带截图）保持可用。
4. **答案区**占满剩余的全部高度：
   - 流式输出时文字立刻可见。进度提示（`ResponseProgress`）改成答案区顶部的一行细条，不再占一整块。
   - 自动滚动到底；用户往上翻时停止跟随，出现"回到最新"按钮，点了恢复跟随。
   - 标签（当前 / 之前的回答 / 置顶 / 历史）和复制、置顶按钮并成答案区底部的一行。
   - 字号、颜色、行高、边距、对齐这些排版控件收进"排版"按钮的浮层，不再常驻两行。
   - 来源链接列表、"提前准备"标记、耗时信息保留。
5. **转写**默认不显示。打开转写开关时，转写面板以抽屉形式盖在答案区上；窗口宽度 ≥720px 时可以切成并排。搜索、书签、说话人改名、翻译显示、音量条和静音这些现有功能都保留；转写面板底部的排版控件同样收进浮层。
6. **状态栏**保留成一行细条。
7. 新会议开始时，布局回到默认（答案为主，转写关闭）。

所有界面文字都要走 i18n，en 和 zh-CN 两份。拿不准的中文用词追加到 `docs/fork/TRANSLATION_REVIEW.md`。

## 怎么看效果

不能启动真正的 App，用仓库里的预览页：

```bash
npm run harness -- --port 5211
```

然后在浏览器打开 <http://localhost:5211/>。预览页用假数据渲染答案窗，地址参数可以换场景和窗口大小，用法见 `harness/README.md`。验收用的场景是 `?scene=streaming&w=420&h=560`。

这台机器上还有别人在用默认的 5199 端口，所以你固定用 5211。截图脚本要告诉它地址：

```bash
HARNESS_URL=http://localhost:5211 node harness/shot.mjs "scene=streaming&w=420&h=560" /tmp/streaming.png
```

做完后把预览页停掉。

## 验收

- 窗口 420×560、问题有三行那么长、答案正在流式输出时：答案区高度不少于窗口高度的 60%，问题条不超过 72px。为这一条写一个自动化检查（可以是预览页里量 DOM 高度的脚本，也可以是组件测试里对布局类名的断言，说明你选了哪种）。
- 窗口缩到最小尺寸（400×480）时没有横向滚动条，没有控件溢出或重叠。
- 原有功能一个不少：对照改动前的 `OverlayView.tsx`，把每个按钮和面板列成清单，逐项说明现在在哪里。
- 检查全部通过：

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

用中文，包含：分支名和提交、做了什么、功能对照清单、检查结果、预览页截图（至少 420×560 流式输出、转写抽屉打开、"更多"菜单打开三张）、你觉得接口不够用或设计有问题的地方。
