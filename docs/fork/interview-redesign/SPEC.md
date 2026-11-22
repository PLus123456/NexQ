# 面试界面重构：规格（2026-11-22）

三份任务书（`TASK_CODEX.md`、`TASK_ANTIGRAVITY.md`、`TASK_OPUS.md`）都以本文件为准。接口约定写在第 3 节，任何一方要改接口，先改本文件并在汇报里说明。

## 1. 要解决的问题

在真实英文面试里用下来，有四个问题：

1. **字幕是一大长段。** Soniox 等对方停顿才断行，一直不停就 30 秒强制断一次（`soniox_protocol.rs` 的 `finalize_after`）。对方一段常有 400–600 个字符，英文一大段、中文一大段，对不上，也读不过来。转写栏还占掉悬浮窗的一半，挡住会议画面。
2. **答案区被挤没。** 问题卡片不限高，加上历史问题、标签页、两行常驻的排版控件和状态栏，答案只剩一条缝，流式输出时经常看不到。
3. **公式和排版坏的。** 模型用 `\( \)`、`\[ \]` 写公式，界面没有数学渲染；`prose` 样式类没有对应的 CSS（没装 typography 插件），所以标题、列表、段落间距、表格边框全都没有。
4. **问题识别漏答。** 一场 20 分钟的面试里约 6 个要回答的问题，只自动答了 2 个：
   - 用户一开口（哪怕只是 "Mm."），还没出结果的识别就被作废；
   - 链路太长：等停顿判定（≤1.5 秒）+ 防抖 0.7 秒 + 模型（≤2.5 秒）+ 静默等待 1.5 秒；
   - 每行只判最后一句，行中间的问题看不到，被断成两行的问题接不上；
   - hybrid 模式会丢掉规则没命中的直接提问；
   - 识别请求默认带思考。在用户的端点上实测（短提示词，`deepseek-v4.1-flash`）：带思考每次约 1.4 秒，关闭思考约 0.6 秒。思考没有造成超时或空结果，但每次多花约 0.8 秒。

## 2. 目标

- **字幕条**：独立的透明悬浮窗，只显示对方的话，原文和译文成对显示，自动切成短句。只改显示，转写和翻译的存储不变。
- **答案窗**：现在的悬浮窗改成以答案为主。问题条 1–2 行，答案占满剩余高度，转写按需打开。
- **答案渲染**：Markdown 排版正常，公式正常。
- **问题识别 v2**：对方边说边识别，问完就答；用户开口不取消；识别请求 1 秒左右出结果。

不做的事：不改转写行和翻译在数据库里的切分方式；不改启动器和设置页的整体结构（只加新的设置项）；不加模型推荐或默认模型 id。

## 3. 接口约定

### 3.1 翻译分块（Rust → 前端）

Soniox 的翻译是一小块一小块来的，每块跟在它翻译的那段原文后面。2026-11-22 用一段 79 秒的合成英文语音抓了原始流（`src-tauri/src/stt/testdata/soniox_translation_trace.jsonl`），实测：

- 24 段原文、24 段译文严格交替，没有一段译文错位或晚到下一段之后。
- 一块就是一个分句（以逗号或句号结尾），5–18 个英文词；真实面试里说话更碎，中位数约 6 个词。
- 一个分句的原文 token 在它最后一个词说完约 0.7 秒后一起变成 final，译文在其后约 40 毫秒到达，而且译文 token 一出现就是 final。
- 单个词以非 final 的形式出现，是在说完约 0.6 秒后。

`translation_result` 事件增加可选字段 `chunks`：

```ts
interface TranslationChunk {
  /** 这一块翻译对应的原文（final token 原样拼接，保留空格）。 */
  src: string;
  /** 这一块的译文。 */
  dst: string;
}

interface TranslationResult {
  // 现有字段不变：segment_id, original_text, translated_text, source_lang, target_lang, provider, is_final
  /** 按顺序排列的对齐块。只有引擎能给出时才有（目前是 Soniox）。 */
  chunks?: TranslationChunk[];
}
```

规则：

- 配对按流顺序：一段连续的译文 token 归给它之前、上一段译文之后的那些原文 final token。译文可能比原文晚到，这时 `src` 会略微超前于 `dst`，可以接受，但顺序不能乱。
- 每次事件带这一行到目前为止的全部块。所有块的 `dst` 依次拼起来等于 `translated_text`（中文、日文块之间不加空格）；所有块的 `src` 拼起来是 `original_text` 的前缀。
- 还没等到译文的原文不放进 `chunks`，前端从转写事件的行文本里取。
- 顺手修掉：`translated_text` 里中日文块之间不该有空格（现在存进数据库的中文译文带空格）。

### 3.2 字幕窗口

- 窗口 label：`captions`，地址 `index.html?view=captions`。透明、无边框、置顶、无阴影、不进任务栏，默认不显示。
- 隐身模式、全屏悬浮（`float_over_full_screen`）都要覆盖它。
- 窗口自己订阅 `transcript_update` / `transcript_final` / `translation_result`（这些事件本来就发给所有窗口），只在内存里留最近几行。
- 会议开始时如果 `captionsEnabled` 就显示，会议结束时隐藏。答案窗标题栏有开关按钮。
- 锁定（鼠标穿透）：锁定后窗口不接收鼠标事件，只能从答案窗的按钮解锁；会议结束自动解锁。

设置项（`configStore`，跨窗口同步）：

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `captionsEnabled` | boolean | true | 会议开始时显示字幕条 |
| `captionsParties` | `"them" \| "both"` | `"them"` | 显示谁的话 |
| `captionsShow` | `"both" \| "translation" \| "original"` | `"both"` | 显示原文、译文还是都显示 |
| `captionsFontSize` | number | 20 | 原文字号（px） |
| `captionsTranslationFontSize` | number | 20 | 译文字号（px） |
| `captionsTextColor` | string | `#ffffff` | 原文颜色 |
| `captionsTranslationColor` | string | `#ffd34d` | 译文颜色 |
| `captionsBgOpacity` | number | 0.35 | 黑色底的不透明度，0–0.8；0 是纯透明 |
| `captionsCueCount` | number | 2 | 同时显示几条字幕，1–3 |
| `captionsFadeSeconds` | number | 8 | 没有新内容多久后淡出；0 是不淡出 |
| `captionsLocked` | boolean | false | 鼠标穿透 |
| `captionsBounds` | `{x,y,width,height} \| null` | null | 上次的位置和大小；null 时放在当前屏幕底部居中 |

### 3.3 字幕条的切分（前端纯函数）

```ts
interface CaptionCue {
  /** `${segmentId}#${n}`，同一行里从 0 递增。 */
  id: string;
  src: string;
  dst: string;
  /** 这条字幕后面还在识别/翻译中的文字（显示成暗色）。 */
  srcPending?: string;
  dstPending?: string;
  /** 之后不会再变。 */
  complete: boolean;
}
```

- 有 `chunks` 时，字幕只在块的边界处断开，这样原文和译文始终成对。
- 断开的时机：句末标点（`. ? !` 和 `。？！`）且这条已经够长（默认 ≥24 个字符）；或者超过上限（拉丁文字默认 84 个字符，中日文 30 个）时在最近的块边界断开；一行结束（final）时一定断开。
- 没有 `chunks` 时（LLM、DeepL 等整行翻译）：原文和译文各自按句末标点切句，句数相同就一一配对，不同就按长度比例做单调对齐；对不上就整行作为一条。
- 只显示最近 `captionsCueCount` 条，旧的那条变暗。

### 3.4 问题事件（Rust → 前端）

旧的 `question_detection_pending` 和 `question_detection_result` 事件删除，换成：

```ts
interface DetectedQuestionV2 {
  /** 会议内唯一，如 "q7"。同一个问题的后续修订沿用同一个 id。 */
  id: string;
  /** 每次修订加一。 */
  revision: number;
  /** 补全指代后的完整问题，用原语言。 */
  text: string;
  /** 转写里这个问题结束处的原话（不超过 12 个词），用于定位和去重。 */
  quote: string;
  ask_kind: "direct" | "implicit";
  /** 问题已经问完整，可以开始回答。 */
  complete: boolean;
  /** "rules"：停顿时规则先给出的临时结果；"model"：模型确认或改写后的结果。 */
  origin: "rules" | "model";
  /** 问题结束处所在的转写行。 */
  line_id: string;
  timestamp_ms: number;
  source: string;
  /** 发出这次结果时，对方这一段已经说完（收到了停顿判定）。 */
  speaker_done: boolean;
  /** 命中了提前准备好的答案（问题预测）。 */
  prepared: boolean;
}

type QuestionEvent =
  | { kind: "upsert"; question: DetectedQuestionV2 }
  | { kind: "remove"; id: string; reason: "veto" | "superseded" | "reset" };
```

事件名：`question_event`。`question_detection_log` 和 `question_detection_settings_changed` 不变。

`remove` 的含义：`veto` 是模型否决了规则的临时结果；`superseded` 是被新问题合并或取代；`reset` 是会议重置、设置变更或开关关闭。

### 3.5 回答请求的新选项

`runUserAction("Assist", question, opts)` 这条路径增加一个选项：前端 `skipQueryRewrite?: boolean`，后端 `skip_query_rewrite`（serde 默认 false）。为 true 时，知识库检索直接用这个问题，不再走 `rag_query_rewrite`。识别 v2 给出的问题已经补全了指代，自动回答时一律传 true（改写查询超时过多次，每次白等 5 秒）。用户手动点的回答不传。

### 3.6 前端内部的接缝（已在底座提交里建好空壳）

| 文件 | 负责方 | 说明 |
|---|---|---|
| `src/components/AnswerMarkdown.tsx` | Opus | 所有显示模型输出的地方都用它。属性：`content`、`streaming?`、`className?`、`style?`。别处不要再直接用 `ReactMarkdown`。 |
| `src/overlay/questionFlow.ts` | Opus | 问题列表、自动回答的状态机。对外是 `useQuestionFlow()`。 |
| `src/overlay/QuestionStrip.tsx` | Antigravity | 问题条的界面，只从 `useQuestionFlow()` 取数据和回调。 |
| `src/captions/**`、`src/lib/captions/**` | Opus | 字幕窗口和切分函数。 |
| `src/settings/CaptionSettings.tsx` | Opus | 字幕条设置页。 |
| `src/overlay/OverlayView.tsx`、`AIResponsePanel.tsx`、`ModeButtons.tsx`、`ResponseProgress.tsx`、`ResponseHistoryList.tsx`、`TranscriptPanel.tsx` | Antigravity | 答案窗的布局。 |
| `src-tauri/**` | Codex | 全部 Rust 改动。 |

`useQuestionFlow()` 的形状：

```ts
interface FlowQuestion {
  id: string;
  text: string;
  askKind: "direct" | "implicit";
  /** "detecting"：临时结果，模型还没确认；"open"：可回答；"answering"；"answered"；"held"：没有自动回答，等用户点。 */
  status: "detecting" | "open" | "answering" | "answered" | "held";
  prepared: boolean;
  timestampMs: number;
}

interface QuestionFlow {
  /** 新的在前，最多 10 个。 */
  questions: FlowQuestion[];
  /** 用户点了"回答"：打断正在进行的自动回答，回答这个问题。 */
  answer: (id: string) => void;
  /** 用户关掉了这个问题。 */
  dismiss: (id: string) => void;
}
```

i18n：字幕相关的文字放新的命名空间 `captions`（Opus），答案窗的文字继续用 `overlay`（Antigravity），两边不要改对方的语言文件。

## 4. 问题识别 v2 的行为

### 4.1 后端

**输入。** 对方的每次转写更新都喂给识别服务，包括还没 final 的。

**稳定文本。** 同一行相邻两次更新的公共前缀算稳定；一行 final 之后整行稳定。只在稳定文本上判断，避免识别结果改口造成误判。Soniox 的更新大约每 200 毫秒一次；一个词说完约 0.6 秒后以非 final 的形式出现，而整行要等停顿判定才 final，所以不能等 final。句末标点有时在非 final 阶段就有，有时到分句定稿时才补上，触发条件不能只靠问号。

**一段话（turn）。** 对方连续的若干行算一段，中间只隔着用户的短应答（少于 4 个词，如 "Mm."、"Okay"）不算打断。这样被停顿切成两行的问题能接上。

**什么时候调用模型。** 满足任一条件就安排一次请求：
- 稳定文本里新出现了完整的句子，并且带有提问或请求的线索（问号、疑问词开头、"tell me / walk me through / could you / 介绍一下 / 说说"等）；
- 上次请求之后又多了 2 句以上完整的句子；
- 对方这一行 final 了（停顿判定），并且有 3 个词以上的新内容。

同一时间只跑一个请求，请求进行中来了新内容就在结束后用最新的快照再跑一次；两次请求开始时间至少隔 900 毫秒。"Mm-hmm."、"Okay." 这种没有实义的行不调用模型。

**给模型什么。** 不给整篇，也不只给最后一句：

```json
{
  "known_questions": [{ "id": "q3", "text": "…", "status": "answered" }],
  "conversation": "[Them]: …\n[You]: …",
  "new_text": "…上次判断之后新增的稳定文本…",
  "speaker_done": true
}
```

- `conversation`：最近约 90 秒的双方对话，最多 3000 个字符，超出时从句子边界截掉更早的部分。
- `known_questions`：本场已经识别过的问题（最近 8 个），让模型不要重复报，也能指出新内容是在改写哪一个。

**模型返回什么。**

```json
{ "questions": [ { "text": "…", "quote": "…", "kind": "direct", "complete": true, "same_as": null } ] }
```

没有问题就返回空数组。要求模型排除：反问和自问自答、引用别人的话、对别的与会者说的话（"Rafael, do you have any questions?"）、让用户做动作的请求（"Can you go to the next slide?"）。隐含的请求要算（"maybe you can tell me a bit more about…"）。

**合并。** `same_as` 指向已有问题，或者和某个未回答问题的文本相似度很高（词集合 Jaccard ≥ 0.8）时，更新那个问题（`revision` 加一），否则新建。

**规则抢答。** 一行 final 时，如果规则判断最后一句是直接提问，先发一个 `origin: "rules"` 的临时结果，不等模型。模型结果回来后改写它（同一个 id，`origin: "model"`），或者否决它（`remove`，`reason: "veto"`）。

**模型参数。** 关闭思考（走上游合进来的 thinking 机制，这个任务默认 Off），`temperature` 0，JSON 模式，`max_tokens` 400，超时 4 秒。超时或返回无法解析时：如果这一行已经 final，退回规则结果；否则什么也不发，等下一次触发。

**模式。** `rules` 不变。`hybrid` 和 `model` 都走上面的流程；`hybrid` 不再丢掉规则没命中的直接提问，两者的区别只剩"停顿时是否用规则抢答"（`hybrid` 抢答，`model` 不抢答）。

**用户说话。** 用户的转写行不再让识别作废。它只进入 `conversation`，由前端决定要不要自动回答。

**日志。** 每次判断写一行到日志文件，只有计数和耗时，没有转写内容：触发原因、新增字符数、耗时、结果（question / none / timeout / invalid）、来源（rules / model）。

**其他要保持的行为。** 问题检测开关关闭且预测也关闭时，不调用模型；设置变更或路由变更后，旧请求的结果作废；模型确认的问题要通知问题预测服务（`on_detection`），命中时 `prepared` 为 true；`IntelligenceEngine` 里"最近检测到的问题"跟最新的可回答问题保持一致。

### 4.2 前端（自动回答）

开着"自动回答"时：

1. 问题 `complete` 且状态是 `open`，就开始回答，不再固定等 1.5 秒。对方还在说话时开始的回答算"提前回答"。
2. 提前回答进行中，同一个问题收到了差别很大的修订（不是只改了标点和大小写，且词集合相似度低于 0.6）：停掉重答，每个问题最多重答一次。回答已经结束时不自动重答，卡片上给一个"重新回答"的入口。
3. 提前回答进行中，问题被 `remove`（`veto`）：停掉这次回答。
4. 用户已经在说话，并且在回答开始之前已经说了 12 个词以上或超过 6 秒：不自动开始，问题留在问题条里可以点。只说了几个词的应答不算。
5. 另一个回答正在进行时，新问题排队显示为可点的卡片（`held`），不打断。用户手动发起的操作永远可以打断自动回答（现有规则不变）。
6. 命中提前准备的答案（`prepared`）时直接回放，不管"自动回答"开没开（现有行为不变）。
7. 自动回答一律带 `skipQueryRewrite: true`。

规则模式（`effective_mode === "rules"`）下，Cartesia / Deepgram Flux 的"说完了"信号那套逻辑保持上游的行为。

## 5. 答案窗的布局

从上到下：

1. **标题栏**（一行，约 32px）：拖动区、会议名、计时、录制标记；常用按钮：字幕条开关、转写开关、隐身、透明度、"更多"菜单、结束会议。其余按钮（静音、翻译控制、发言统计、书签、通话记录、开发日志、设置、最小化）收进"更多"菜单。
2. **问题条**：默认只占一行，最多两行，超出的部分截断；悬停或点击时以浮层展开全文，不把答案往下推。带状态标记（识别中 / 回答中 / 已回答 / 待点击）、上一个/下一个、关闭。预测的问题收成一个带数字的小按钮，点开是浮层。
3. **模式按钮**：一行，放不下时横向滚动。
4. **答案区**：占满剩余的全部高度。流式输出时文字立刻可见；进度提示改成答案区顶部的一行细条，不占一整块。用户往上翻时停止自动跟随，出现"回到最新"的按钮。
5. **答案区底部的一行**：标签（当前 / 之前的回答 / 置顶 / 历史）和复制、置顶按钮并成一行；"排版"按钮点开浮层，里面是字号、颜色、行高、边距、对齐。
6. **状态栏**：保留成一行细条。

转写：默认不显示。标题栏的转写开关打开时，转写面板以抽屉的形式盖在答案区上（窗口宽度 ≥720px 时可以并排）。搜索、书签、说话人改名、翻译显示这些现有功能都保留。

验收用的尺寸：窗口 420×560，问题有三行那么长，答案正在流式输出。这时答案区的高度不少于窗口高度的 60%，问题条不超过 72px。

## 6. 答案渲染

- `AnswerMarkdown` 自带排版样式（标题、段落间距、有序/无序列表、引用、行内代码和代码块、表格带边框并可横向滚动、链接），不依赖 `prose` 类。字号、颜色、行高由外层传入的 `style` 决定。
- 数学公式：`remark-math` + `rehype-katex`，KaTeX 的样式和字体打进包里（应用离线可用，不走 CDN）。渲染前把 `\( … \)` 换成 `$ … $`，`\[ … \]` 换成 `$$ … $$`，代码块和行内代码里的不动。金额这类单个 `$` 不能被当成公式。
- 流式输出时公式还没闭合：先按原样显示，闭合后再渲染，不能报错或闪烁。KaTeX 用 `throwOnError: false`。
- 上游的防护保留：不加载图片，链接要确认后才用系统浏览器打开。

## 7. 评测集和验收

三场真实面试的转写做成了评测集，放在仓库外面（内容涉及隐私，不要复制进仓库，不要发给任何外部服务）：`~/.nexq/eval/interviews/*.json`。每个文件有整场的转写行和人工标注：

- `must`（31 个）：必须识别出来的提问；
- `optional`（14 个）：确认式的小问题，识别与否都算对；
- `must_not`（22 个）：反问、对别人说的话、让用户做动作的请求，不能触发。

每个标注有 `line_id`、`quote`（问题结束处的原话）和 `end_char`（在那一行里的结束位置），`also` 列出重复或接续同一个问题的其他位置。

回放评测的指标：

- `must` 的召回不低于 85%；
- `must_not` 的误触发不超过 2 个；
- 从问题最后一个词出现到发出 `complete` 的结果，中位数不超过 1.5 秒（按回放的模拟时钟加上真实的模型耗时算）。

真实模型的评测由 Claude 来跑（需要用户的 Key）。各方的自动化测试一律用假模型。
