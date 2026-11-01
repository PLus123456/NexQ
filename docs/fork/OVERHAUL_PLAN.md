# NexQ 自用分支改造计划

> 基于上游 `naxhq/NexQ` v2.29.1（`14d7b4e`，2026-10-31）。调研日期 2026-11-01。
> 本文件只放在 `custom` 分支里（`main` 只跟官方同步，见第 3 节）。上游没有 `docs/fork/` 目录，合并上游时不会冲突。
> 文中 `file:line` 均对应上述基线提交。

## 0. 结论速览

- **你感觉要大改，判断是对的。** 你提的每个痛点在代码里都有明确的根因，而且不止是"少几个输入框"：LLM、STT、翻译三套提供方都是封闭枚举 + 写死地址，界面没有任何国际化框架，首次设置流程里有好几处自相矛盾的默认值。
- **但有一批改动很便宜、立刻见效**：手填模型名（后端本来就接受任意模型名，限制只在前端）、让 OpenAI 兼容的 STT 引擎能填自己的服务器地址、识别和翻译语言允许自填、修掉引导流程的默认值冲突。这些建议最先做。
- **已 fork 到 [PLus123456/NexQ](https://github.com/PLus123456/NexQ)**（2026-11-01，公开），本地 `origin` 指向你的 fork、`upstream` 指向官方。策略是**通用改动优先提 PR 给官方**，只有自用的改动留在 fork 的 `custom` 分支。见第 3 节。
- **自编译自用版之前必须先做"分支卫生"**（只做在 `custom` 分支）：改 Bundle ID、改掉或关掉自动更新（否则上游一发版就会把你的版本换回官方版）、装好 Rust 和 CMake 先把原版编出来。见第 4 节。

## 1. 代码现状

| 项 | 情况 |
|---|---|
| 协议 | MIT：可以自由 fork、修改、再分发，保留 LICENSE 里的版权声明即可 |
| 技术栈 | Tauri 2 + Rust 后端（tokio）+ React 18 / TypeScript / Zustand / Tailwind 前端 |
| 规模 | 前端约 4.9 万行 TS（240 个文件），后端约 4.2 万行 Rust |
| 窗口 | `launcher`（主窗口 + 设置）和 `overlay`（会议悬浮窗），各自独立的 JS 上下文，状态靠后端事件和 store 同步 |
| 设置存储 | 分散在 `config.json`、`translation-config.json`、`nexq-settings.json`（Tauri store）、系统钥匙串、`models/opus_mt/active_model.txt`、localStorage。没有导入/导出 |
| 上游节奏 | 单人维护为主（Vahid Alizadeh 624 次提交），2026 年 10 月一个月 168 次提交，v2.25 → v2.29.1 约一个月；修 issue 很快（[naxhq/NexQ#37](https://github.com/naxhq/NexQ/issues/37) 几天就修了），外部 PR 也合得快（见 3.3） |
| 基线健康 | `npm ci` 正常，`tsc --noEmit` 零错误，`vitest` 46 个文件 274 个测试全过；release 构建通过（6 个未使用变量之类的警告）；`cargo test --lib` 292 个通过、1 个失败、1 个跳过（失败的是只适用于 Windows 的测试，见 3.4；跳过的是需要本地模型的实测） |
| macOS 系统音频 | Core Audio Process Tap（需 macOS 14.2+），不是 ScreenCaptureKit |

上游 10 月改动最频繁的文件（合并冲突热点）：`src/lib/types.ts`、`src-tauri/src/lib.rs`、`src/stores/configStore.ts`、`src/lib/ipc.ts`、`src/App.tsx`、`src/components/ServiceStatusBar.tsx`、`src/settings/LLMSettings.tsx`。

## 2. 痛点逐条对照代码

### 2.1 全英文界面

- **没有任何 UI 国际化框架**（`package.json` 里没有 i18next 之类）。`src/hooks/useTranslation.ts` 是转写翻译功能，不是界面翻译。
- 前端英文硬编码粗估 **1500 处左右**，分布在 117 个 `.tsx` 文件里。最大的几个：`STTSettings.tsx`（1739 行）、`MeetingAudioSettings.tsx`（1176）、`ServiceStatusBar.tsx`（1172）、`ContextStrategySettings.tsx`（1138）、`AIActionsSettings.tsx`（1100）、`TranslationSettings.tsx`（1002）。
- Rust 侧也有：托盘菜单 `src-tauri/src/tray/menu.rs`、系统通知、约 470 处英文错误消息（很多会直接显示在界面上）。
- AI 提示词：默认动作提示词、场景提示词都是英文（可在设置里改）；翻译提示词、历史会议问答提示词、上下文段落标题写死英文，不能改。
- 两个窗口是独立 JS 上下文，切换界面语言要跨窗口同步（可以复用现有的 `store.onKeyChange` 模式）。
- 上游 [naxhq/NexQ#5](https://github.com/naxhq/NexQ/issues/5) 里维护者把"多语言界面"列为单独功能，说近期不在路线图上（该 issue 已关闭）。

### 2.2 LLM：只能选扫描出来的模型、不能真正自定义

你现在用的就是 `custom` 提供方（自填 Base URL + API Key）。问题出在这几处：

| 问题 | 代码位置 | 说明 |
|---|---|---|
| **模型只能从下拉框选** | `src/settings/LLMSettings.tsx:544-565` | 模型选择器是 `<select>`，选项只来自 `listModels()` 的结果，没有任何输入框。端点没有 `/models` 时列表为空，根本选不了。后端其实接受任意模型名（`set_active_model` 不校验），限制**纯粹在 UI 上**。`custom.rs:208` 的注释写着 "user can type model name manually"，但界面从来没做 |
| 其他入口同样只能选 | `ServiceStatusBar.tsx:1139-1161`（底栏快切）、`wizard/LLMSetupStep.tsx:448-469`（引导）、`OpenRouterModelCatalog.tsx` | 全部是"拉列表 → 点选" |
| 只能有一个自定义端点 | `configStore.ts` 的 `customLlmBaseUrl` / `customLlmAuthType` + 钥匙串单一槽位 `custom` | 想同时配公司网关 + 家里 vLLM + 某云厂商？不行 |
| 不能加自定义请求头 | `src-tauri/src/llm/custom.rs:21-27` | 只有 None / Bearer / API Key 三种认证；API Key 模式请求头固定为 `x-api-key`（前端从不传 `auth_header`） |
| 自定义端点报错被吞 | `custom.rs:287-314` | `/chat/completions` 一失败（包括 401、400）就静默改请求 Ollama 的 `/api/chat`，用户只能看到第二个错误，排查很痛苦 |
| 官方提供方地址写死 | `llm/mod.rs:80-91`、`openai_compat.rs:267/278/289` | OpenAI / Groq / OpenRouter 的工厂函数直接忽略 `base_url`；Ollama / LM Studio / Anthropic / Gemini 后端支持 `base_url`，但前端从来不传。**Ollama 跑在另一台机器上，界面里没法配** |
| 推理模型的思考内容丢失 | `llm/stream_parser.rs:45-51` | 只读 `choices[0].delta.content`，DeepSeek / Qwen 等返回的 `reasoning_content` 被忽略 |
| 全局只有一个"提供方 + 模型" | `llm/mod.rs:205-210`（`LLMRouter`） | AI 助手、会议总结、LLM 翻译、历史会议问答全都用同一个模型，没法给实时翻译配一个快模型、给总结配一个强模型 |
| **LLM 翻译和 AI 助手互相阻塞** | `commands/translation_commands.rs:520-523` | 两者共用同一个 provider 实例，锁在整个流式输出期间不释放。开着实时 LLM 翻译时点"AI 助手"，要排队 |
| 部分提示词写死英文 | 翻译 `translation_commands.rs:485-489`、历史会议问答 `meeting_chat_commands.rs:61-85`、上下文段落标题 `intelligence/context_builder.rs:66-93` | 场景提示词和各动作提示词可以在设置里改，但这几处不能 |
| custom 被排除在外 | `ServiceStatusBar.tsx:1008`、`configStore.ts:61-67`、引导流程 | 底栏快切、Claude 备用模型、首次设置都不支持自定义端点 |

后端结构：`ProviderType` 是封闭枚举，`llm/mod.rs` 里有 8 处 match；前端的提供方元数据在 `types.ts`、`LLMSettings.tsx`、`ServiceStatusBar.tsx`、`LLMSetupStep.tsx`、`ClaudeCliSettings.tsx` 各抄了一份。加一个通用的"OpenAI 兼容配置档"要动的面不小，但都集中在这几个文件里。

### 2.3 STT：识别模型没法部署到别的机器

**结论：10 个引擎没有一个能指向自建服务器，所有地址都是编译期写死的。**

| 问题 | 代码位置 | 说明 |
|---|---|---|
| 云端引擎地址写死 | `stt/groq_whisper.rs:347`、`stt/whisper_api.rs:135`、`stt/deepgram.rs:348`、`stt/azure_speech.rs:96-99` | 任何 STT 配置结构里都没有 `base_url` 字段。Deepgram 有个 `url_override`，但只在测试代码里用，而且 `Host` 头也写死了 |
| 但离"通用远程 STT"只差一步 | `groq_whisper.rs` | Groq 和 Whisper API 发的就是 OpenAI 标准的 `/v1/audio/transcriptions` multipart 请求。Groq 的客户端功能最全（模型名是字符串、支持 prompt / temperature / 分段长度 / 停顿切分）。只要把 URL 和"必须有 API Key"放开，就能接 faster-whisper-server（speaches）、LocalAI、vLLM 等自建服务 |
| 识别语言全局只有一个 | `configStore.ts:184`、`stt_commands.rs:271-294` | "我"和"对方"共用一个语言。README 说每路"有自己的引擎、语言"，语言这条不成立。对方说英文、我说中文，没法分开设 |
| 语言列表写死 18 个，不能自填 | `STTSettings.tsx:146-165`、`MeetingAudioSettings.tsx:144-163`（两处重复） | 下拉框，没有"自动检测"，不能输入任意语言代码。后端其实接受任意字符串；每个引擎支持哪些语言的元数据后端有（`provider.rs:178-390`），前端没用 |
| **默认设置在 Mac 上大概率跑不通** | `wizard/STTSetupStep.tsx:76`、`configStore.ts:1043-1078` | 引导流程默认"对方 = whisper_cpp"，可配置加载时又会把 whisper_cpp 强制迁移成 Deepgram（需要 API Key）。你现在的配置就是"我 = Web Speech、对方 = whisper_cpp"，下次启动"对方"会被静默改成 Deepgram。预设"Local Only (Whisper)"和"In-Person"同样会被改掉 |
| Web Speech 在 Mac 上不稳 | `docs/user-guide/audio-setup.md:85`、`audio/device_default.rs:328-350` | 跑在 WKWebView 里，文档自己写了可能报 `service-not-allowed`；选麦克风的功能只有 Windows 能用 |
| Windows Speech 在 Mac 上也显示"可用" | `stt/windows_native.rs:250-253` | Mac 上只会输出 `[speech: N s]` 占位文字，界面没按平台隐藏 |
| **本地模型在 Mac 上只用 CPU** | `Cargo.toml`（`whisper-rs = "0.16"` 没开 `metal`）、`ort_streaming.rs:937-942`（没配 CoreML） | 界面写着"GPU"，代码里没有任何 GPU 路径。Apple Silicon 上开 Metal 后 whisper.cpp 应该能快不少，这可能是你觉得本地模型不好用的原因之一 |
| 模型下载源写死，无校验 | `stt/local_engines/model_registry.rs`、`downloader.rs:108-121` | 从 huggingface.co 和 GitHub Releases 下载，国内网络经常很慢；没有镜像设置；所有 `sha256` 都是空的，不校验完整性；不能导入自己的模型文件 |
| SenseVoice 依赖外部程序 | `stt/sherpa_offline.rs:519-552` | 需要 `sherpa-onnx-offline` 可执行文件，NexQ 不下载也不打包 |
| 重采样质量一般 | `audio/resampler.rs:7-44` | 线性插值、没有抗混叠滤波、跨回调不保留状态，对识别准确率有些影响 |

新增远程引擎需要注意：`feed_audio` 是在共享音频循环里直接 `await` 的，一阻塞就会拖住另一路和录音（`audio_commands.rs:1386-1428`），所以 HTTP 请求要 `spawn` 出去（Groq 已经这么做了）。

### 2.4 翻译与字幕

| 问题 | 代码位置 | 说明 |
|---|---|---|
| 翻译服务地址写死 | `translation/microsoft.rs:36`、`google.rs:5`、`deepl.rs:13-18` | Microsoft 不支持自定义 Azure 资源端点；DeepL 按 Key 后缀自动选 free/pro 地址；都不能改 |
| LLM 翻译不能单独配 | `translation_commands.rs:496-504` | 只能用全局那一个 LLM（和 AI 助手同一个模型），提示词写死英文、没有 system prompt、没有术语表；"测试连接"是桩代码，永远返回成功（`translation/llm_provider.rs:50-58`） |
| 语言列表写死 38 个，不能自填 | `TranslationSettings.tsx:106-145` | 源语言和目标语言共用这一份；下拉框，不能输入任意代码。语言代码也不按服务商做映射 |
| 离线 OPUS-MT 宣传和实际不符 | `TranslationSettings.tsx:53`、`opus_mt_registry.rs` | 卡片写"100+ 语言"，实际只有 22 个模型、12 种语言（全部是英语 ↔ X）；手动放进目录的 Marian 模型会被忽略 |
| **新装默认翻译不可用** | `translationStore.ts:70`、`App.tsx:84` | 默认服务商是 Microsoft，但没有 Key，报错被吞掉，用户不知道 |
| 不能选翻译哪一路 | `useTranslation.ts:98-169` | "我"和"对方"的话全都翻译；只有一个目标语言 |
| **悬浮窗里每句话翻译两遍** | `App.tsx:56` + `OverlayView.tsx:133` | `useTranslation()` 在悬浮窗里挂了两次，各自注册监听，每段文字调用两次翻译接口（云翻译费用翻倍，LLM 翻译还会和 AI 助手抢锁） |
| 段落变长会整段重译 | `stt/segment_accumulator.rs:5-13` | 同一段落每次追加文字都会重新翻译整段 |
| 合并后的行只显示第一段译文 | `TranscriptPanel.tsx:124-128`、`TranscriptLine.tsx:63` | 同一说话人连续几段合并显示时，后面几段的译文看不到 |
| 字幕显示选项少 | `types.ts:955`、`OverlayView.tsx:253-300` | 只有"行内"和"悬停"两种；文档说有"仅译文"模式，代码里没有。悬浮窗里不能改目标语言；自动翻译开关不保存 |
| 其他 | `TranslationSettings.tsx:403/408/440/448`、`db/migrations.rs:212-227` | Microsoft 区域在设置页里会被重置成 `global`；"缓存"开关不起作用；数据库唯一键不含服务商，换服务商会覆盖旧译文 |

### 2.5 首次设置流程

5 步：欢迎 → 音频 → STT → LLM → 完成。

| 步骤 | 问题 |
|---|---|
| 欢迎 | 用浏览器 `fetch` 探测写死的 `localhost:11434`（Ollama）和 `localhost:1234`（LM Studio），受 CORS 影响；探测不到别的机器 |
| 音频 | 只能测麦克风，**不能测系统音频**（对方的声音能不能采到，恰恰是最容易出问题的） |
| STT | 只给 5 个引擎；默认"对方 = whisper_cpp"和配置加载逻辑冲突（见 2.3）；提示横幅推荐"Windows Native"，可这一步根本没提供；不能填 Key、不能下载模型、不能选语言 |
| LLM | 云服务只有 Anthropic / OpenAI / Groq，**没有自定义端点**，不能填 Base URL；只有选了模型才会激活，测试通过本身不算 |
| 完成 | "开始会议"不检查有没有配好；**"上传简历"按钮实际没反应**（`FirstRunWizard.tsx:102-109` 调 `setSettingsOpen(true)`，但主窗口只在悬浮窗视图下渲染设置弹窗，见 `App.tsx:412`） |

其他：没有翻译这一步；步骤进度不保存，中途退出要从头来；从悬浮窗重跑引导要重启才生效；没有 macOS 权限引导；没有配置导入/导出，也没有"恢复默认"；"数据目录"设置项根本不起作用（Rust 从不读它）。

## 3. Fork 与上游贡献

### 3.1 决定

2026-11-01 已 fork 到 [PLus123456/NexQ](https://github.com/PLus123456/NexQ)（公开，只复制了 `main`）。本地远端：`origin` = 你的 fork，`upstream` = `naxhq/NexQ`。

为什么选公开 fork：

- 想给官方提 PR，仓库就得在官方的 fork 网络里。私有仓库不在这个网络里，提不了 PR；只放本地则没有备份，也没有 CI。
- 公开仓库的 GitHub Actions 免费，以后可以在云端打 `.dmg`。
- MIT 协议允许公开 fork，代码里也没有需要保密的东西（密钥都在钥匙串里）。

策略是**通用改动优先提 PR 给官方**。合进官方的改动就不用自己背着了；上游一个月一百六七十个提交，fork 里自己背的差异越少，同步越轻松。只有官方不需要或不收的东西才留在 fork 里。

### 3.2 分支模型

| 分支 | 放什么 | 从哪拉、怎么同步 |
|---|---|---|
| `main` | 只跟官方同步，**不放任何自己的提交** | 本地 `main` 跟踪 `upstream/main`：`git switch main && git pull --ff-only && git push origin main`，或在 GitHub 上点 Sync fork |
| PR 分支 | 一个分支只放一个要提给官方的改动 | `git switch -c fix/xxx upstream/main`，按 CONTRIBUTING 命名为 `<type>/<简短描述>`；推到 `origin`，向 `naxhq/NexQ` 的 `main` 提 PR |
| `custom` | 自用版：`docs/fork/`、第 4 节的分支卫生改动、所有自己的功能 | 从 `main` 拉，定期 `git merge main`；PR 分支做完就合进来，不用等官方合并 |
| 自用功能分支 | 官方不收、或依赖分支卫生改动的功能 | 从 `custom` 拉，做完合回 `custom` |

- 官方 squash 合并你的 PR 后，下次把 `main` 合进 `custom` 时通常能自动合上；维护者改过的地方以官方版本为准。从那以后，这部分就不用你单独维护了。
- 有了 `upstream` 远端，`gh pr create`、`gh issue list` 默认对着 `naxhq/NexQ`。提 PR 时始终显式写 `--repo`，别把自用改动误提给官方（2026-10-31 就有人误提了两个 PR，又自己关掉）。

### 3.3 官方仓库的情况（截至 2026-11-01）

- 维护者是 Vahid Alizadeh，自己的改动基本直接推 `main`。
- 外部贡献者一共提过 12 个 PR，合并 10 个，另外 2 个是作者自己撤回的；10 月以来的大多一天左右就合。你在用的 macOS 版就是社区贡献的（@visitek），README 里有致谢。
- issue 一共 15 个，全部已关闭。
- [CONTRIBUTING.md](../../CONTRIBUTING.md) 的要点：
  - 用 Conventional Commits。PR 可能被 squash 合并，所以 PR 标题本身要是合法的 conventional commit。分支名用 `<type>/<简短描述>`。
  - PR 要小，重构和行为改动分开提。界面改动必须附前后截图；音频、STT、悬浮窗的改动要用 `npx tauri dev` 手动测过，并在 PR 里写清楚测了什么。
  - 提 PR 前跑 `npx tsc --noEmit`、`npm test`、`npm run build`、`cd src-tauri && cargo test --lib`。CI 在 Windows 和 macOS 上都跑，平台相关代码要用 `#[cfg(target_os = "...")]` 隔开，保证另一个平台也能编译。
  - 新提供方、新窗口、数据库迁移、动音频采集这类大改动，先开 issue 或 discussion 商量。
  - 明确欢迎新的识别语言、翻译语言、STT 和 LLM 提供方。
  - 没有 CLA，也不用 DCO 签名。贡献者不能改版本号、`CHANGELOG.md`，也不能打 tag。
- 多语言界面：[naxhq/NexQ#5](https://github.com/naxhq/NexQ/issues/5) 里维护者把它列为单独功能，说近期不在路线图上（该 issue 已关闭）。[naxhq/NexQ#28](https://github.com/naxhq/NexQ/discussions/28)（Discussions，2026-10-25）有人要中文界面，顺带问能不能接 DeepSeek，到现在没人回。
- 手填模型 ID：[naxhq/NexQ#37](https://github.com/naxhq/NexQ/issues/37) 有人提过，维护者的修法是让 Anthropic 的"加载模型"去 API 拉列表，还是没加输入框。维护者偏好列表，所以这个 PR 要做成"下拉候选 + 可自己输入"，并写清楚为什么需要：自定义端点没有 `/models`、新模型还没进列表、经过代理时模型名不同。
- issue 和 PR 都用英文。代码和英文草稿可以让 AI 帮忙，但每个 PR 你要自己看懂，review 也由你自己回。

### 3.4 哪些提给官方，哪些留在 fork

| 去向 | 内容 |
|---|---|
| **先提的小 bug 修复**（跑起来确认后再提） | Rust 测试 `claude_cli_login_launch_keeps_path_out_of_cmd` 在 Mac 上必挂：测的是 Windows 路径，应该只在 Windows 上跑。上游 CI 在 Mac 上只跑 `cargo check`，所以一直没发现；有人提过同样的修复又自己撤回了（[naxhq/NexQ#55](https://github.com/naxhq/NexQ/pull/55)）。适合当第一个 PR；Mac 上 Claude 订阅的"登录"按钮打不开终端（从代码看，`open_claude_login_terminal` 在 Mac 上也去启动 `cmd.exe`）；悬浮窗每句翻译两次；引导里"上传简历"只会结束引导；自定义端点报错被 Ollama 回退吞掉；引导默认 whisper_cpp 和加载迁移冲突；Mac 上也显示 Windows Speech |
| **可以直接提的小功能** | 模型名手填（下拉候选 + 输入）；引导里加自定义端点；OpenAI 兼容 STT 可填 Base URL、模型名、可选 API Key；识别和翻译语言可自填、加"自动检测"；识别语言"我"和"对方"分开设（README 本来就这么写）；whisper.cpp 开 Metal（附实测数据） |
| **先开 issue 商量再动手** | 中文界面（引入 i18n 框架，动到全站约 1500 处文字，以后维护者写界面文字都要走翻译，必须对方同意，而且要分批提）；LLM 连接配置档和按任务选模型；新增远程 STT 引擎（属于新提供方）；首次设置重做；"数据目录"不生效（实现还是去掉，先问维护者） |
| **只留在 fork（`custom`）** | 应用名、Bundle ID、图标；自动更新地址和签名密钥；钥匙串前缀；指向上游的链接；fork 的 CI 和发布配置；`docs/fork/`；个人默认设置；官方不收的改动 |

最理想的结果是维护者愿意收 i18n：中文界面进了官方版，你来维护中文翻译，fork 里要单独维护的差异也最少。

## 4. 自编译前必须先改的地方（Phase 0：分支卫生）

不改这几处，自编译版会出问题。**这些改动只做在 `custom` 分支，不能出现在提给官方的 PR 分支里。**

1. **自动更新会把自编译版换回官方版。** `src/hooks/useUpdater.ts` 启动 10 秒后检查一次、之后每 4 小时检查一次，默认静默下载，退出时安装。更新地址写死在 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`（`naxhq/NexQ/releases/latest/download/latest.json`），校验公钥也是上游的。上游一发新版，官方签名能通过校验，退出 App 时就会覆盖掉你的版本。
   - 处理：换成自己仓库的 `latest.json` + 自己生成的签名密钥（`npx tauri signer generate`），或者干脆默认关闭自动更新。
2. **Bundle ID 相同会和官方版抢同一个数据目录。** `identifier` 是 `com.nexq.app`，数据在 `~/Library/Application Support/com.nexq.app`（你机器上已经有官方版的数据）。建议改成自己的 ID（例如 `com.plus.nexq`，名字待定）和产品名，两个版本可以并存。
   - 钥匙串服务名 `NexQ:{provider}` 写死在 `src-tauri/src/credentials/macos_keychain.rs`，跟 Bundle ID 无关；改 ID 后 API Key 仍会和官方版共用，要彻底隔离就把前缀也改掉。
3. **上游链接。** `src/settings/AboutSettings.tsx` 的 `GITHUB_URL`、`src/hooks/useUpdater.ts` 的 `RELEASES_URL` 指向 `naxhq/NexQ`。
4. **CI。** `.github/workflows/release.yml` 依赖 `TAURI_SIGNING_PRIVATE_KEY` 等 secrets；`deploy-website.yml` 会尝试部署 GitHub Pages，fork 里应停用。只用 Mac 的话可以去掉 Windows 任务。
5. **macOS 签名与权限。** 官方包是 ad-hoc 签名（`signingIdentity: "-"`），本机没有任何代码签名证书。ad-hoc 签名每次重编 cdhash 都会变，麦克风 / 系统音频权限可能每次重编都要重新授权。建议在钥匙串里建一个自签名的代码签名证书，把 `tauri.macos.conf.json` 的 `signingIdentity` 指向它。

## 5. 改造路线

工作量是粗估（按有 AI 协助、集中投入算），实际以做起来为准。

### Phase 0：分支卫生 + 编出基线（半天～1 天）

- 装 Rust、CMake（见第 7 节），`./build-mac.sh --no-install` 先把**原版**编出来，确认工具链没问题。
- 在 `custom` 分支上完成第 4 节的 5 项。

### Phase 1：快速见效（2～3 天）

每项都很小，直接解决你最烦的几件事。按 3.4 的分类，能提给官方的都以 PR 形式提（PR 分支从 `upstream/main` 拉），同时合进 `custom` 自己先用：

- **模型名可以手填**：所有模型选择器（设置页、底栏快切、引导）改成"输入框 + 下拉建议"，拉到的列表只作建议。
- **自定义 LLM 端点修好**：去掉静默改发 `/api/chat` 的回退（改成显式选"OpenAI 风格 / Ollama 风格"），把真实错误显示出来；开放自定义认证头名和额外请求头。
- **远程 STT 能用**：给 OpenAI 兼容的转写引擎加 Base URL、模型名、可选 API Key，就能接你另一台机器上的 faster-whisper / vLLM / LocalAI。
- **语言可以自填**：识别语言和翻译语言都改成"可输入 + 常用列表"，加"自动检测"；识别语言改成"我"和"对方"分开设。
- **修引导和平台 bug**：whisper_cpp 默认值和加载迁移的冲突、Mac 上隐藏 Windows Speech、悬浮窗重复翻译、"上传简历"无效、"数据目录"不生效。
- **Mac 本地模型提速**：whisper.cpp 开 Metal（需要实测效果）。

### Phase 2：中文界面（3～5 天，另加你校对译文的时间）

- **先问官方**：在 [naxhq/NexQ#28](https://github.com/naxhq/NexQ/discussions/28) 回帖或单独开 issue，问维护者收不收 i18n 框架 + 中文翻译。收就按对方的要求分批提 PR（框架 + 一个页面起步，再逐页推进），你来维护中文翻译；不收就只做在 `custom` 上，按下面的方式集中做完。
- 接入 `i18next` + `react-i18next`，资源文件 `zh-CN` / `en`，按系统语言自动选择，设置页和引导第一步可切换；两个窗口同步切换。
- 按页面逐个抽取文案：先设置页和引导（你最常看），再悬浮窗、主窗口、各种提示。
- Rust 侧：托盘菜单、通知、常见错误提示。
- AI 侧：提供中文版默认场景和动作提示词；加一个"AI 回答语言"设置（跟随转写 / 中文 / 英文）。
- 只做在 fork 里时：**集中一次做完，做完立刻合并一次上游**，之后保持高频合并，冲突都是机械性的。

### Phase 3：提供方体系重构（1.5～3 周）

- **LLM 连接配置档**：可以建任意多个连接（OpenAI 兼容 / Anthropic / Gemini / Ollama），每个都能填 Base URL、认证方式、自定义请求头、额外请求体参数、手动维护的模型列表；参数兼容开关（是否发 temperature、`max_tokens` 还是 `max_completion_tokens`、是否解析 `reasoning_content`）。
- **按任务选模型**：AI 助手 / 会议总结 / 实时翻译 / 历史会议问答 / 待办提取各自选"连接 + 模型"，或跟随默认。
- **去掉 provider 长时间持锁**，让翻译和 AI 助手能并发。
- 内置常见服务商模板（DeepSeek、Kimi、智谱 GLM、通义千问兼容模式、火山方舟、硅基流动等），预填地址，全部可改。
- **远程 STT 引擎族**：OpenAI 兼容 HTTP（按 VAD 切段上传）+ 通用 WebSocket 流式（可配地址、认证头、音频格式，按需加 FunASR 之类的协议适配）；"我"和"对方"各自独立的引擎、语言、端点。
- **本地模型**：下载镜像设置（如 hf-mirror.com）、导入自己的模型文件、补上 sha256 校验、CoreML 加速。
- **翻译**：统一的语言目录（一份数据、中文名、支持自定义代码）；可以用任意 LLM 连接翻译，提示词和术语表可编辑；DeepL / Microsoft / Google 端点可改；可选翻译哪一路；修合并行译文显示、整段重译、数据库键不含服务商等问题。

### Phase 4：首次设置重做（3～5 天）

- 新流程：界面语言 → 使用场景 → LLM（手填 + 测试连接）→ STT（本地 / 远程 / 云端，带测试和语言）→ 翻译 → macOS 权限和音频测试（**包括系统音频**）→ 完成前检查配置是否真的可用。
- 进度可保存、可从设置里随时重跑（不用重启）。
- 配置导入/导出（JSON，密钥默认不导出）和"恢复默认"，换电脑或多台机器配置一致。

### Phase 5：打包发布（持续）

- fork 的 CI 用你自己的签名密钥出 macOS 包（需要的话加 Windows），从 `custom` 分支打 tag 发布，自动更新指向你的 Releases。

## 6. 与上游同步的策略

- 远端已配好：`origin` = 你的 fork，`upstream` = `naxhq/NexQ`。
- 建议至少每周一次：先把 `main` 快进到 `upstream/main` 并推到 `origin`，再把 `main` 合进 `custom`。间隔越短，冲突越小。
- 还没合并的 PR 分支和官方冲突时，把 PR 分支 rebase 到最新的 `upstream/main`，再 `git push --force-with-lease`（PR 分支只有你在用）。
- 新功能尽量放进**新文件**（新的 provider 模块、新的设置页），对上游热点文件只做"加一行注册"式的改动，PR 好审，fork 里也好合。
- 如果 i18n 只能做在 fork 里：它要改遍所有界面文件，之后上游每改一处界面文案都会冲突。所以要**一次性集中做完**，然后高频合并上游，冲突都是机械性的。

## 7. 本机环境准备

| 依赖 | 状态 | 安装方式 |
|---|---|---|
| Node.js | v26.9.0 ✅ | — |
| Xcode | 已装 ✅（clang 21） | — |
| Rust | 1.99.1 ✅（2026-11-01 装） | rustup 的 `minimal` 配置加 `rustfmt`、`clippy`：`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal`，再 `rustup component add rustfmt clippy` |
| CMake | 4.4.5 ✅（whisper.cpp 需要） | `brew install cmake` |
| Ninja | 1.13.2 ✅（编译更快） | `brew install ninja` |

rustup 在 `~/.zshenv` 和 `~/.profile` 里各加了一行 `. "$HOME/.cargo/env"`，新开的终端里直接就有 `cargo`。

2026-11-01 已验证：`./build-mac.sh --no-install --bundles app` 能编出原版 `.app`（`--bundles app` 只打 `.app`，跳过 `.dmg`），全新编译约 2 分钟。编出来的 Bundle ID 还是 `com.nexq.app`，改完第 4 节之前不要运行或安装它。
