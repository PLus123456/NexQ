# NexQ Plus 中文译法待校对

各包会话翻译时拿不准、想请你定的用词，汇总在这里（原文在各包的交接笔记里，2026-11-01）。觉得哪个不对，直接告诉我改成什么，我统一替换。

## 地基（P0）：侧栏、托盘、关于页、语言目录


- 侧栏：分组"会议 / 服务商 / 智能 / 系统"；"AI 模型""语音识别""翻译""AI 动作""上下文策略""AI 场景""降噪预设""置信度""快捷键""通用""关于"。
- `about.tagline`：AI 会议助手与实时面试辅助。
- `general.behavior.title`：行为；`general.autoSummary.label`：自动会议总结；`shell.runWizard`：重新运行首次设置；`shell.back`：返回主窗口；底栏（footer）；"Toggle X" 的读屏文字统一为"切换X"。
- `about.credit`：中文写"基于 naxhq/NexQ（MIT 许可证）开发，原版权 © 2026 Vahid Alizadeh"，英文是 "Based on NexQ by Vahid Alizadeh (MIT License)"（英文没有 © 行，要的话改 en 值）。
- 托盘：开始会议、结束会议、麦克风静音、系统音频静音、共享屏幕时隐藏、隐藏悬浮窗、显示悬浮窗、复制最新的 AI 回答、复制待办事项、复制会议总结、复制转写记录、设置、退出 NexQ Plus；提示"NexQ Plus — 空闲 / 录音中（麦克风已静音） · 已进行 MM:SS / AI 处理中… / 正在建立索引…"。
- 语言目录：`zh` 是"中文"（原翻译列表叫 "Chinese (Simplified)"），`zh-CN` 是"简体中文"，`zh-TW` 是"繁体中文"。
- macOS 权限弹框（`Info.plist`）：麦克风、系统录音、语音识别三条中文说明。

## AI 模型（P1）

- 接口地址（Base URL）、接口协议、任务路由 / 按任务选模型、跟随“默认”、实际使用、高频、填入“关闭/降低思考”、完整对话地址、兼容选项、识别推理内容、请求用量统计、AI 回答语言、推理强度（effort）、扩展思考、快速 / 深度、首字延迟、测试版（Beta）、"仍然保存，稍后再测"。

## 语音识别（P2）

- 引擎名"远程 Whisper（OpenAI 兼容）"在卡片上会被截断（悬停能看全名）。
- Endpointing / endpoint delay 译成"断句（Endpointing）/ 断句延迟"，因为"端点"已经用来指 HTTP 端点。
- "Tell remote speakers apart"：区分远端说话人。
- System loopback：系统回环（内录）。
- 卡片徽标：无 Key / 已存 Key / 无地址 / 未测试。
- 状态栏的 streaming：生成中；本地模型的 Activate：启用。
- 预设：免费、对方用 Soniox、最佳质量、完全离线、全部云端、仅本地（Whisper）、现场会议（In-Person；术语表里同室模式的 Room 是"现场"）。
- 英文原文有几处小改：Whisper.cpp 的说明不再写"batch"；Parakeet 去掉了"(Best Local)"；横幅里的 NexQ 换成 `{{appName}}`；"Loading..." 改成 "Loading…"。

## 翻译（P3）

- 悬浮窗：线上 / 现场（模式徽标，原文 ONLINE / IN-PERSON）、录音（REC）、只看 AI 面板 / 只看字幕 / 并排显示、共享屏幕时已隐藏 / 可见、最小化到主窗口、全部翻译。
- 字幕面板："原文 / 译文"（字号和颜色那一行，原文是 Text / Translation）、"回到最新"、"静音：对方"。
- 翻译设置："识别引擎直接翻译 / 翻译服务 / 不翻译"、"服务地址（可选）"、"实际请求地址"、"消息模板"、"术语表"、"翻译前的等待时间"、"会议开始时自动翻译"。
- 服务商说明：微软"每月免费 200 万字符"、谷歌"每月免费 20 美元额度"、DeepL"每月免费 50 万字符"（原文 2M free/mo 等）。
- LLM 默认提示词是英文（发给模型的，不翻译）。

## 个人知识库（P4）

向量化服务（embedding）、文本块、建立索引 / 更新索引 / 重建索引 / 清空索引、需要重建、向量检索可用 / 只有关键词检索、复用 N 块、混合 / 仅语义 / 仅关键词、最低相似度、语义权重、分块大小 / 分块重叠、接口类型（OpenAI 兼容 / Ollama 原生）、随请求发送维度（dimensions）、"文档内容会发送到 {host} 做向量化"、模板名（硅基流动、阿里云百炼（DashScope）、智谱开放平台、火山方舟、本机 Ollama）。子代理那边：徽标"新文件"、"智能检索已启用"、"检索模型"（也可叫"向量化模型"）、"Token 预算"、"已用 5.3k / 16.0k token（33%）"、"职位描述""系统提示词"、"松开即可上传"、"重新建立索引失败，请移除该文件后再重新添加"；测试检索的 5 个示例问题已改成跟随界面语言（中文界面用中文问题）。

## 首次设置（P5）

- 步骤名：界面语言、AI 模型、语音识别、翻译、音频检查、完成；状态：已完成、已跳过、失败、未完成、未开始。
- "跳过剩余步骤""已从上次离开的地方继续""检查一下设置""测试通过后才能继续；暂时不配置可以先跳过，之后在设置里修改。"
- 音频：自动识别音频来源、默认输出设备（内录）、麦克风测试、**对方声音测试**、开始测试、停止（N 秒）、"现在播放一段声音（视频或音乐都行），并保持播放…"、"没有采集到系统声音。"、"可以检查这些："、"系统设置 → 隐私与安全性 → 屏幕与系统录音 里允许 NexQ Plus（需要 macOS 14.2 及以上）。"、打开麦克风权限设置、打开系统录音权限设置。
- 完成页：开会前检查、可以用 / 缺少 API Key / 模型还没下载 / 这台电脑上不能用 / 只能识别麦克风 / 无法确认、"两路语音识别都还不能用，开会也不会有字幕。先配置一个识别引擎，或者先进入主窗口。"、去设置语音识别、个人知识库、上传简历、检索和向量化设置、开始会议、进入主窗口。
- 通用设置：首次设置、"重新走一遍界面语言、AI 模型、语音识别、翻译和音频检查。立即打开，现有设置会保留。"、重新运行、"会议结束后才能重新运行。"
- 快捷键表里的 AI 动作模式名（要和 P6 翻 AI 动作页时一致）：唤起 AI 助手、“怎么说”模式、“精简”模式、“追问”模式、“回顾”模式、“提问”模式。
- `meetingFlow`：本地语音识别不支持说话人分离，所有发言都会标为“现场”。／音频采集失败：…／会议没能在数据库里结束，仍在进行中，请再按一次“结束”。

## 其余界面（P6）

### 0. 已定的统一用词

- **AI 动作的按钮短名**：助手 / 怎么说 / 精简 / 追问 / 回顾 / 提问；**模式短标签**：总结 / 待办 / 书签 / 问会议（`misc:actionNames.*`、`misc:modes.*`）。
- **我 / 对方 / 现场**（You / Them / Room），**在线 / 现场**（Online / In-Person 会议模式）。
- **说话人**（不用“发言人”“说话者”），**转写记录**（Transcript），**片段**（Segment），**会议总结 / 总结**（Summary），**待办事项**，**书签**，**话题**。
- **悬浮窗**（Overlay），**主窗口**（Launcher），**场景**（Scenario），**降噪预设**，**置信度**，**共享屏幕时隐藏**，**AI 调用日志**。
- **提示词 / 系统提示词**（Prompt / System Prompt），**上下文窗口 / 转写窗口**，**自动触发**，**附加指令 / 自定义指令**，**知识库 / 知识库文本块**（RAG / Chunks）。
- 产品名一律 `{{appName}}`（显示为 “NexQ Plus”）；logo 文字、alt 用 `APP_NAME`。
- 日期、数字走 `formatDate()` / `formatNumber()`；中文用 24 小时制，相对时间“刚刚 / N 分钟前 / N 小时前 / N 天前”。

### 1. 通用词和全应用的统一用词

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `common:labels.inPerson` | In-Person | 现场 | 与“我 / 对方 / 现场”里的 Room 同一个词；方案正文把这个模式叫“同室”。备选：线下、面对面。P2 的 `presets.ts` 里也有 “In-Person”，请对齐。 |
| `common:labels.online` | Online | 线上 | 与“现场”对举。原来是“在线”，独立校对认为像账号的在线状态，改成“线上”。 |
| `common:time.thisWeek` | This Week | 本周 | 术语表定的。实际逻辑是“2–6 天前”，周一看到“本周”可能是上周的会；备选“近 7 天”。 |
| `common:actions.reset` | Reset | 重置 | 与已有的“恢复默认”（`actions.resetDefaults`）区分：这个是单项重置。 |
| `common:actions.rename` | Rename | 重命名 |  |
| `misc:actionNames.assist` | Assist | 助手 | 内置 AI 动作的按钮短名，悬浮窗和设置页都用。 |
| `misc:actionNames.whatToSay` | Say | 怎么说 | Say → 怎么说（原文 Say 是“说什么”）。 |
| `misc:actionNames.followUp` | F/U | 追问 | F/U → 追问。 |
| `misc:modes.meetingSummary` | Summary | 总结 | 短标签用“总结”；文档里的小节标题用术语表的“会议总结”。 |
| `misc:modes.meetingAsk` | Ask meeting | 问会议 | 按术语表“问这场会议”缩短。 |

### 2. 悬浮窗

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `overlay:question.assist` | Assist | 帮我回答 | 检测到问题的卡片上的按钮。原来译成“助手”，单写像名词而不像按钮，改成动词短语。备选：解答、AI 回答。 |
| `overlay:scope.label.default` | Action default | 按动作默认 | 作为范围标签用“按动作默认”（每个动作用自己的默认转写时间窗）。 |
| `overlay:scope.label.sinceLastSame` | Since last same | 上次同一动作以来 | 原文是被截短的标签，补全了“动作”。 |
| `overlay:scope.optionHint.sinceLastAny` | New talk since any answer | 最近一次回答（不限动作）后的新发言 | 原文 “since any answer” 有歧义，按“最近一次回答（不限动作）”理解。 |
| `overlay:scope.sticky.label` | Keep for next actions | 后续动作继续沿用 | 开关，关闭时芯片显示“· 仅一次”。 |
| `overlay:scope.dialog.heading` | Focus the next answers on | 让后续回答聚焦于 | 后面接选项列表。 |
| `overlay:scope.actionHint.sinceLastSame` | since last {{action}} | 上次“{{action}}”以来 | 动作名可能是中文（追问）也可能是用户起的英文名，用引号包住。 |
| `overlay:progress.phase.waiting` | Waiting for the first words… | 等待 AI 开始回答… | 意译，没用“首字”。 |
| `overlay:progress.phase.writing` | Writing… | 生成中… | 与 `misc:streamLatency.writing` 同用“生成中”。 |
| `overlay:response.timing.firstWords` | first words {{duration}} | 首字延迟 {{duration}} | 术语表：首字延迟（调用日志同）。标题行较长，行内会截断。 |
| `overlay:speakerStats.words` | {{words}}w | {{words}} 词 | 数的是按空格切出的“词”，中文发言数字会偏小（逻辑问题，见 handoff）。 |
| `overlay:speakerNaming.merge.heading` | Actually this is... | 其实这是… | 后面是已有说话人的按钮。 |
| `overlay:speakerNaming.name.placeholder` | e.g. Professor Smith | 例如：王教授 | 示例换成中文名。 |
| `overlay:scope.note.settings` | Each action's window is set in <settings>Settings → AI Actions</settings>. | 每个动作的转写时间窗可在<settings>设置 → AI 动作</settings>中调整。 | “设置”和“设置 →”重复，所以用“调整”。 |

### 3. 设置页

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `settings:aiActions.style.tone.options.casual` | Casual | 轻松 | 备选：随意。 |
| `settings:aiActions.style.perspective.options.addTake` | Add my take | 附上 AI 观点 | 原文的 “my” 指 AI 自己（回答里会出现 “## My Take” 小节），直译“我的观点”会被误读成用户的观点。 |
| `settings:aiActions.style.format.options.oneliner` | One-liner | 一句话 | 备选：单行。 |
| `settings:aiActions.style.format.options.bullets` | Bullet Points | 要点列表 | 备选：项目符号。与“编号列表”成对。 |
| `settings:aiActions.style.active` | Active | 生效中 | 预设下面那行摘要的小标题。该摘要整行也翻成了中文（`aiActions.style.summary.*`）；它只用于显示，真正发给 AI 的指令没动。 |
| `settings:aiActions.card.overrides.title` | Override Defaults | 覆盖默认值 | 备选：单独设置。 |
| `settings:aiActions.cliUnused.hint` | Not used with Claude CLI | 使用 Claude CLI 时不生效 | 比“Claude CLI 不使用此项”更好懂。 |
| `settings:aiActions.card.sources.webSearch` | Web Search | 联网搜索 | 备选：网页搜索。 |
| `settings:aiActions.instructions.tokenCount` | ~{{count}} tokens | 约 {{count}} 个 token | token 保留英文，加量词“个”。 |
| `settings:aiActions.ragChunks.hint` | Document chunks per query are controlled by "Results to Retrieve (top-K)" in Context Strategy. Per-action overrides available in each action's Override Defaults. | 每次查询使用的知识库文本块数量，由“上下文策略”里的“检索条数（Top-K）”决定。每个动作也可以在自己的“覆盖默认值”里单独设置。 | 引用了“上下文策略”和“检索条数（Top-K）”（卡片里的 `aiActions.card.overrides.ragTopK` 也用这个名字）：P4 合并后请和 ContextStrategySettings 的译文核对。 |
| `settings:aiActions.autoTrigger.help` | When enabled, {{appName}} listens for questions directed at you during the meeting and automatically generates suggested answers. ⏎  ⏎ Turn OFF during presentations or when you want manual-only control. You can still trigger actions manually with the overlay buttons. | 开启后，{{appName}} 会在会议中留意别人向你提出的问题，并自动生成建议回答。 ⏎  ⏎ 做演示，或者想完全手动控制时，请关闭。你仍然可以通过悬浮窗上的按钮手动触发动作。 | 长说明，注意“做演示，或者想完全手动控制时，请关闭”这句是对原文 “Turn OFF during presentations” 的意译。 |
| `settings:hotkeys.actions.toggleAssist` | Toggle AI Assist | 调用 AI 助手 | 原文是 Toggle，但 Space 实际是跑一次 Assist，按功能译，动词与“在任意应用中调用 AI 助手”统一；想直译可改“切换 AI 助手”。 |
| `settings:hotkeys.actions.escape` | Escape / Cancel | 关闭 / 取消 | macOS 中文里“退出”指退出应用，Esc 实际是关闭或取消，所以用“关闭 / 取消”。 |
| `settings:hotkeys.table.action` | Action | 操作 | 避开“动作”（AI 动作）这个词。 |
| `settings:meetingDetection.label` | Detect meetings | 会议检测 | 与关于页里已有的“会议检测弹窗”一致。 |
| `settings:meetingDetection.startAs.label` | Start as | 默认场景 | 对应字段 default_scenario，意译。 |
| `settings:meetingDetection.dismiss.label` | Hide the prompt after | 提示显示时长 | 选项是“30 秒 / 1 分钟…”，倒过来说更顺。 |
| `settings:meetingDetection.check.label` | Check for calls | 检测频率 | 选项是“每 2 秒”。 |
| `settings:meetingDetection.apps.slack` | Slack huddles | Slack Huddle | Slack 中文界面保留 Huddle。 |
| `settings:noisePresets.metrics` | VAD {{sensitivity}}% · Gate {{gate}} dB | VAD {{sensitivity}}% · 门限 {{gate}} dB | 卡片上的小字，尽量短：只写 VAD 和“门限”（原文 Gate）。VAD = 语音活动检测。 |
| `settings:stealth.assist.label` | Assist from any app | 在任意应用中调用 AI 助手 |  |
| `settings:scenarios.actions.createCustom` | Create Custom | 新建自定义场景 | 原文省略了 scenario，补全。 |
| `settings:scenarios.actions.clone` | Clone | 复制 | “克隆”在中文界面里不自然；副本后缀对应“（副本）”。 |
| `settings:scenarios.copyName` | {{name}} (copy) | {{name}}（副本） | 新建时按当时的界面语言存盘，之后切换语言不会跟着变。 |
| `settings:confidence.toggle.label` | Highlight Low Confidence | 高亮低置信度字词 | 原文两端写的是“0%（始终）/100%（从不）”，和说明相反，这是上游原文问题，译文照原文对应。 |

### 4. 主窗口和会议详情

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `launcher:main.filter.withSummary` | Summary | 有总结 | 筛选“只看有总结的会议”，单写“总结”看不出是筛选。 |
| `launcher:main.deleteAll.title` | Delete All Meetings | 删除所有会议？ | 弹窗标题，按“确认弹窗用问句”加了问号（英文没有）。 |
| `launcher:main.activeMeeting.return` | RETURN | 返回会议 | 紧贴在会议标题旁边的胶囊，单写“返回”像后退。 |
| `launcher:main.rag.build` | Build Knowledge Base | 建立知识库 | 对应术语表“建立索引”；备选：构建知识库。P4 译“个人知识库”时请核对用词。 |
| `launcher:main.sources.title` | Sources ({{total}}) | 来源（{{total}}） | 已添加文件的列表，备选：资料。 |
| `launcher:main.toast.endSaveFailed` | Couldn't finish saving the meeting — new meeting not started | 会议没能保存完，没有开始新会议 | 与通用的“会议没能保存完”同口径。 |
| `launcher:setup.saved.forget` | Forget | 清除 | “忘记”太直译；同行 title 是“清除已保存的偏好设置”。 |
| `launcher:setup.rec` | REC | 录音 | 徽标；也可保留 REC。 |
| `launcher:setup.recording.label` | Record Audio | 录制音频 | 开关的标题，用动宾短语。 |
| `launcher:setup.audioMode.onlineHint` | Mic + system audio | 麦克风 + 系统音频 | “系统声音”还是“系统音频”，看 P2 的用词。 |
| `launcher:header.stats.words` | Words | 词数 | 代码按空白切词；想更贴近 Pages 等软件可改“字数 / 字”，但中文数字仍然不准。 |
| `launcher:tabs.ask` | Ask | 问会议 | 与 getModeLabel("MeetingAsk") 的“问会议”一致；备选：提问。 |
| `launcher:tabs.aiLog` | AI Log | AI 日志 | 本场会议的 AI 交互记录，没有用“AI 调用日志”（那是另一个功能）。 |
| `launcher:ask.suggestions.decided` | What was decided? | 做了哪些决定？ | 三条建议问题点击后会作为问题发给 AI 并存进问答记录，所以译成了中文问句。想永远发英文，把 `onPick(t(key))` 改回原文。 |
| `launcher:ask.input.placeholder` | Ask about this meeting… | 就这场会议提问… | “问这场会议”是功能名，输入框里用了更完整的句式。 |
| `launcher:row.bookmark.add` | Bookmark this line | 为这一行添加书签 | P3 悬浮窗里同一句译成“给这一行加书签”，这里按术语表用“添加书签”。 |
| `launcher:bookmarks.suggestions.title` | AI Suggestions | AI 推荐 | 统一用“推荐”，没用“建议”。 |
| `launcher:export.options.json.description` | Structured data export | 结构化数据 | 菜单副标题，宽度有限。 |
| `launcher:actionItems.empty.tooltip.busy` | Wait for AI | AI 正在处理，请稍候 | 悬停提示，说明为什么现在按不了。 |
| `launcher:speakers.empty.hint` | Speaker data appears after meetings with diarization | 启用说话人分离的会议才会有说话人数据 | 意译。 |
| `launcher:actionItems.copy.heading` | # Action Items — {{title}} | # 待办事项：{{title}} | 复制到剪贴板的 Markdown 抬头，破折号改成冒号。 |

### 5. AI 调用日志

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `calllog:entry.sources.transcript.label` | T | 转 | 来源小徽标的缩写字母（T/R/I/Q）换成中文首字：转 / 库 / 指 / 问，悬停提示是完整词。 |
| `calllog:entry.sources.rag.label` | R | 库 |  |
| `calllog:entry.sources.rag.title` | Document Excerpts | 知识库文本块 | 与设置里 “RAG Chunks → 知识库文本块” 同一个叫法。 |
| `calllog:panel.stats.avgResponse` | Avg response | 平均耗时 | 标签位置窄，4 个字最合适；备选：平均延迟 / 平均响应。 |
| `calllog:entry.latency.titleWithFirst` | Answered in {{total}} — first words after {{first}} | 回答耗时 {{total}}，首字延迟 {{first}} | first words 按术语表对应“首字延迟”。 |
| `calllog:prompt.tokens.actual` | Actual: | 实际用量： | 对应下一行“≈ 估算”；备选：实际： |
| `calllog:stats.usage.cacheRead` | {{tokens}} cached | 缓存命中 {{tokens}} | 对应 cache_read；整行成“输入 4,200（缓存命中 4,000 · 缓存写入 190） · 输出 189（思考 151） · ≈$0.0093”。 |
| `calllog:prompt.tokens.scope` | Scope: | 转写范围： | 值是悬浮窗里选的“转写范围”，叫法与悬浮窗一致。 |
| `calllog:prompt.rag.noneFoundDetail` | — {{count}} candidates below threshold | —— 有 {{count}} 个候选低于阈值 | 前接 JSX 里的空格，所以用破折号而不是括号。 |
| `calllog:panel.export.translatedTxt` | Translated transcript (.txt) | 翻译后的转写记录（.txt） | 与“双语转写记录”对称。 |
| `calllog:entry.stalled` | No response yet | 暂无响应 | 红色小字，要短。 |
| `calllog:panel.clearAll` | Clear all | 全部清除 | 垃圾桶图标的悬停提示；备选：清空日志。 |

### 6. 零散组件、窗口和导出文档

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `misc:meetingPrompt.startButton.label` | Start {{appName}} | 开始 {{appName}} | 测试用 `/Start NexQ/` 匹配，所以 en 保持 “Start {{appName}}”；中文保持同构。备选：用 {{appName}} 开始。 |
| `misc:meetingPrompt.typeMenu.heading` | Start as | 选择场景 | 弹窗里选的就是“场景”（设置页叫“默认场景”），所以三处都用“场景”；原文叫 Meeting type。 |
| `misc:meetingPrompt.consent.hint` | Let everyone know the meeting is being transcribed. | 记得告诉大家，这场会议正在转写。 | 提醒用户告知与会者，不是命令口吻。 |
| `misc:streamLatency.writing` | Writing {{seconds}} s | 生成中 {{seconds}} 秒 | 备选：输出中。 |
| `misc:audioPlayer.download.label` | Download recording | 下载录音 | 实际是另存为本地文件，也可用“导出录音”。 |
| `misc:hooks.meetingStats.duration.hoursMinutes` | {{hours}}h {{minutes}}m | {{hours}} 小时 {{minutes}} 分 | 统计栏里要紧凑，“分”不带“钟”。 |
| `misc:colorPicker.colors.warm` | Warm | 暖灰 | #d6d3d1 是偏暖的浅灰。 |
| `misc:colorPicker.colors.teal` | Teal | 蓝绿 | Cyan 用了“青色”，所以 Teal 用“蓝绿”区分。 |
| `misc:export.docs.heading` | {{kind}} — {{title}} | {{kind}}：{{title}} | 导出的文档标题，与待办复制的抬头同口径（冒号）。 |
| `misc:export.headings.agendaItems` | Agenda Items | 议程 | 备选：议程事项。 |
| `misc:export.headings.followUpActions` | Follow-Up Actions | 后续行动 | 备选：后续待办。 |
| `misc:export.headings.keyTakeaways` | Key Takeaways | 核心要点 | 下面放的是 AI 总结。 |
| `misc:export.attendeeSeparator` | ,  | 、 | 参会人员名单的顿号分隔；en 值是 “, ”（逗号后有空格），编辑 JSON 时别被编辑器吃掉行尾空格。 |
| `misc:endMeetingSave.unsavedTranscript` | {{count}} transcript lines could not be saved. The meeting is still open — press End again. | 有 {{count}} 行转写内容没能保存。会议还没结束，请再点一次“结束”。 | 会原样显示在 toast 里；里面的“结束”要和语音识别包的 StatusBar End 按钮译法一致。 |

### 7. 独立校对后改过的译法

子代理译完后，我又让一个 Opus 子代理独立通读了全部新增译文（835 条）：没有发现误译或语义反了的问题，提了 25 条改进和 9 处术语不一致，下面是采纳并已改在 JSON 里的（“现译文”取自文件）。

| key | 原译文 | 现译文 | 理由 |
|---|---|---|---|
| `settings:aiActions.actions.descriptions.followUp` | 建议你可以向其他参会者提出的问题 | 推荐你可以向其他参会者提出的问题 | “建议”后面接名词短语，句子缺动词 |
| `settings:aiActions.card.sources.customInstructions` | 自定义指令 | 附加指令 | 同一个输入框在设置页叫“附加指令”，统一（`promptPreview.sections.customInstructions`、`calllog:entry.sources.instructions.title` 同改） |
| `settings:aiActions.transcriptWindow.label` | 转写窗口 | 转写时间窗 | 应用里“窗口”都指界面窗口（悬浮窗 / 主窗口），改称“时间窗”（`overlay:scope.optionHint.default`、`scope.note.settings` 同改） |
| `settings:promptPreview.sections.window` | （{{seconds}} 秒窗口） | （最近 {{seconds}} 秒） | “秒窗口”生硬；`defaultWindow` 原为“（默认窗口）” |
| `settings:hotkeys.actions.escape` | 退出 / 取消 | 关闭 / 取消 | macOS 里“退出”是退出应用 |
| `settings:hotkeys.actions.modeAssist` | 模式：AI 助手 | 模式：助手 | 与其余五个“模式：”条目的按钮短名一致 |
| `settings:scenarios.actions.resetAll` | 全部恢复 | 全部重置 | “恢复”缺宾语；Reset 统一用“重置”，Reset to default 用“恢复默认” |
| `settings:confidence.threshold.hint` | 低于此分数的字词会被高亮 | 低于此值的字词会高亮显示 | 去掉“被”字句 |
| `settings:stealth.notes.windows` | 需要 Windows 10 2004 或更高版本。 | 需要 Windows 10 版本 2004 或更高版本。 | 两个数字连着容易读错 |
| `settings:aiActions.card.overrides.ragTopK` | 知识库 Top-K | 检索条数（Top-K） | 与 ragChunks.hint 里的名称“检索条数（Top-K）”统一 |
| `overlay:response.empty.hint` | 按 Space 获取 AI 协助 | 按 <kbd>Space</kbd> 调用 AI 助手 | “获取协助”生硬，“AI 协助”不在术语表里 |
| `overlay:scope.label.default` | 动作默认 | 按动作默认 | 作为范围标签，“动作默认”不成词 |
| `misc:shortcuts.stealth.failed` | 更改共享屏幕时的可见性失败：{{detail}} | 无法切换“共享屏幕时隐藏”：{{detail}} | 照搬英文句式，读起来绕 |
| `misc:scenarios.lecture.description` | 提炼要点、定义和问答 | 提炼核心概念、定义和问答 | Key concepts 是“核心概念” |
| `misc:meetingPrompt.typeButton.label` | 会议类型：{{type}} | 场景：{{type}} | 选的就是场景（`typeMenu.label`、`typeMenu.heading` 同改：会议类型 / 按以下类型开始 → 场景 / 选择场景） |
| `misc:meetingPrompt.nameInput.placeholder` | {{app}} — 给这场会议起个名字 | {{app}}：给这场会议起个名字 | 半角破折号 |
| `misc:export.labels.attendees` | 参会人员： | 参会者： | 全应用统一用“参会者” |
| `misc:endMeetingSave.unsavedTranscript` | 有 {{count}} 条转写内容没能保存…… | 有 {{count}} 行转写内容没能保存。会议还没结束，请再点一次“结束”。 | 转写内容的量词统一用“行” |
| `launcher:card.audioMode.online` | 在线 | 线上 | 同 `common:labels.online` |
| `launcher:aiLog.empty` | 暂无 AI 交互记录 | 没有 AI 交互记录 | 与 `details.aiLog.empty` 统一用“没有…” |
| `launcher:ask.send.waitTitle` | 请等当前的 AI 任务完成 | 请等待当前的 AI 任务完成 | “请等”偏口语 |
| `calllog:prompt.rag.noRelevantBadge` | 0 个相关 | 无相关文本块 | 缺少中心词 |

独立校对（Opus 子代理）还提了下面几条，我没采纳：

- `launcher:transcript.translation.hide / show`（隐藏翻译 / 显示翻译）想改“译文”：这两个词与 P3 悬浮窗里已定的“隐藏翻译 / 显示翻译”保持一致，避免两个窗口说法不同。
- `settings:stealth.shortcut.hint` 里的“托盘菜单”想改“菜单栏图标”：P0 在 `settings:general.language.hint` 里已用“托盘菜单”，应用也跨平台（Windows 叫托盘），先保持一致。
- `misc:colorPicker.colors.warm`（暖灰）想改“暖白”：色值是 `#d6d3d1`，是偏暖的浅灰，保留“暖灰”。
- `settings:confidence.threshold.always / never`（0%（始终）/ 100%（从不））想按实际行为对调：这是上游英文原文，是否写反要看代码（功能可能根本没接上，见 handoff），译文照原文。

## 旧版 AI 模型兜底页（任务 B，2026-11-02）

用于新版 AI 模型设置不可用时显示的旧页面。除扫描报告中的文字外，一并补齐了状态徽标、当前服务商横幅、动态按钮、占位提示和错误提示的翻译。下面列出全部新增中文用词。

Ollama、LM Studio、OpenAI、Anthropic、Groq、Google Gemini、OpenRouter，以及 Claude Sonnet、Opus、Haiku、Gemini Pro、Flash 均保留原名；关于页的 Tauri 2、React + Rust 也保留原文。品牌字面量使用同一行的 `i18n-ignore` 标记。

复用现有译文：Claude（订阅）、连接、接口地址（Base URL）、API Key、显示 / 隐藏 API Key、无。认证方式的协议值、模型 ID、端口和请求字段不翻译。

| key | 原文 | 现译文 | 备选 / 理由 |
|---|---|---|---|
| `llm:legacy.providers.title` | API & local providers | API 与本地服务商 | Provider 沿用术语表的“服务商”。 |
| `llm:legacy.providers.ollama.description` | Local models via Ollama | 通过 Ollama 使用本地模型 |  |
| `llm:legacy.providers.ollama.hint` | Requires Ollama running on localhost:11434 | 需要 Ollama 在 localhost:11434 运行 |  |
| `llm:legacy.providers.lmStudio.description` | Local models via LM Studio | 通过 LM Studio 使用本地模型 |  |
| `llm:legacy.providers.lmStudio.hint` | Requires LM Studio running on localhost:1234 | 需要 LM Studio 在 localhost:1234 运行 |  |
| `llm:legacy.providers.openai.description` | GPT-4o, GPT-4, etc. | GPT-4o、GPT-4 等 | 只翻译 etc. 并调整标点，模型名保留原文。 |
| `llm:legacy.providers.groq.description` | Ultra-fast inference | 超高速推理 | 备选：极速推理。这里指模型推理服务的速度。 |
| `llm:legacy.providers.openrouter.description` | Multi-provider gateway | 多服务商网关 | 同一个网关接入多个服务商；备选：多服务商接入网关。 |
| `llm:legacy.providers.custom.label` | Custom | 自定义 |  |
| `llm:legacy.providers.custom.description` | Your own endpoint | 你自己的端点 | Endpoint 沿用术语表的“端点”；备选：你自己的服务地址。 |
| `llm:legacy.providers.claudeCli.description` | Your own Claude login (beta) | 使用你自己的 Claude 登录（测试版） | Beta 沿用“测试版”；Claude 保留原文。 |
| `llm:legacy.badges.ready` | Ready | 就绪 |  |
| `llm:legacy.badges.hasKey` | Has Key | 已存 Key | 与语音识别卡片的“已存 Key”统一。 |
| `llm:legacy.badges.noKey` | No Key | 无 Key | 与语音识别卡片的“无 Key”统一。 |
| `llm:legacy.badges.local` | Local | 本地 |  |
| `llm:legacy.badges.notConfigured` | Configure | 待配置 | 状态徽标，按“尚未配置”理解；不是操作按钮。 |
| `llm:legacy.active.title` | Active: {{provider}} | 正在使用：{{provider}} |  |
| `llm:legacy.active.noModel` | — no model selected | （未选择模型） |  |
| `llm:legacy.active.claudeTiers` | Fast: {{fast}} — Deep: {{deep}} | 快速：{{fast}}；深度：{{deep}} |  |
| `llm:legacy.active.hint` | This provider and model will be used for AI responses | AI 回答将使用这个服务商和模型 |  |
| `llm:legacy.active.setupHint` | Select a provider, test connection, and load models below | 请在下方选择服务商、测试连接并加载模型 |  |
| `llm:legacy.active.badge` | Active — {{status}} | 使用中：{{status}} |  |
| `llm:legacy.active.activate` | Set {{provider}} as Active Provider | 将 {{provider}} 设为当前服务商 | 设置为正在使用的服务商；备选：使用 {{provider}}。 |
| `llm:legacy.active.failed` | Couldn't switch the AI provider: {{detail}} | 切换 AI 服务商失败：{{detail}} |  |
| `llm:legacy.apiKey.placeholder` | Enter {{provider}} API key | 输入 {{provider}} 的 API Key |  |
| `llm:legacy.apiKey.hide` | Hide | 隐藏 |  |
| `llm:legacy.apiKey.show` | Show | 显示 |  |
| `llm:legacy.apiKey.storageHint` | Stored securely in your system keychain | 安全存储在系统钥匙串中 |  |
| `llm:legacy.apiKey.saveFailed` | Failed to save API key | 保存 API Key 失败 |  |
| `llm:legacy.custom.title` | Custom Provider | 自定义服务商 |  |
| `llm:legacy.custom.auth.label` | Auth Type | 认证方式 |  |
| `llm:legacy.custom.auth.bearer` | Bearer Token | Bearer 令牌 | Bearer 是认证方案名；Token 在此表示认证令牌，区别于模型的 token 用量。 |
| `llm:legacy.custom.auth.apiKey` | API Key Header | API Key 请求头 | Header 沿用“请求头”；API Key 保留原文。 |
| `llm:legacy.custom.token.label` | Token | 令牌 |  |
| `llm:legacy.custom.token.placeholder` | Bearer token... | 输入 Bearer 令牌… |  |
| `llm:legacy.custom.apiKey.placeholder` | API key... | 输入 API Key… |  |
| `llm:legacy.connection.test` | Test Connection | 测试连接 |  |
| `llm:legacy.connection.success` | Connected successfully | 连接成功 |  |
| `llm:legacy.connection.failed` | Connection failed | 连接失败 |  |
| `llm:legacy.models.title` | Model | 模型 |  |
| `llm:legacy.models.load` | Load Models | 加载模型 |  |
| `llm:legacy.models.placeholder` | Select a model... | 选择模型… |  |
| `llm:legacy.models.context` | ({{size}}K ctx) | （{{size}}K 上下文） | K 保留数量级，ctx 展开成“上下文”；数字和模型 ID 不改。 |
| `llm:legacy.models.loading` | Loading models... | 正在加载模型… |  |
| `llm:legacy.models.hint` | Click "Load Models" to fetch available models | 点击“加载模型”获取可用模型 |  |
| `llm:legacy.models.noText` | No text models found | 未找到文本模型 |  |
| `llm:legacy.models.noChat` | No chat models found (embedding-only models filtered) | 未找到对话模型（已过滤仅用于向量化的模型） | 说明列表已排除仅用于向量化的模型，不是服务商没有任何模型。 |
| `llm:legacy.models.empty` | No models found | 未找到模型 |  |
| `llm:legacy.models.loadFailed` | Failed to load models | 加载模型失败 |  |
