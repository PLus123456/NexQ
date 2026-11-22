# 预览页

不启动 App，在普通浏览器里看真实的 React 界面。Tauri 的调用和事件都是假的（`mocks.ts`），界面里的数据全部是合成的（`scenes.ts` 里编的一场面试），没有任何真实转写。

## 启动

```bash
npm run harness
```

然后打开 <http://localhost:5199/>。端口固定是 5199，被占用时会直接报错，不会换端口。它只是一个开发用的页面，`npm run build` 不会把它打进应用。

## 地址参数

| 参数 | 取值 | 默认 |
|---|---|---|
| `view` | `overlay`（答案窗）、`captions`（字幕条） | `overlay` |
| `scene` | 见下表，只对 `overlay` 有效 | `idle` |
| `w`、`h` | 窗口的宽和高（px） | 答案窗 500×700，字幕条 900×140 |
| `lang` | `zh-CN`、`en` | `zh-CN` |
| `theme` | `dark`、`light` | `dark` |

界面画在页面左上角一个固定大小的框里，这个框就相当于 App 的窗口。把浏览器窗口调成同样大小，看到的就是窗口本身。框下面有一行说明和各场景的链接。

例：<http://localhost:5199/?scene=streaming&w=420&h=560>

## 场景

| `scene` | 内容 |
|---|---|
| `idle` | 会议进行中，几行转写，没有问题，没有答案 |
| `question` | 检测到几个问题，最新的一个在 420px 宽的窗口里要占三行 |
| `streaming` | 同上，最新的问题正在回答，答案一直在增长，写完后隔几秒从头再来 |
| `answered` | 最新的问题已回答，历史里还有两条之前的回答 |
| `markdown` | 一条写完的答案：标题、嵌套列表、表格、行内代码、代码块、行内公式 `\( … \)`、独立公式 `\[ … \]`、引用、链接、金额 |
| `transcript` | 很多行转写，双方都有，带译文 |

答案的原文在 `fixtures/answer.md`（流式场景后面再接 `fixtures/answer-more.md`），需要别的排版样例就直接改这两个文件。

点模式按钮、“提问”或问题卡片，会得到同一份合成答案，按流式输出；再点一次同一个模式按钮可以停止。

`view=captions` 显示字幕条窗口，左半边垫棋盘格，右半边垫一张像视频画面的渐变，用来看透明效果。页面同时循环播放一段合成的双语对话：逐词发 `transcript_update`，每个分句说完约 0.7 秒后发带 `chunks` 的 `translation_result`，一行说完后发 `transcript_final`。框下面列出已经发出的事件。

字幕条的地址参数（都可以不写）：

| 参数 | 含义 |
|---|---|
| `chunks=0` | 整行翻译、不带 `chunks`（LLM、DeepL 这类）：一行说完约 1.2 秒后才来译文 |
| `line=N` | 从脚本第 N 行开始（0 起）；第 4 行是一段约 30 秒不停顿的长独白 |
| `bg`、`show`、`cues`、`parties`、`font`、`tfont`、`fade` | 字幕条设置：底色不透明度、显示原文/译文、条数、谁的话、原文和译文字号、淡出秒数 |
| `hover=1` | 模拟鼠标停在字幕条上（显示那排小控件） |

字幕条的渐入和滑动是动画，`shot.mjs` 的虚拟时间截图可能正好截在动画中间（上下两条叠在一起）。要看静止的画面，把截图时机错开，或者用真实时间的无头 Chrome 截图。

## 截图

预览页开着的时候：

```bash
node harness/shot.mjs "scene=streaming&w=420&h=560" /tmp/streaming.png
```

用无头 Chrome 截图，窗口大小取地址里的 `w`、`h`（也可以在后面再写宽和高），所以截到的正好是那个框。字幕条的截图会多留一段高度，把事件列表也截进去。截图前页面先运行 8 秒（虚拟时间）。脚本会把页面控制台的输出打印出来，有报错先看这里。

依赖刚重新预构建之后的第一张截图可能是空白的，再截一次就好。

## 改动时要知道的

- `main.tsx` 先装好 Tauri 的替身，再用动态 `import()` 加载 App 的模块。顺序不能反，有些模块一加载就会调用 Tauri。
- 没有替身的命令返回 `null`，并在控制台里提示一次（`[harness] no mock for "…"`）。需要返回值时在 `mocks.ts` 里用 `onCommand` 加上。
- 场景通过真实的 store 填数据。store 的结构变了，对应地改 `scenes.ts`。
- 在控制台里可以手动发后端事件：`harness.emit("transcript_final", { segment: { … } })`。
- 类型检查：`npx tsc --noEmit -p harness/tsconfig.json`。
