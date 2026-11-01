# NexQ Plus 实施方案

> 基线：`custom` 分支 = 上游 v2.29.1（`14d7b4e`）。调研日期 2026-11-01。文中 `file:line` 对应这个提交。
> 依据：[OVERHAUL_PLAN.md](OVERHAUL_PLAN.md)（痛点和代码位置，本文不重复）、用户自己的 LectureLive（只借鉴设计，见附录 B）、Soniox 官方文档（附录 A）。
> 读者：主会话和各工作包会话。包会话开工前读：第 2 节（全局约定）、第 4 节里自己的包、第 5 节（i18n）、第 6 节（文件归属）。
> 更细的调研记录（字段表、注册点清单、更多行号）在共享笔记目录 `/Users/plus/Library/Application Support/Claude/side-session-notes/local_8d8462f2-96de-40bd-9513-9edc24f93e6a/` 下的 `research-llm.md`、`research-stt-translation.md`、`research-rag.md`、`research-soniox.md`、`research-lecturelive.md`，不在仓库里；和本文冲突时以本文为准。

## 0. 一页结论

**拆成 1 个地基包 + 6 个并行包**，P0 合并后其余六个包同时开工，互相不改同一个文件：

| 包 | 分支 | 内容 | M1 粗估 |
|---|---|---|---|
| **P0 地基** | `plus/p0-foundation` | 身份隔离（Phase 0）、i18n 框架和外壳页、共享契约和桩（端点规则、`llm::api` 接口、STT 元数据、语言目录、模型输入框等公共组件、首次设置占位组件）、悬浮窗重复翻译的一行修复 | 0.5 人日，可拆两个会话 |
| **P1 LLM** | `plus/p1a-llm-backend`、`plus/p1b-llm-frontend` | 多连接、手填模型、按任务选模型、去掉长时间持锁、报错不再被吞、中文流式乱码、Mac 上 Claude 登录、AI 回答语言 | 2.5–3 人日，**拆前后端两个会话** |
| **P2 语音识别** | `plus/p2-stt` | 远程 STT（OpenAI 兼容）、Soniox 引擎、"我/对方"分开设识别语言和自动检测、whisper.cpp 开 Metal、STT 相关 bug | 2 人日 |
| **P3 翻译** | `plus/p3-translation` | 目标语言自填、服务地址可改、LLM 翻译走任务路由、提示词和术语表可改、选择翻译哪一路、显示 Soniox 译文、合并行译文 | 1.5 人日 |
| **P4 个人知识库** | `plus/p4-rag` | 自定义 embedding 端点、独立索引库、快速向量检索、中文混合检索、增量索引；M2 可选 rerank | 2 人日 |
| **P5 首次设置** | `plus/p5-onboarding` | 新流程、每步实测、进度保存、"上传简历" bug | 1 人日 |
| **P6 中文扫尾** | `plus/p6-i18n-sweep` | 不归前面任何包的约 60 个界面文件全部中文化 | 1–1.5 人日 |

粗估按"有 AI 协助、集中投入"算（和 OVERHAUL_PLAN 同口径），合计约 12 人日；7–8 个会话并行，墙钟时间约 1.5–2 天。关键路径是 P1 和 P2。

**顺序**：11-01 晚做完并合并 P0 → 11-02 起 P1–P6 并行 → 每个包完成 M1 就按 P1、P2、P3、P4、P5、P6 的推荐顺序合并（不是硬依赖，谁先好谁先合）→ 11-03 集成、打包、用户试用。每个包分 M1（第一版必须有）和 M2（尽量进第一版）。

**几个关键决定**：

- **Soniox 做成识别引擎**，"我"和"对方"各开一个会话；译文沿用现有的 `translation_result` 事件进入显示链路。翻译设置决定每一路的译文来自 Soniox 还是翻译管线。
- **LLM 连接配置由 Rust 拥有**，按任务路由。其他包只调用 P0 定好的 `llm::api`（`resolve_for_task`、`complete_text`、`resolve_connection`），不碰 LLM 包的文件；P1 合并前，这个接口的桩沿用现在的全局模型。
- **端点地址不自动补 `/v1`**：Base URL 原样 + 固定路径，界面实时显示最终请求地址，另有完整地址覆盖（2.5 节）。
- **热点文件**：新代码进新文件，热点文件只在锚点加一行；`configStore.ts` 归 P2、`ServiceStatusBar.tsx` 归 P1、`App.tsx` 按代码块分给 P3 和 P5（2.3 节）。
- **i18n**：命名空间按包拆成独立 JSON，`en` 逐字保留原英文、测试固定用 `en`，所以现有测试不用改（第 5 节）。
- **第一版里 RAG 向量化和首次设置重做都能进**，各自留了 M1/M2 的退路（第 1 节）。

**待你拍板**：5 个问题见第 9 节，都有默认值，不回答也按默认推进。

## 1. 第一版做什么、之后做什么

| 需求 | 第一版（11-03 前能装）| 之后再做 |
|---|---|---|
| 1 中文界面 | i18next 框架、两个窗口同步切换、托盘中文；前端所有界面文案中文化 | Rust 侧错误改成错误码再翻译；中文默认提示词；把框架拆 PR 给上游 |
| 2 识别语言、字幕、翻译 | "我/对方"分开设识别语言、可自填代码、自动检测；翻译目标语言自填；DeepL / Microsoft / Google 地址可改；可选翻译哪一路；LLM 翻译走任务路由选的连接和模型，提示词和术语表可改；合并显示的行能看到每一段的译文 | 字幕"仅译文"模式；悬浮窗里改目标语言；段落变长时只翻增量；数据库唯一键加上服务商；DeepL 术语表 API |
| 3 LLM | 多个连接（OpenAI 兼容 / Anthropic / Gemini / Ollama）、Base URL 任意路径、认证方式、自定义请求头、模型参数；模型手填（列表只作候选）；AI 助手、会议总结、实时翻译、历史会议问答等各选各的连接和模型；翻译和 AI 助手能并发；报错原样显示 | 服务商模板补全（价格、上下文长度）；完整的思考模式换算；连接导入导出；用量统计 |
| 4 远程 STT | OpenAI 兼容 `/audio/transcriptions`，地址、模型、Key（可选）可配，接 faster-whisper-server / speaches、vLLM、LocalAI | "我/对方"用不同的远程服务器；通用 WebSocket 流式协议（FunASR 等）|
| 5 Soniox | 实时识别 + one_way 翻译，两路各一个会话；区域、模型（候选 + 手填）、端点延迟、说话人分离可配；断线重连 | 同室模式的 two_way；`context` 填会议信息和术语；290 分钟主动换会话；临时 Key |
| 6 RAG 向量化 | M1：自定义 OpenAI 兼容 embedding 端点（地址、Key、模型、维度）、独立索引库、快速向量检索、中文全文 + 向量混合检索、按内容哈希增量索引、换模型后提示重建且绝不混用新旧向量；M2：可选 rerank、复用 LLM 连接、取消和会议中降速 | 近似最近邻索引（50 万块以上）、文件夹导入和监视、本地 ONNX 嵌入、性能压测 |
| 7 首次设置 | M1：新流程第 1–4 步（接各包的快速设置组件）、进度保存、"上传简历"修好；M2：系统音频测试和权限指引、完成前检查、设置里重跑不用重启 | 配置导入/导出、恢复默认 |
| 8 身份隔离 | 全部（3.1）| 自己的更新签名和发布 CI（Phase 5）|
| 9 已知 bug | 全部 7 个（3.9）| — |

做不进第一版的情况只有一种：某个包到 11-03 中午还没完成 M1。那就先不合它，功能保持上游原样，顺延到下一版。

## 2. 全局约定（所有包都要遵守）

### 2.1 分支和 worktree

- P0 合进 `custom` 之后，每个包从最新的 `custom` 拉自己的分支（`plus/p2-stt` 这类，见第 4 节），在独立 worktree 里开发，做完由主会话合回 `custom`（`git merge --no-ff`）。
- 不碰 `main` 和 `test/claude-login-windows-only`，不往 `upstream` 推任何东西。
- 包之间不互相合并、不 rebase 到别的包分支。需要别的包的接口时，用 P0 预留的桩（第 4.1 节"契约"），或在共享笔记目录里登记，集成时处理。
- 提交用 Conventional Commits，作用域写子系统名（`feat(llm): …`、`fix(stt): …`）。描述可以用中文。
- **P0 合并之前谁都不要运行编出来的 App**（Bundle ID 还是 `com.nexq.app`，会和官方版共用数据和钥匙串）。P0 合并之后的构建是 `com.plus.nexq`，可以 `npx tauri dev` 手动测。
- 每个 worktree 有自己的 `src-tauri/target`（约 6 GB，首次编译几分钟），磁盘够（剩余 700 GB 以上）。不要共用 `CARGO_TARGET_DIR`，不同分支互相覆盖会反复重编。
- 新 worktree 开工前先准备依赖。`src-tauri/ort/` 被 gitignore 了，但 `tauri.macos.conf.json` 把 `ort/libonnxruntime.dylib` 列为打包资源，缺了它 Rust 侧编译不过。从主工作目录复制一份最快（也可以跑 `node scripts/fetch-onnxruntime.mjs` 重新下载）：

```bash
npm ci
```

```bash
cp -R /Users/plus/NexQ/src-tauri/ort src-tauri/
```

### 2.2 新代码放在哪

| 内容 | 位置 |
|---|---|
| 前端新类型、新 IPC 包装 | `src/lib/<域>/types.ts`、`src/lib/<域>/ipc.ts`（域 = `llm`、`stt`、`translation`、`rag`、`onboarding`）|
| 前端新 store | `src/stores/` 下的新文件（如 `llmConnectionsStore.ts`）|
| 前端新设置组件 | `src/settings/<域>/` 子目录 |
| 公共组件 | P0 建在 `src/components/` 下的 `ModelCombobox`、`LanguageCombobox`、`EndpointFields`，合并后冻结（要改先登记）|
| Rust 新模块 | 所属子系统目录下的新文件（如 `src-tauri/src/llm/connections.rs`、`src-tauri/src/stt/soniox.rs`）|
| Rust 新命令 | 新文件 `src-tauri/src/commands/<名字>_commands.rs` |
| Rust 新的全局状态 | 独立类型 + `app.manage(...)`，**不加进 `AppState`** |
| 数据库迁移 | 第一版不需要（见 2.3 的 `migrations.rs` 一行）；RAG 的表在自己的 `rag.db` 里自己管 |
| 界面文案 | `src/i18n/locales/{en,zh-CN}/<命名空间>.json`（第 5 节）|

仅 fork 用的东西名字里带 `plus`（迁移函数前缀 `plus_`、锚点注释 `// == PLUS …`），以后拆 PR 给上游时一眼能分出来。

### 2.3 热点文件规则

这些文件上游改得最勤、各包都可能想动。规则的目的：每个包对热点文件的改动都落在**互不相邻**的位置，git 能自动合并；真冲突时有明确的裁决方。

| 热点文件 | 规则 | 冲突时以谁为准 |
|---|---|---|
| `src/lib/types.ts` | 新类型放 `src/lib/<域>/types.ts`。只允许改**本包分节**里已有的类型（分节归属见第 6.2 节），不动文件头和别的分节 | 分节归属的包 |
| `src/lib/ipc.ts` | 新命令的包装放 `src/lib/<域>/ipc.ts`。**不改顶部的 `import type {…}` 块**（所有包都会撞在这里）。只改本包分节里已有的函数，尽量不改签名 | 分节归属的包 |
| `src/lib/events.ts` | 同 `ipc.ts`：新事件的监听包装放 `src/lib/<域>/events.ts`，不改顶部 `import type` 块，只改本包分节（归属见 6.2 节）| 分节归属的包 |
| `src-tauri/src/lib.rs` | 只允许三类改动：① P0 预留的锚点下加东西——模块区 `// == PLUS MODULES ==` 加 `pub mod`，setup 里 `// == PLUS INIT: <包> ==` 加本包初始化（多半是一行 `app.manage(...)`），`generate_handler!` 里 `// == PLUS COMMANDS: <包> ==` 加本包命令；② 改本子系统**原有的**初始化代码块：LLM 初始化（`lib.rs:248-270`、`314-362`）归 P1，RAG 初始化（`181-185`）归 P4，上下文、录音目录相关的改动归 P0；③ 已有命令的增删只在本子系统的原分节里做 | 冲突时两边都保留（都是列表）|
| `src-tauri/src/state.rs` | 不加字段。新状态写成独立类型，setup 里 `app.manage(...)`，命令里用 `State<'_, T>`、其他地方用 `app.state::<T>()` 取；只拿得到 `&AppState` 的函数（例如 `create_stt_provider_for_party`）要用新状态时，给它加一个 `&AppHandle` 参数或直接把 `Arc` 传进去 | 只有 P0 能改 |
| `src-tauri/src/commands/mod.rs` | 只在 `// == PLUS ==` 区加本包的 `pub mod` 行 | 两边都保留 |
| `src/stores/configStore.ts` | 归 **P2**（STT 的迁移 bug 在这里）。别的包不改文件本身：新状态放自己的 store；要写已有的配置就调用已有的 setter（P3 写 `native_translation` 用 `setMeetingAudioConfig`）；要读旧键做迁移，直接用 plugin-store 读 `config.json` 的键。P1 靠后端垫片兼容旧键（3.3），也不改它 | P2 |
| `src/App.tsx` | 按代码块分：翻译初始化（第 56 行挂 `useTranslation`、71–87 行同步翻译服务商）归 **P3**；其余（视图渲染、"上传简历"的修复）归 **P5**。两块相隔 300 多行，git 能自动合并 | 各自代码块的包 |
| `src/main.tsx` | 归 P0（i18n 初始化）| P0 |
| `src/components/ServiceStatusBar.tsx` | 归 **P1**。STT 引擎的显示名和选项由 P0 抽到 `src/lib/stt/providerMeta.ts`（之后归 P2），所以 P2 不用改这个文件 | P1 |
| `src/settings/SettingsOverlay.tsx` | P0 改（侧栏文案）。之后只允许 P1 改 `llm` 标签渲染的那一行和对应的 import。各包**不加新标签页**，在自己的页面里用子标签 | P0 / P1 |
| `src-tauri/Cargo.toml` | P2 只加 macOS target 段给 `whisper-rs` 开 `metal`；P4 需要 `rayon`、`base64` 时在 `# == PLUS: rag deps ==` 下各加一行（都已在依赖树里）。**第一版不引入新的原生（C/C++）依赖**（Windows 上的 CRT 混链风险，见 3.7）；别的包要加依赖先在共享笔记登记 | — |
| `package.json` | 只有 P0 加依赖（`i18next`、`react-i18next`）。别的包要 npm 依赖先登记，集成时统一加 | P0 |
| `Cargo.lock`、`package-lock.json` | 冲突时取 `custom` 一侧，再跑 `cargo check` / `npm install` 重新生成 | — |
| `src-tauri/src/db/migrations.rs` | 第一版**没有包需要改 `nexq.db`**：RAG 用独立的 `rag.db`（3.7），翻译的数据库键调整放到之后。以后 fork 自己的迁移函数用 `plus_` 前缀（避免和上游以后的 `v9_` 撞名），写成幂等，在 `run()` 末尾加一行调用 | — |
| `src/i18n/locales/*/<命名空间>.json` | 一个命名空间只归一个包（第 5.3 节）| 归属的包 |
| `src/i18n/index.ts`、`resources.ts` | 只有 P0 改 | P0 |

### 2.4 配置和密钥

- **前端设置**继续存 Tauri store 的 `config.json`（和 `configStore`、`scenarioStore`、`aiActionsStore` 一样，各 store 自己 `load("config.json")`、自己管自己的键）。新键名用小驼峰，例如 `uiLanguage`、`onboardingProgress`、`openaiCompatSttConfig`、`sonioxConfig`。
- **后端启动就要用的配置**（LLM 连接、知识库配置）由 Rust 拥有：存在 `app_data_dir` 下自己的 JSON 文件（`llm-connections.json`、`rag/config.json`），先写临时文件再改名，启动时自己加载，不依赖前端先推一遍。前端改设置走命令，Rust 存盘后发事件，两个窗口各自刷新。Rust 要读旧的 `config.json` 时用 `tauri_plugin_store::StoreExt`（`settings_commands.rs` 有先例）。
- **密钥**只进钥匙串（服务名前缀改成 `NexQPlus:`，见 3.1）。新命令**不把密钥明文返回前端**，只返回"是否已保存"和末尾几位；需要密钥的请求在 Rust 里取。新槽位：`llm:<连接 id>`（自定义请求头里的机密值用 `llm:<连接 id>:h:<头名>`）、`soniox`、`openai_compat_stt`、`rag-embedding`、`rag-rerank`；已有槽位（`openai`、`custom`、`deepgram`、`groq_whisper`、`deepl`、`translation_microsoft_region`…）不变。槽位名会被转成小写（`credentials/mod.rs:61-63`）。
- **两个窗口同步**：前端 store 要么用 `store.onKeyChange` 订阅自己的键（和 `configStore` 一样），要么监听 Rust 发的"配置已变"事件（Rust 拥有的配置）。新 store 都要写这一条，并加一个"另一个窗口改了，这个窗口跟着变"的测试。
- **迁移旧配置**：只读旧键、写新键，**不删旧键**（回到旧版本还能用）；用迁移标记或"新文件是否存在"保证只跑一次，并且重复执行结果相同（两个窗口会各跑一次）；迁移函数要有单元测试，覆盖"没有旧配置""旧配置不完整""已迁移过"三种情况。
- 新配置结构都要能完整序列化成 JSON、密钥和配置分开存，给以后的"导入/导出配置"留路。

### 2.5 端点地址规则（LLM、远程 STT、embedding、rerank 统一）

用户自己的 OpenAI 兼容端点路径不是 `/v1`，所以**永远不自动补 `/v1`**。P0 在 Rust 的 `src-tauri/src/net/endpoint.rs` 和前端的 `src/lib/endpoint.ts` 各实现一份，两边读同一份用例文件 `src/lib/endpointCases.json` 做测试（vitest 直接 import，Rust 用 `include_str!`），保证预览和真实请求一致。各协议的特殊规则（Anthropic、Gemini、Ollama）见 3.3。

1. 用户填 **Base URL**，含版本前缀，例如 `https://api.openai.com/v1`、`https://open.bigmodel.cn/api/paas/v4`、`https://ark.cn-beijing.volces.com/api/v3`、`http://192.168.1.10:8000/v1`。
2. 用 `url` crate 解析（已在依赖里）：去掉首尾空白和路径末尾的 `/`；没写 `http://` / `https://` 就报错并给出建议。
3. 请求地址 = Base URL + 固定路径：`/chat/completions`、`/models`、`/audio/transcriptions`、`/embeddings`、`/rerank`。只追加路径，**保留查询串**（Azure 的 `?api-version=` 能直接用），丢掉 `#` 之后的部分。
4. 用户粘贴的是完整地址（已经以该固定路径结尾）时不再追加，并提示"已识别为完整地址"。
5. 路径为空（只填了主机）时不补，输入框下方提示"大多数 OpenAI 兼容服务需要 /v1 之类的版本前缀"，并给一个"补上 /v1"按钮，由用户决定。
6. 输入框下方实时显示"实际请求地址"。
7. 高级选项"完整地址覆盖"：给路径完全不规则的网关，每个固定路径可以单独填完整 URL（对话地址可以含 `{model}` 占位）。
8. 请求返回 404 时，错误里写出实际请求地址，并提示"检查 Base URL 的版本前缀"；测试连接时可以顺带试一下 `{base}/v1/…` 告诉用户该怎么改，但不替用户改。
9. Ollama 原生接口（`/api/chat`、`/api/embed`）是另一种"接口风格"，由用户显式选择，**不做自动回退**（这正是 `custom.rs:287-314` 报错被吞的原因）。

认证方式统一为：无 / `Authorization: Bearer <key>` / 自定义头（头名 + 可选前缀，如 `api-key: <key>`、`x-api-key: <key>`），外加任意多个自定义请求头（值里不放密钥；密钥只走认证字段）。

### 2.6 验收命令

每个包合并前在自己的 worktree 里全部跑过，结果写进包会话的最终报告：

```bash
npx tsc --noEmit
```

```bash
npm test
```

```bash
bash -c 'source scripts/macos-env.sh && cd src-tauri && cargo test --lib'
```

```bash
node scripts/i18n-check.mjs
```

- `cargo test --lib` 基线有 1 个已知失败（`claude_cli_login_launch_keeps_path_out_of_cmd`，只适用于 Windows）。修复在 `test/claude-login-windows-only` 分支（naxhq/NexQ#56），**P0 开工前由主会话先把它合进 `custom`**（4.1 第 0 步），之后所有包都应该全绿。
- `i18n-check.mjs` 由 P0 提供：检查 `en` 和 `zh-CN` 的 key 一一对应、JSON 合法、没有重复 key；加 `--report <文件或目录>` 列出疑似没抽的英文硬编码（启发式，供自查）。
- 改了 Rust 的包另跑一次 `cargo check`（release 下 6 个已知的未使用变量警告不用管，不要新增警告）。
- 动了音频、STT、悬浮窗的包，P0 合并后用 `npx tauri dev` 手动测，报告里写清测了什么。

## 3. 各需求的设计

### 3.1 自用版身份隔离（Phase 0，归 P0）

目标：自用版和官方版能同时装在一台 Mac 上，数据、钥匙串、日志、自动更新互不影响。只做在 `custom`，不进任何给上游的 PR（3.1 末尾那条录音目录修复除外）。

| 项 | 现状 | 改法 | 文件 |
|---|---|---|---|
| 产品名 | `NexQ` | `NexQ Plus`；另设 `mainBinaryName: "nexq-plus"`，可执行文件名不带空格（Tauri 2 支持这个字段，已在本地 CLI 的 schema 里确认）| `src-tauri/tauri.conf.json` |
| Bundle ID | `com.nexq.app` | `com.plus.nexq`。数据目录、日志目录、WebView 存储、Tauri store、单实例锁都随之分开 | 同上 |
| 窗口标题、托盘提示 | "NexQ"、"NexQ Overlay"、"NexQ — AI Meeting Assistant" | "NexQ Plus"、"NexQ Plus 悬浮窗"；运行时的托盘提示由 `tray/tooltip.rs` 走 Rust i18n | `tauri.conf.json`、`tray/tooltip.rs` |
| 网页标题 | `<title>NexQ</title>` | `NexQ Plus` | `index.html` |
| 钥匙串 | 服务名 `NexQ:{provider}` | `NexQPlus:{provider}`，Mac 和 Windows 两个后端共用 `credentials/mod.rs` 里的一个常量 | `credentials/macos_keychain.rs:15`、`credentials/windows_cred.rs:14`、`credentials/mod.rs` |
| 上下文文件目录 | **Mac 上落到 `~/.nexq/context`**：`context/mod.rs:56-69` 只认 `APPDATA` 环境变量，Mac 没有这个变量就退回 `$HOME/.nexq` | 改用 Tauri 的 `app_data_dir()/context`，setup 里传进去 | `context/mod.rs`、`lib.rs` setup |
| 录音目录 | **Mac 上落到 `~/.config/com.nexq.app/recordings`**：`audio/recorder.rs:94-120` 同样只认 `APPDATA`，退回 `$HOME/.config` 再拼死 `com.nexq.app` | 改用 `app_data_dir()/recordings`。新建 `src-tauri/src/paths.rs`，setup 时用 `OnceLock` 记下 `app_data_dir`，`recorder.rs` 从这里取 | `audio/recorder.rs`、新 `paths.rs`、`lib.rs` |
| Claude CLI 沙箱 | `$TMPDIR/NexQ/agent-sandbox`（`cli_agent/command.rs:64-70`）| `NexQPlus/agent-sandbox` | `llm/cli_agent/command.rs` |
| 自动更新 | 启动 10 秒后查 `naxhq/NexQ` 的 `latest.json`，官方签名能过校验，退出时会装回官方版 | 第一版**关闭后台检查**：新 `src/lib/brand.ts` 里 `UPDATER_ENABLED = false`，`useUpdater.ts` 据此不启动定时检查，关于页显示"自用版已关闭自动更新"；`plugins.updater.endpoints` 改指 fork 的 Releases（万一被手动触发也不会拿到官方包）；`tauri.macos.conf.json`、`tauri.windows.conf.json` 的 `createUpdaterArtifacts` 改成 `false`；公钥等 Phase 5 用自己生成的密钥替换 | `tauri.conf.json`、`tauri.macos.conf.json`、`tauri.windows.conf.json`、`useUpdater.ts`、`AboutSettings.tsx`、新 `brand.ts` |
| 上游链接 | `AboutSettings.tsx:27` 的 `GITHUB_URL`、`useUpdater.ts:46` 的 `RELEASES_URL` | 指向 `PLus123456/NexQ`；关于页注明"基于 naxhq/NexQ（MIT）"并保留原版权声明 | 同左 |
| 权限说明 | `Info.plist` 两条英文 "NexQ captures audio…" | 改成中文，产品名 NexQ Plus（这是 macOS 弹权限框时显示的文字）| `src-tauri/Info.plist` |
| 构建脚本 | `build-mac.sh:20` 的 `APP_NAME="NexQ"`；安装时会 `pkill -x NexQ`、`rm -rf /Applications/NexQ.app`，**不改会杀掉并删除官方版** | `APP_NAME="NexQ Plus"`，进程名用 `nexq-plus`；安装前用 `defaults read` 检查产物的 `CFBundleIdentifier` 必须是 `com.plus.nexq`，否则中止 | `build-mac.sh` |
| 用不上的设置项 | "数据目录"设置 Rust 从来不读（OVERHAUL_PLAN 2.5）| 先在通用设置里隐藏，免得误导 | `GeneralSettings.tsx` |

不用改的：`nexq.db` 文件名（已经在随 Bundle ID 分开的数据目录里）、`package.json` 和 `Cargo.toml` 的包名（不影响安装身份，改了只会多出和上游的冲突）。

两个版本**同时运行**时仍会互相影响（不改，写进关于页的说明）：全局快捷键（后启动的那个注册失败）、会议检测弹窗（两个都弹）。建议不要同时运行。

自用版第一次启动是空白状态：要重新填 API Key、重新下载本地模型。模型可以手动从官方版目录复制过来（只读官方目录，不影响官方版）：

```bash
ditto "$HOME/Library/Application Support/com.nexq.app/models" "$HOME/Library/Application Support/com.plus.nexq/models"
```

验收：

- `grep -rnE 'com\.nexq\.app|naxhq/NexQ|"NexQ:' src src-tauri/src src-tauri/*.json build-mac.sh` 只剩注释和致谢。
- `bash -c 'source scripts/macos-env.sh && ./build-mac.sh --no-install --bundles app'` 之后，`defaults read "$PWD/src-tauri/target/release/bundle/macos/NexQ Plus.app/Contents/Info" CFBundleIdentifier` 输出 `com.plus.nexq`。
- 运行一次后生成 `~/Library/Application Support/com.plus.nexq/`，官方的 `com.nexq.app` 目录修改时间不变；钥匙串里新条目都以 `NexQPlus:` 开头；`~/.nexq`、`~/.config/com.nexq.app` 没有新文件。

> 上下文目录和录音目录在 Mac 上不跟随数据目录，是上游本身的 bug（录音还因此落在 `assetProtocol.scope` 的 `$APPDATA/recordings/**` 之外，Mac 上回放可能失败）。修法是通用的，以后可以单独提 PR；提给上游时要附带把旧目录文件搬过去的迁移，fork 是全新安装，不需要。

### 3.2 中文界面

设计见第 5 节。归属：框架和外壳页面归 P0，各功能包抽自己负责的文件，其余文件归 P6。

### 3.3 LLM 完全可自定义（归 P1）

**现状里两个关键事实**

- `LLMProvider` trait 本来就是 `Send + Sync`、方法全是 `&self`（`llm/provider.rs:420-444`），各客户端除了 `reqwest::Client` 没有别的状态。`LLMRouter` 里那把 `Arc<TokioMutex<Box<dyn LLMProvider>>>`（`llm/mod.rs:206`）不保护任何数据，只是让请求排队；AI 助手（`intelligence/mod.rs:212-215`）、LLM 翻译（`translation_commands.rs:520-523`）、会议问答（`meeting_chat_commands.rs:302-313`）都在流式输出期间一直持有它。**换成 `Arc<dyn LLMProvider>` 就能并发，provider 内部不用改。**
- 现在后端的 LLM 配置是前端每次启动推过去的（`configStore.ts:1338-1355`，两个窗口各推一次，推之前还用 `get_api_key` 把 Key 读进 JS），后端只放在内存里。

另有一把串行锁 `IntelligenceEngine::begin_generation`（`intelligence/mod.rs:230-243`）：AI 动作、总结、待办、书签、会议问答五类请求互斥，第二个直接报 "Generation already in progress"。翻译不经过它。**第一版不动这把锁**（改成按请求并发要连带改取消逻辑，放到之后）。

**数据模型**（Rust serde 为准，JSON 用 snake_case，所有字段 `#[serde(default)]`）

`LlmConnection`：

| 字段 | 说明 |
|---|---|
| `id` | 新建的是 `c_<8 位 hex>`；迁移来的是 `legacy-<旧类型>` |
| `name`、`template` | 显示名；模板 id（决定图标和少量特殊行为，例如 OpenRouter 的 `:online`，取代现在按 `provider_name == "openrouter"` 判断的写法）|
| `kind` | `openai_compat` / `anthropic` / `gemini` / `ollama` / `claude_cli`，决定请求协议。**新增一家 OpenAI 兼容厂商只加模板，不加枚举、不加 match** |
| `base_url`、`chat_url_override`、`models_endpoint` | 地址规则见下；`chat_url_override` 是完整对话地址，可含 `{model}` 占位；`models_endpoint` 为 `auto` / 自定义地址 / 关闭（关闭时只用手动列表）|
| `auth` | `none` / `bearer` / `header`（头名 + 可选前缀，例如 `api-key`、`x-api-key`）/ `query`（Gemini 旧式，默认不用）|
| `secret_ref`、`secret_hint` | 钥匙串账户名（新建的是 `llm:<id>`）；只有 Rust 读，前端只拿到"已保存 …ab12" |
| `headers` | 自定义请求头列表 `{name, value, secret}`；`secret` 的值存钥匙串（第一版可以只做非机密头）|
| `default_model`、`manual_models`、`model_cache` | 默认模型；手动维护的模型列表（排在候选最前）；`/models` 的结果落盘（两个窗口共享，离线也能看到，带拉取时间和错误）|
| `params` | 连接级默认参数：`temperature`、`max_tokens`、`extra_body`（任意 JSON 对象）|
| `compat` | 兼容开关：`temperature` 发送 / 不发 / 固定值；`max_tokens` 字段名（`max_tokens` / `max_completion_tokens` / 不发）；解析推理内容（`reasoning_content`、`reasoning`、Ollama 的 `message.thinking`，推理文字发 `llm_stream_thinking`，不进答案、也不进翻译）；剥离 `<think>` 标签；请求用量 `stream_options.include_usage`；`ollama_fallback_on_404`（只有迁移来的旧 custom 连接默认开，而且只在 404/405 时才改试 `/api/chat`）|
| `timeout_secs`、`max_concurrency` | 连接超时（默认 10 秒）；并发上限（默认 4，去锁之后防止实时翻译把限流打满）|
| `verified_at_ms` | 最后一次测试成功的时间，用于"就绪"标记 |

任务路由 `routing`：`default`（必须有）+ 每个任务一条 `{target: 连接 + 模型 | 跟随上级, params 覆盖}`。

| 任务键 | 对应 | 上级 |
|---|---|---|
| `assist`、`assist:<动作>` | AI 助手的各个动作（Assist、WhatToSay、Shorten、FollowUp、Recap、AskQuestion、自定义动作）| `default` / `assist` |
| `meeting_summary`、`action_items`、`bookmark_suggestions` | 会议总结、待办提取、书签建议 | `default` |
| `meeting_ask` | 历史会议问答（`ask_meeting`）| `default` |
| `translation`、`translation_batch` | 实时 LLM 翻译（含划词、补译）、会后批量翻译 | `default` / `translation` |
| `rag_answer` | 个人知识库的"测试回答" | `default` |
| `claude_fallback` | Claude 订阅不可用时的备用（现在只能存一个类型名，迁过来以后可以是任意连接 + 模型）| `default` |

解析规则：沿上级找第一个设了目标的，都没有就用 `default`；指向的连接被删了视同跟随上级（删除时顺手清掉相关路由并提示）；连接被停用就报错，不悄悄换模型；结果是 Claude 订阅且当前不可用时自动换成 `claude_fallback`，**所有调用方（包括翻译）都自动用上备用**。参数从低到高合并：内置默认 < 连接默认 < 调用方（动作温度等）< 路由覆盖，最后过一遍兼容开关；`extra_body` 按 JSON Merge Patch 合并，不许覆盖 `model`、`messages`、`stream`。默认参数参考 LectureLive：助手 0.6、总结 0.4、翻译 0.2。

**存储**：Rust 独占 `app_data_dir/llm-connections.json`（带 `schema_version`、`revision`），先写临时文件再改名，保留一份 `.bak`；改动后发 `llm_config_changed`（全量视图），两个窗口各自刷新。启动时 Rust 自己加载，不再依赖前端推。

**地址规则**（在 2.5 节通用规则之上按协议区分）：

| 类型 | Base URL 指什么 | 对话 | 模型列表 |
|---|---|---|---|
| `openai_compat` | `/chat/completions` 之前的整段前缀，版本段（`/v1`、`/v4`、`/api/v3`…）由用户自己带，**永远不自动补** | `{base}/chat/completions` | `{base}/models` |
| `anthropic` | 不含 `/v1`（和 Anthropic SDK、DeepSeek/Kimi/智谱的 `/anthropic` 端点一致）| `{base}/v1/messages`（base 已以 `/v1` 结尾时不重复）| `{base}/v1/models` |
| `gemini` | 主机 | `{base}/v1beta/models/{model}:streamGenerateContent?alt=sse` | `{base}/v1beta/models` |
| `ollama` | 主机（可以是局域网地址）| `{base}/api/chat` | `{base}/api/tags`（base 以 `/v1` 结尾时提示"这是 OpenAI 兼容地址，请改类型"）|

例子：`https://open.bigmodel.cn/api/paas/v4` → `…/v4/chat/completions`；`https://ark.cn-beijing.volces.com/api/v3` → `…/v3/chat/completions`；`https://x.openai.azure.com/openai/deployments/gpt4o?api-version=2024-10-21` → `…/gpt4o/chat/completions?api-version=2024-10-21`；粘了完整地址 `https://gw.example.com/llm/chat/completions` → 自动截成 `…/llm` 并提示。前端和 Rust 用同一份用例 JSON 做测试（2.5 节）。

**旧配置迁移**（只迁一次、只读不删、可回滚）：

- 已有 `llm-connections.json` 就直接加载；没有就读 `config.json` 原始 JSON：`llmProvider` + `llmModel` → `routing.default` 指向 `legacy-<类型>`，其他任务全部"跟随默认"，行为和现在一样；`lastModelByProvider` → 各连接的默认模型和手动列表；`customLlmBaseUrl` / `customLlmAuthType` → `legacy-custom`；`claudeCliConfig.fallback_*` → `claude_fallback` 路由。
- **钥匙串不复制**：`secret_ref` 直接指向旧槽位（`openai`、`custom`…）。不去钥匙串探测谁有 Key（ad-hoc 签名重编后读钥匙串可能弹授权框）。
- 回滚：删掉或改名 `llm-connections.json`，下次启动从旧键重新迁移；退回旧版本 App 直接读旧键（旧键从没被改动）。
- 自用版是新 Bundle ID 的全新安装，数据目录里没有旧 `config.json`，实际效果等于全新安装（只建一个 `legacy-ollama`）；迁移逻辑主要是为以后提给上游准备的。

**兼容垫片（第一版不改十来个旧界面的关键）**：旧命令 `set_llm_provider` / `set_active_model` 保留，映射到 `legacy-<类型>` 连接和默认路由，并且**做成幂等**（默认连接映射回的旧类型和请求的一样时不切换）；Rust 每次默认路由变化时用 `StoreExt` 把它镜像写回 `config.json` 的 `llmProvider` / `llmModel`。这样底栏旧选择器、引导、Claude 面板、AI 日志、待办页等读这两个键的地方照常工作，`configStore.ts` 启动时那段推送也变成无害的空操作，**P1 不用改 `configStore.ts`**。

**Rust 改动**（新文件为主）：

| 文件 | 内容 |
|---|---|
| `llm/api.rs`（P0 建桩，P1 实现）| 跨包稳定接口，见第 4 节 P0"契约" |
| `llm/connections.rs`、`llm/persist.rs` | 数据模型、校验、读写文件、迁移 |
| `llm/http.rs`、`llm/compat.rs` | 认证和自定义头加到请求上（报错里的 URL 脱敏）；请求体构造、逐行解析流（兼容 NDJSON 和"无视 stream 直接回整段 JSON"）、`<think>` 剥离，都是纯函数，直接单测 |
| `llm/registry.rs` | `LlmRegistry`（用 `app.manage` 注册，**不加进 `AppState`**）：配置 + 按连接缓存的 `Arc<dyn LLMProvider>` + 每个连接一个信号量；锁只在拷贝 `Arc` 时短暂持有，绝不跨 `await` |
| `llm/mod.rs` | `LLMRouter` 改成门面：内部存 `Arc<dyn LLMProvider>`，`get_provider()` 签名不变但每次返回一把新锁——**翻译和知识库那两条旧路径不改代码也不再互相阻塞**；删掉没用的 `cancel_token` |
| `commands/llm_connection_commands.rs` | `llm_get_config`、`llm_upsert_connection`、`llm_delete_connection`、`llm_set_secret`（只写不读）、`llm_secret_status`、`llm_set_route`、`llm_fetch_models`、`llm_test_connection`（返回实际地址、状态码、耗时、开头几个字或原始错误体前 2 KB）、`llm_preview_endpoints` |
| `intelligence_commands.rs`、`meeting_chat_commands.rs`、`cli_agent/routing.rs` | 调用点改成 `resolve_for_task(LlmTask::from_mode(mode))`；Claude 备用改由路由处理 |

**顺手修掉的 bug**（都在 P1 的文件里）：

- 自定义端点报错被吞（`custom.rs:287-314`，以及模型列表、测试连接 `150-241` 也在吞错）：去掉自动回退，错误原样显示。
- **流式输出按网络块各自 `String::from_utf8_lossy`**（`custom.rs:339`、`openai_compat.rs:208`、`anthropic.rs:289`、`gemini.rs:254`、`ollama.rs:192`）：一个中文字符被拆在两个网络块里就变成 �，经代理或压缩时更常见。改成按字节缓冲、按行解码。
- HTTP 200 但流里是 `data: {"error":…}` 时被当成"没有内容"（`openai_compat.rs:211-229`）：显示错误。
- Gemini 的 Key 放在 URL 查询串里，报错信息可能把 Key 带到界面上：改用 `x-goog-api-key` 请求头。
- **Mac 上 Claude 登录打不开终端**：`claude_cli_commands.rs:185-198` 在没设 `ComSpec` 时回退成 `cmd.exe`。推荐在临时目录写一个 `claude-login.command`（权限 0700，先 `cd` 到沙箱目录、`unset` 要剥掉的环境变量，再 `exec` claude 的绝对路径），然后 `/usr/bin/open -a Terminal <脚本>`：走 LaunchServices，不需要"自动化"授权，硬化运行时下也不用加 entitlement。`osascript` 方案会弹授权、还要加 entitlement，不用。**为了不和 naxhq/NexQ#56 冲突**：`login_launch` 和它的测试都不动，只在 `login_launch` 上加 `#[cfg_attr(not(windows), allow(dead_code))]`；只改 182-205 行，按平台拆成三个函数；新测试放在 `mod tests` 末尾。
- Mac 上从 Finder 启动时 PATH 很短，Homebrew 装的 claude 显示"未安装"（`cli_agent/detect.rs:52-71`）：补上 `/opt/homebrew/bin`、`/usr/local/bin`（M2）。

**AI 回答语言**（第 9 节问题 1）：`llm-connections.json` 里加一个全局设置 `response_language`：`ui`（跟随界面语言，默认）/ `transcript`（跟随会议语言，即现在的行为）/ 具体语言代码。AI 助手各动作、总结、待办、书签、会议问答在组装提示词时末尾加一句"请用简体中文回答"之类的指令；当前界面语言从 P0 的 `crate::i18n::current_ui_language()` 读。翻译不受影响。

**前端**：

- 设置 → "AI 模型"页（`SettingsOverlay.tsx` 里 `llm` 标签改成渲染新组件；`LLMSettings.tsx` 原文件留着不动，减少和上游的冲突）：
  - 顶部横幅显示默认的"连接 / 模型"。
  - "连接"子标签：左边连接列表（名称、模板图标、状态、被哪些任务使用），"添加连接"打开模板库；右边编辑器分区：基本（类型、Base URL + 实时地址预览和警告、完整地址覆盖、模型列表地址）、认证（方式 + 密钥，显示"已保存 …ab12"，**改了 Base URL 或类型要求重新输入密钥**）、自定义请求头、模型（默认模型、手动列表、拉取的列表）、默认参数（temperature、max tokens、额外请求体 JSON 带校验）、兼容开关、高级（超时、并发上限）、"测试对话"和"拉取模型"。
  - "任务路由"子标签：表格列为 任务 / 连接（跟随… 或某个连接）/ 模型 / 参数 / 实际生效（灰字，例如"跟随默认 → DeepSeek / deepseek-chat"）。高频任务（实时翻译）旁边提示"建议选快模型、关闭思考"。
  - Claude 订阅就是一种连接，编辑器沿用现在的 `ClaudeCliSettings`；把备用部分（607-684 行）换成"连接 + 模型"放在 M2（M1 里备用仍按旧方式工作）。
- `ModelCombobox`（P0 建，见第 4 节）：受控输入框 + 自绘候选弹层（不用 `datalist`，WKWebView 和 WebView2 表现不一致）；候选 = 手动列表 ∪ 缓存 ∪ 模板建议，边输边过滤，支持方向键、回车、Esc；输入值不在列表里时提示"将按原样发送"。设置页、路由表、底栏、首次设置、Claude 备用共用。
- 底栏快切 `LlmQuickPicker`：按 本地 / 云端 / 订阅 分组选连接 → 选模型 → 应用到默认路由，并列出单独指定过的任务（"不受影响"）。M1 可以先不换：经过垫片，旧的底栏选择器照样能用（只是只列旧类型）。
- `llmConnectionsStore`：调 `llm_get_config` 并监听 `llm_config_changed`，按 `revision` 覆盖；所有修改都发命令，前端不在本地持久化。**第一次被组件用到时自己加载**，所以不用改 `App.tsx` / `main.tsx` / `configStore.ts`。
- 服务商模板 `src/settings/llm/providerTemplates.ts`：OpenAI、Anthropic、Gemini、Groq、OpenRouter、Azure OpenAI、DeepSeek、Kimi、智谱 GLM（`/api/paas/v4`）、通义千问兼容模式、火山方舟（`/api/v3`，模型填接入点 ID）、硅基流动、Ollama、LM Studio、自建 vLLM / LiteLLM / One API、Claude 订阅、空白 OpenAI 兼容。只做预填，全部可改；地址发布前要逐个核对官方文档。实时翻译用推理模型时，在翻译路由的 `extra_body` 里关掉思考（智谱 `{"thinking":{"type":"disabled"}}`、Qwen3 `{"enable_thinking": false}`）能明显降低延迟。

**M1**：后端全部（契约实现、连接和路由、迁移、去锁、垫片和镜像、新命令、调用点切换、上面的 bug）；前端连接列表 + 编辑器（基本、认证、请求头、模型、参数、测试）、任务路由表（不展开到每个动作）、模板。**M2**：底栏 `LlmQuickPicker`、路由展开到每个 AI 动作、兼容开关的完整界面、Claude 备用改用连接、Gemini 上下文缓存和 OpenRouter 目录按连接、Homebrew PATH。
**之后**：`IntelligenceEngine` 按请求并发和定向取消；400 时自适应去掉 temperature 重试；连接导入导出；AI 日志里显示推理内容和费用；删掉 `ProviderType`、`LLMRouter`、旧命令。

**能提给上游的**：手填模型（`ModelCombobox`，覆盖设置页、底栏、引导，按 naxhq/NexQ#37 里维护者的偏好做成"下拉候选 + 可输入"，建议最先提）、自定义端点显示真实报错、Mac 登录打开终端（和 #56 分开提）、流式 UTF-8 乱码（中文受益最大）、流里的错误显示出来、Gemini Key 改用请求头、Ollama/LM Studio 地址可填、去掉长时间持锁（等重复翻译的修复先合）。连接配置档和按任务路由先开 issue。`legacy-*` 迁移胶水、`llm-connections.json`、`NexQPlus:llm:*` 槽位只留 fork。

### 3.4 远程 STT（OpenAI 兼容，归 P2）

新引擎 `openai_compat`（界面名"远程 Whisper（OpenAI 兼容）"），接 faster-whisper-server / speaches、vLLM、LocalAI 这类 `/audio/transcriptions` 服务。

- **新文件 `src-tauri/src/stt/openai_compat.rs`**：第一版复制并泛化 `groq_whisper.rs`（它发的就是 OpenAI 标准 multipart，功能最全：模型名字符串、prompt、temperature、分段长度、停顿切分），Groq 本身不动，零回归风险；以后再把 Groq 变成它的一个预设。
- **配置**（全局一份，语言属于每一路）：`base_url`、`model`、`temperature`、`response_format`（默认 `json`）、`prompt`、`segment_duration_secs`、`pause_split_ms`、`request_timeout_secs`（默认 30）、`max_in_flight`（默认 1）。照 Groq 的模式：`configStore` 的 `openaiCompatSttConfig` → 新命令 `update_openai_compat_stt_config` → Rust 里的共享 `RwLock`（**用 `app.manage` 注册新类型，不加进 `AppState`**），会议中改配置，下一个请求就生效。Key 可选：存钥匙串 `openai_compat_stt`，为空就不发 `Authorization`。
- **地址**：按 2.5 节，`{base}/audio/transcriptions`，已经以它结尾就原样用，保留 query；路径为空时**不自动补 `/v1`**，在输入框下提示并给一个"补上 /v1"按钮。
- **有序和限流**：不再每段 spawn 一个请求（Groq 现在请求没有超时、结果按完成先后回来，接慢的自建服务器会乱序、会堆积）：改成一个 worker 任务 + 有界队列，按顺序处理，并发 1–2；积压超过上限时合并或丢最旧的。
- **响应解析**：先按 JSON 取 `text`，失败就当纯文本，兼容 `response_format=text` 和 LocalAI 带 `segments` 的返回。
- **测试连接**：先 `GET {base}/models`（speaches、vLLM、LocalAI 都有），404 再 POST 一段 1 秒静音 WAV；把状态码和响应片段显示出来，不吞错。
- **幻觉过滤**：Groq 现有的过滤只有英文短语（`groq_whisper.rs:46-61`），补上 Whisper 中文常见的幻觉句（"字幕由 Amara.org 社区提供""请不吝点赞 订阅 转发"之类）。
- **注册点**（加一个引擎要改的地方，全在 P2 的文件里）：Rust 的 `stt/provider.rs` 枚举和 `as_str`/`from_str`、`stt/mod.rs` 的 mod 声明和两个 match、`stt_commands.rs` 两个取 Key 的 match 和测试分支、`audio_commands.rs` 的 `create_stt_provider_for_party`；前端的 `STTProviderType`、`providerMeta.ts`（P0 抽出来的，底栏和会议音频设置都读它）、`STTSettings.tsx` 的引擎面板、`MeetingAudioSettings.tsx` 的可用性判断（Key 可选的引擎改成判断"Base URL 是否已填"，否则会被自动回退换掉）。
- 设置面板 `src/settings/stt/OpenAICompatSttSettings.tsx`：Base URL + 地址预览、模型名（`ModelCombobox`，候选来自 `/models`）、可选 Key、prompt、分段秒数、测试按钮。不要复用 `STTSettings` 通用的 Key 面板：它测试失败会删掉已存的 Key（`STTSettings.tsx:471-479`）。

之后再做："我/对方"用不同的远程服务器（多个命名的 STT 端点）；按 VAD 切段上传；通用 WebSocket 流式引擎（FunASR 等）。

### 3.5 Soniox 接入（实时识别 + 实时翻译，归 P2，显示归 P3）

**结论：做成 STT 引擎 `soniox`，不是翻译服务。** 译文是识别流的副产品：原文和译文在同一条 WebSocket 里交错到达，只有用 Soniox 识别的那一路才会有。翻译设置（P3）决定每一路的译文"由识别引擎直接给"（Soniox）还是"走翻译管线"（LLM、DeepL 等）。Soniox 协议细节见附录 A。

**每一路一个会话**

- 在线会议模式：我（麦克风）和对方（系统音频）各开一个 Soniox 会话，各用各的 `language_hints` 和翻译配置。谁说的话由音频来源决定，不依赖说话人分离。
- 同室模式（只有一路"现场"音频）：一个会话，开说话人分离。two_way 翻译（我的语言 ↔ 对方的语言）放到 M2。
- 只给对方开 Soniox、我用别的引擎，完全支持（第 9 节问题 3 的默认）。

**start 消息怎么填**

| 字段 | 取值 |
|---|---|
| `model` | 设置里的模型，默认 `stt-rt-v5`，候选来自 `/v1/models`，可手填 |
| `audio_format` / `sample_rate` / `num_channels` | `pcm_s16le` / `16000` / `1`。NexQ 喂给引擎的 `AudioChunk.pcm_data` 本来就是 16 kHz 单声道 i16（`audio/mod.rs:539-552`），按小端字节直接发，不用转换 |
| `language_hints` | 该路选了具体语言 → `[该语言的两字母代码]`；选了"自动检测" → 两路语言的并集（都是自动就不传）|
| `language_hints_strict` | 默认 `false`，设置里可开 |
| `enable_language_identification` | `true` |
| `enable_speaker_diarization` | 对方那路：设置项，默认开（区分多个远端参会人，映射成 `speaker_tag` 的 "S1"、"S2"）；我那路：关 |
| `enable_endpoint_detection` | `true` |
| `max_endpoint_delay_ms` | 设置项，默认 1500 |
| `context` | M2：会议标题、场景、术语表 |
| `translation` | 读这一路的 `PartyAudioConfig.native_translation`（字段见下面"和翻译包的约定"）：`mode` 是 `one_way` → `{"type":"one_way","target_language":<目标语言两字母>}`，目标语言留空时跟随翻译设置（`TranslationRouter::default_target_lang()`，`translation/mod.rs:244`）；`off` 或没有这个字段 → 不传 |
| `client_reference_id` | `nexq:<会议 id>:<you\|them>` |

**消息怎么变成 NexQ 的事件**（全部复用现有事件，前端不用为 Soniox 写新的显示链路）

Soniox 自己分段，**不走 `SegmentAccumulator`**：累加器会把多个 final 合并成一个 `acc_n` 再用同一个 id 反复重发（`segment_accumulator.rs:110-172`），Soniox"一句一条译文"就对不上了。现在只有"我"那一路有"引擎自己分段、直接发出"的分支（`audio_commands.rs:1089-1090`，目前只给 whisper_cpp 用），"对方"那一路一律走累加器（`audio_commands.rs:1188-1254`）。P2 要：

- 把两路的结果发射任务抽成一个函数（例如 `spawn_party_emitter`），用 `self_segmenting(provider)`（whisper_cpp、soniox 返回 true）决定走不走累加器；"对方"的直出分支要保留现在的两件事：final 推给 `IntelligenceEngine`、带上 `speaker_tag`。
- 把 `session_prefix` 的计算（`audio_commands.rs:1074-1080`）挪到创建引擎（1012 行）之前并传进去，这样 Soniox 发译文时用的 `segment_id` 和前端收到的转写片段 id 完全一致（`{you|them}_{session}_sx{连接序号}_{句序号}`）。

处理每条消息：

1. 维护当前片段：`{id, 原文已定稿, 原文尾部, 译文已定稿, 译文尾部, speaker, language}`。每条消息先清空两个"尾部"，再按 `translation_status` 分流：`translation` 进译文侧，其余进原文侧；final 追加到"已定稿"，non-final 放进"尾部"。
2. 每条消息处理完发一次 `transcript_update`（`is_final: false`，`text` = 原文已定稿 + 尾部，片段 id 不变）。
3. 遇到 `<end>`（或手动定稿的 `<fin>`）发 `transcript_final`（`is_final: true`），把当前片段存档，换新 id。约 30 秒还没有端点时主动发一次 `finalize` 切句。
4. 片段存档后才到的译文，补到最近存档的那个片段（兜底；文档没保证译文一定在 `<end>` 前到齐）。
5. 译文在流动时发出现有的 `translation_result` 事件，payload 和现有 `TranslationResult` 一样（`segment_id` 为完整 id，`provider: "soniox"`），同一句可以发多次、后到的覆盖前面的，每句不超过每秒 4 次。前端 `useTranslation` 现有的监听直接就能显示。
6. 某句的译文定稿后（下一句原文开始，或存档后 3 秒没有新译文），调现有的 `db::translation::save_translation(…, "soniox")` 入库，`meeting_id` 取 `AppState.live_meeting`。
7. 片段语言已经是目标语言时（没有译文 token，或标为 `none`）不发译文。
8. speaker：我那路是 `User`，对方那路是 `Them`；开了说话人分离时 `speaker_tag = "S" + speaker`。

**和翻译包（P3）的约定**

- 每一路"识别引擎自带翻译"的配置放在 `PartyAudioConfig.native_translation`（P0 先在 `src/lib/types.ts` 加上这个可选字段，Rust 侧由 P2 在 `audio/mod.rs` 的 `PartyAudioConfig` 里用 `#[serde(default)]` 加）：`{ mode: "off" | "one_way" | "two_way"; target_language?: string; language_a?: string; language_b?: string }`，目标语言留空表示跟随翻译设置。这样它会跟着 `start_capture_per_party` 原样传进 Rust，不需要新的命令和状态；会议中改了它，现有的 `useAudioConfigSync` 热切换会重启采集，Soniox 会话自然重建。
- **界面在 P3**：翻译设置里每一路选"不翻译 / 识别引擎直接翻译（这一路是 Soniox 时可选）/ 翻译服务"。P3 通过 `configStore` 现有的 `setMeetingAudioConfig`（`configStore.ts:621`）写 `native_translation`，不改 `configStore.ts` 本身。
- **翻译管线按配置跳过**：某一路的引擎支持自带翻译（`providerMeta` 的 `supportsNativeTranslation`）并且 `native_translation.mode` 不是 `off`，这一路的自动翻译和"全部翻译"都跳过。不能按"是否已经有译文"判断，Soniox 的译文常常晚于 `transcript_final` 到达。
- P3 保持不变的接口：`db::translation::save_translation` 的签名、`TranslationRouter::default_target_lang()`，并且要把真实的目标语言推给后端（现在前端默认 `es`、没保存过时推给后端的却是 `en`，`translationStore.ts:71` 对比 176 行）。

**连接生命周期**

- 握手时加 `Authorization: Bearer <key>`（`tokio-tungstenite` 的 `IntoClientRequest` 构造请求再加头，头值设为 sensitive，不进日志），start 消息里不放 Key。复用 Deepgram 引擎已经在用的 `tokio-tungstenite 0.30 + native-tls`。
- 音频攒到约 100 ms 一帧再发（采集回调一次只有约 10 ms、170 个采样点）。`feed_audio` 只把数据推进有界通道就返回，网络发送放在 spawn 出去的任务里（共享音频循环不能被阻塞，见 OVERHAUL_PLAN 2.3 末尾；写法参考上游修复 #50 对 Deepgram 的处理）。
- 静音照常发。该路被静音（`you_muted` / `them_muted`）时改发 `{"type":"keepalive"}`，每 8 秒一次。
- 重连：408、500、503、WS 1006 自动重连，1.5 秒起每次 ×1.5、最多 5 次，连接稳定 8 秒后清零计数；429 至少等 20 秒；413（到了 300 分钟）立即新开；400、401、402、403 不重试，通过现有的 STT 连接状态事件把原因显示给用户。重连后按"已发送采样数"维护时间偏移，片段时间戳保持连续。
- 会议中改了这一路的语言或翻译目标：改的是 `meetingAudioConfig`，`useAudioConfigSync` 会整体重启采集，Soniox 会话随之重建；P2 要保证停止时先结算并发出当前片段。
- 会议结束：发空文本帧 `""`，最多等 5 秒 `finished`，然后关闭。
- 290 分钟时提前换会话（M2）。

**设置项**（识别设置里的 Soniox 卡片）

- API Key：存钥匙串 `soniox`；"测试"按钮调 `GET /v1/models`（200 正常、401 Key 无效、403 Key 有效但缺"列出模型"权限）。
- 区域：美国 / 欧盟 / 日本 / 印度，决定 REST 和 WebSocket 两个域名。
- 模型：候选列表 + 手填，默认 `stt-rt-v5`。
- 端点延迟、对方那路是否区分说话人、严格语言限制。
- 高级：自定义 WebSocket 地址和 REST 地址（自建网关用）；额外 start 参数 JSON（向前兼容新字段，禁止写 `api_key`）。

**测试**：协议层（解析、片段拼接、译文对齐、错误分类）写成纯函数，用录下来的 JSON 消息序列做单元测试，不依赖网络和 Key。真实联调用一段几十秒的中英混合音频，结果写进 P2 的报告，重点看附录 A 里两个"未确认"：译文的到达时序，以及 one_way 遇到本来就是目标语言的话怎么标。

### 3.6 识别语言、字幕、翻译（识别语言归 P2，翻译归 P3，语言目录归 P0）

**统一的语言目录（P0）**：`src/lib/languages.ts` 一份数据，每项 `{code, en, zh, native}`，合并现在 STT 的 18 项（两处重复：`STTSettings.tsx:146-165`、`MeetingAudioSettings.tsx:144-163`）和翻译的 38 项（`TranslationSettings.tsx:106-145`），去重、规范化。导出 `AUTO_LANGUAGE`、`normalizeLanguageCode()`（`_` 换 `-`、规范大小写）、`baseLanguage()`、`languageLabel()`、`STT_COMMON`、`TRANSLATION_COMMON`。组件 `LanguageCombobox`（常用语言下拉 + 可自由输入 + 可选"自动检测"，不认识的代码原样保存）。合并后 API 冻结。各服务商要求的代码格式不同（DeepL 的 `EN-US`、`ZH-HANS`，微软的 `zh-Hans`，谷歌的 `zh-CN`，Soniox 和 Whisper 的两字母），在 Rust 侧各自映射：识别在 `stt/language.rs`（P2），翻译在 `translation/lang_map.rs`（P3）。

**识别语言"我/对方"分开（P2）**

- 数据：`PartyAudioConfig.language?: string`，值为语言代码或 `"auto"`（P0 先加 TS 字段；P2 在 Rust 的 `audio/mod.rs:32` 里加 `#[serde(default)] language: Option<String>`）。旧版本读到新配置会忽略这个字段，双向兼容。
- 迁移：放在 `configStore.loadConfig` 首次加载的迁移代码旁边，哪一路没有 `language` 就填 `sttLanguage ?? "en-US"` 并保存。两个窗口各跑一次，必须幂等。`sttLanguage` 保留，继续用作新建配置的默认值和后端的全局回退。`presets.ts` 的 `applyPreset` 会整体重建配置，要保留两路的 language。
- 后端：`create_stt_provider_for_party` 开头取 `party_lang(config, state)`（本路有值用本路，否则用全局），替换函数里约 10 处 `get_stt_language(state)`。新建 `stt/language.rs` 集中处理"是否自动""转两字母""回退"。
- **一定要一起修的坑**：Groq 先 `set_language` 再 `set_shared_config`，而 `current_config()` 只读共享配置，共享配置的语言又被全局的 `set_stt_language` 覆盖（`audio_commands.rs:1592-1595`、`groq_whisper.rs:217-224`、`stt_commands.rs:277-284`）。不修的话，分路语言对 Groq 不生效。加实例级的语言覆盖。
- "自动检测"在各引擎上的含义：

| 引擎 | 支持 | 怎么传 | 不支持时 |
|---|---|---|---|
| Soniox | 是 | 不给 `language_hints`，开语言识别 | — |
| Whisper API / Groq / 远程 OpenAI 兼容 | 是 | 不发 `language` 参数（`whisper_api.rs:127-131` 现在会发 `language=auto`，服务端返回 400，要修）| — |
| whisper.cpp（本地）| 是 | 传 `"auto"` | 双通道的 1 秒快速通道每片独立检测，可能来回跳语种，界面提示"最好明确选择" |
| SenseVoice | 是 | 传 `"auto"`（`sherpa_offline.rs:221-227` 现在遇到未知语言落到 en，要修）| — |
| Deepgram | 部分 | nova-2/3 映射成 `multi` | 模型不支持时用 en 并提示 |
| Azure、Web Speech、Windows Speech | 否 | — | Web Speech 用 `navigator.language`；其余用系统语言；界面里禁用"自动检测"并说明 |
| Zipformer / ORT / Parakeet | 由模型决定 | 语言只是标签 | 界面标注"这个引擎忽略语言设置" |

- 界面：会议音频设置里每一路一个 `LanguageCombobox`；识别设置里"我""对方"各一个，去掉顶部的全局语言选择；引擎不支持自动检测时给提示；"Parakeet CTC 只支持英文"的提示（`STTSettings.tsx:307-308`）改成按路判断。Web Speech 用选了它的那一路的语言。改语言就是改 `meetingAudioConfig`，现有的 `useAudioConfigSync` 会热切换，比现在"下次连接才生效"更好。

**翻译完全可自定义（P3）**

现状要点：翻译 trait 和路由本身没问题（`translation/mod.rs:99-131`、`183-363`）；端点写死（`microsoft.rs:36/80/126/146`、`google.rs:5`、`deepl.rs:13-18`）；语言代码不按服务商映射；LLM 翻译只能用全局模型、提示词写死英文、没有 system prompt、整个流式期间持锁，"测试连接"是永远成功的桩（`llm_provider.rs:50-58`）；`test_translation_connection` 忽略传进来的服务商参数（`translation_commands.rs:391-405`）。

设计：

- **前端配置**（`translationStore`，存 `translation-config.json`）新增：`translateParties {you, them}`（分别控制翻不翻）、`endpoints {deepl?, microsoft?, google?}`、`llm {systemPrompt, userTemplate, glossary}`、`liveSettleMs`（默认 1200）；`targetLang` / `sourceLang` 改成自由输入 + 规范化。自用版的新装默认：服务商 `llm`、目标语言跟随界面语言（中文）、只翻译"对方"。
- **后端不加新命令**：给 `set_translation_provider(provider, region, options?)` 加一个可选参数 `options`（端点 + LLM 翻译设置），传 `None` 表示保持原值，旧调用不受影响。所以 P3 **不用改 `lib.rs`、`ipc.ts`、`types.ts`**，新的调用包装放 `src/lib/translation/ipc.ts`。
- **端点可改**：DeepL 可填自定义 `/v2` 前缀（包括 DeepLX 这类兼容服务），留空时仍按 Key 的 `:fx` 后缀自动选免费版或专业版；微软可填自定义资源端点（`https://<资源>.cognitiveservices.azure.com/translator/text/v3.0`）或 `https://api.translator.azure.cn`，4 处写死的地址改成拼接；谷歌的 `BASE_URL` 改成字段（可走反向代理）。配了自定义端点时允许不填 Key。
- **微软区域**：`set_translation_provider` 收到的 region 为空时从钥匙串回读，修掉设置页把区域重置成 `global` 的问题（`TranslationSettings.tsx:403/408/440/448`）。
- **LLM 翻译**：改成调用 `llm::api::complete_text(&app, &LlmTask::Translation, messages, opts)`（P0 的接口），模型由"AI 模型 → 任务路由 → 实时翻译"决定；P1 合并之前这个接口的桩沿用全局模型。翻译设置页不重复做模型选择，只显示一行说明和跳转按钮。system 提示词可编辑（默认："你是专业同声传译，只输出译文，保留术语、数字和专有名词"）；user 模板支持 `{source}`、`{target}`、`{glossary}`、`{text}` 占位，语言用名称而不是代码；术语表每行一条 `源 => 目标`；输出清洗（去掉 `<think>…</think>`、首尾引号、"Translation:" 前缀）；"测试连接"真的翻译一句，超时 15 秒。
- **实时管线**：`useTranslation` 拆成两个 hook：`useTranslationEvents()` 挂在 App 级、所有窗口都有；`useAutoTranslate()` 只在悬浮窗挂一次。按 `translateParties` 过滤（`speaker` 为 `User` 算"我"，其余算"对方"）；跳过识别引擎自带翻译的那一路（3.5 的约定）；"静置"防抖：同一个片段 1.2 秒内不再变化、或者同一路出现了新片段才去翻译（累加器会用同一个 id 反复重发变长的段落，这是"整段重译"的根因，`segment_accumulator.rs:5-13`）；过期结果守卫：只接受 `original_text` 等于该段最新文本的结果；源语言用这一路的识别语言（不是自动检测时）。
- **每一路怎么翻**：翻译设置里每一路选"不翻译 / 识别引擎直接翻译（这一路是 Soniox 时可选）/ 翻译服务"。前者写 `translateParties`，中间那项通过 `setMeetingAudioConfig` 写 `native_translation`（3.5）。
- **显示**：合并显示的行（同一说话人连续几段）按 `originalIds` 拼出所有段的译文，任何一段还在翻译时显示加载状态（`TranscriptPanel.tsx:124-128`、`TranscriptLine.tsx:63`；Soniox 是一句一条译文，这条必须修）；悬停框里正确显示服务商名称（Soniox 等）。

翻译相关 bug 的去向：

| 问题 | 第一版 | 之后 |
|---|---|---|
| 悬浮窗每句翻译两次 | P0 先删掉 `OverlayView.tsx:133` 那一行；P3 拆 hook 并加测试 | — |
| LLM"测试连接"永远成功；LLM 提示词写死、没有术语表；只能用全局模型还和 AI 助手抢锁 | 修（见上）| — |
| 端点写死；语言写死、不能自填、不按服务商映射；不能选翻译哪一路 | 修 | — |
| 合并行只显示第一段译文；段落变长整段重译、结果可能乱序覆盖 | 修（静置防抖 + 过期守卫）| 按句增量翻译、带上下文翻译 |
| 微软区域被重置成 global | 修 | — |
| 默认服务商没 Key 时报错被吞（`translationStore.ts:70`、`App.tsx:84`）| 把错误显示出来 | — |
| 前端默认目标语言 `es`，后端收到的却是 `en`（`translationStore.ts:71` 对比 176）| 修（推真实值，Soniox 的"跟随翻译目标语言"依赖它）| — |
| 自动翻译开关不保存 | 能做就做（改动小）| — |
| `test_translation_connection` 忽略服务商参数；内存缓存键不含服务商、模型、提示词；数据库唯一键不含服务商 | — | 修（数据库键要重建表，也可以定义成"以最新一次为准"不修）|
| 悬浮窗里不能改目标语言；没有"仅译文"显示模式；OPUS-MT 宣传和实际不符；批量翻译遇错即停、漏掉最近 30 秒 | — | 修 |

### 3.7 个人知识库向量化（归 P4）

**现状**（比 OVERHAUL_PLAN 里写的还要糟，都是正确性问题，和规模无关）：

- 嵌入只支持 Ollama（`rag/embedder.rs`），前端模型下拉只有 3 个写死的选项。
- **配置从不持久化**，每次启动都用默认值（`lib.rs:182`）；**索引也不记录建库时的模型和维度**。换过模型（例如 1024 维的 mxbai）再重启，查询回到 768 维的 nomic，维度对不上余弦直接返回 0，混合检索的向量路全是 0 分，结果基本就是最早入库的那几块，**而且没有任何报错**。
- 中文三处失效：分块的分隔符里没有中文标点，token 按"字符数 ÷ 4"估，中文低估约 4 倍；嵌入前按**字节**截断，一个块里大部分中文根本没进向量；FTS5 用默认的 `unicode61`，一串连续汉字算一个 token，关键词检索基本无效。
- 所有模型都被加上 nomic 专用的 `search_query:` / `search_document:` 前缀，对 bge、e5 是错误指令。
- 每次检索都把**全部向量**从 SQLite 读进内存逐条算，**全程占着全应用唯一的数据库锁**（会议转写落库会被堵住）；每次 Assist 最多检索两次。100 万块时一次要读约 3 GB。
- 重建是"先清空再串行重建"，一个坏文件就中止；进度事件字段前后端对不上，进度永远是 0（`rag/mod.rs:23-30` 对比 `types.ts:879-887`）；会议转写入索引是死代码。
- 上下文文件目录在 Mac 上不随 Bundle ID 变化（P0 修，见 3.1）。

**设计**

- **独立的 `rag.db`**（`app_data_dir/rag/rag.db`）：用 SQLite 自带的 `PRAGMA user_version` 做带版本号的迁移；WAL、`busy_timeout`，一个写连接、一个读连接；所有访问放进 `spawn_blocking`。好处：不碰 `nexq.db` 和 `migrations.rs`；和会议数据没有锁竞争；"重置索引"就是删一个文件；几 GB 的向量不会撑大主库。旧的三张 RAG 表原样保留但不再使用；旧向量不迁移（没人知道是用哪个模型生成的），新版第一次启动时从上下文目录里的文件后台重建，块一写入关键词检索就能用，向量陆续补上。
- **嵌入提供方 trait**：OpenAI 兼容 `/embeddings` + Ollama `/api/embed`。OpenAI 兼容这边：
  - 地址按 2.5 节，`{base}/embeddings`，永远不自动补 `/v1`；例：`https://open.bigmodel.cn/api/paas/v4` → `…/v4/embeddings`，`https://dashscope.aliyuncs.com/compatible-mode/v1` → `…/v1/embeddings`。
  - `dimensions` 只在用户勾选"随请求发送维度"时才发（有的服务遇到不认识的字段直接 400）；`encoding_format: base64` 可选；`extra_body_query` / `extra_body_document` 合并进请求体（例如 Jina 的 `task`）。
  - 响应**先按 `data[].index` 排序再和输入对齐**（有的代理不保证顺序），校验条数、维度、NaN，统一做 L2 归一化；空字符串发送前剔除。
  - 按 CJK 感知的方式估 token（汉字每个算 1，其余每 4 个字符算 1），超过 `max_input_tokens` 才截断，并计数告警。
  - 默认 batch 32（服务提示批太大时自动减半并记住）、并发 4（Ollama 为 1）、请求超时 60 秒、会议中查询嵌入 5 秒（超时退化为纯关键词检索）。429/503 指数退避（遵守 `Retry-After`），401/403/404 立即停止并显示实际 URL、状态码和响应开头。
  - 查询/文档前缀按模型名自动预填（nomic、e5、bge-zh、mxbai、Qwen3-Embedding 各不相同，bge-m3、OpenAI、DashScope 不加），用户可以改。
- **空间指纹**：sha256(提供方类型、模型、**实测**维度、文档前缀、`extra_body_document`)。指纹和当前配置不一致时**只走关键词检索**并显示"需要重建（N 块）"横幅，绝不混用新旧向量；用户在横幅上确认后才开始重建（远程 embedding 按量计费，不自动花钱），重建时新建一个空间，建完再切换。换 Base URL、Key、批大小、查询前缀不算换空间（同一个模型换台机器部署不需要重建）。
- **向量索引**：第一版**自写 int8 分段平铺索引 + f32 精排**，纯 Rust、不加任何原生依赖，约 300 行。估算 1024 维下 30 万块（约 1 万文档 × 30 块）常驻约 300 MB、单次 Mac 8–15 ms；50 万块以上再加 1-bit 粗排（100 万块约 130 MB、10–40 ms）；还不够再接 sqlite-vec 的 ANN（等 0.1.10 稳定，并在 Windows 上实际做一次 release 链接）。**不用 usearch**：它是 C++，项目在 Windows 上已经让 `+crt-static` 的 Rust 代码和 `/MD` 编译的 whisper.cpp 混链（`build.rs:2-9`），再加 C++ 依赖大概率报 LNK2038，而上游 CI 只跑 `cargo check` 不做链接，发现不了。LanceDB 太重（还要 protoc）。f32 原始向量一直存在 SQLite 里，以后换索引实现**不需要重新嵌入**。
- **混合检索**：中文在应用侧切成重叠的二元组，写进 contentless FTS5（`content=''`、`contentless_delete=1`，rowid 就是块 id），不需要词典，二字词也能稳定命中（trigram 分词查不到少于 3 个字的词，所以不用）；向量路和关键词路并行，RRF 融合（k=60，每路取 100 个候选，权重 0.7 / 0.3）；阈值只作用于向量路的原始余弦；嵌入失败就只返回关键词结果。
- **增量索引**：size + mtime 没变直接跳过 → 内容哈希没变只更新状态 → 按块哈希做差异，只删改变化的块，块哈希相同的复用已有向量 → 每批提交一个事务。中断续跑不需要任务表，"没做完的事"由数据库状态决定。单个后台 worker + 队列；取消；会议进行中用本机 Ollama 时暂停、用远程服务时并发降到 1；启动时和 `context_resources` 对账。进度事件 `rag_index_progress` 改成前端已经声明的字段，每秒最多 4 次，只有整个队列清空才发 `complete`。
- **rerank**（M2）：通用 `/rerank` 适配，请求只发 `model, query, documents, top_n`（TEI 格式发 `texts`），响应接受 `results` / `data` / 顶层数组、`relevance_score` / `score`；候选 30 个；会议中超时 2.5 秒就退回 RRF 顺序，连续失败 3 次熔断 60 秒；默认关闭。
- **配置**：Rust 存 `app_data_dir/rag/config.json`（JSON patch 合并，旧命令 `update_rag_config` 也改成 patch，否则旧格式会把新字段重置）；密钥存钥匙串 `rag-embedding`、`rag-rerank`。嵌入配置可以**选一个 LLM 连接复用它的地址、Key、请求头**（经 P0 契约里的 `llm::api::resolve_connection`；P1 合并前这个接口返回"未配置"，界面就不显示这个选项），也可以独立填写。embedding 和 rerank **不进任务路由**：换了要重建索引，由 RAG 自己管。切到远程提供方时弹一次确认："文档内容会发送到 {host}"。
- **门面**：`RagManager` 保留旧方法的签名（`search_async`、`get_status` 等），内部转发给新引擎，所以 `intelligence_commands.rs`（P1 的文件）、`context_commands.rs` 都不用改，热点文件只改 `lib.rs` 约 8 行。**这是和 P1 的约定：`rag::RagManager::search_async` 的签名不能变**（`intelligence_commands.rs:189/201/208` 在用）。

**M1**：嵌入提供方（OpenAI 兼容 + Ollama 迁移）、配置持久化和空间指纹、`rag.db`、int8 平铺索引 + 门面、二元切分 FTS + RRF 修正（中文混合检索；指纹不一致时的"只走关键词"也靠它）、增量索引 + 进度事件修复、中文分块修复、设置界面（地址 + 预览、Key、模型手填、维度、测试、进度、重建横幅）。**M2**：取消、启动对账、会议中降速、复用 LLM 连接（P1 合并后）、rerank。**之后**：1-bit 粗排、ANN、本地 ONNX 嵌入（`ort`、`tokenizers` 已在依赖里）、文件夹导入和监视、GBK 编码的 txt、ContextManager 懒加载、会议转写入索引、删除旧表。

### 3.8 首次设置重做（归 P5）

现状问题见 OVERHAUL_PLAN 2.5。新流程的每一步都**实际测一次**，测试通过才算完成，每一步都能跳过。

| 步骤 | 内容 | 怎么算完成 | 组件 |
|---|---|---|---|
| 1 界面语言 | 跟随系统 / 简体中文 / English，选了立即生效 | — | P5（调用 P0 的 `changeUiLanguage`）|
| 2 LLM | 选模板（自定义 OpenAI 兼容、DeepSeek、通义千问、硅基流动、本机 Ollama、Anthropic、Gemini…）→ 填 Base URL、Key、模型（候选 + 手填）→ 测试 | 对选定模型发一次最小请求成功 | P1 交付的 `LlmQuickSetup` |
| 3 语音识别 | 我 / 对方分别选引擎（本地 whisper.cpp、远程 OpenAI 兼容、Soniox、其他云服务）和识别语言（含自动检测）；需要 Key 的填 Key；本地模型可以在这一步下载 | 远程 STT 发一段测试音频成功；Soniox 的 `/v1/models` 返回 200；本地模型已下载 | P2 交付的 `SttQuickSetup` |
| 4 翻译 | 要不要翻译、翻译哪一路、目标语言、由谁翻译（Soniox / LLM / DeepL 等）| 选了需要 Key 的服务时测一次 | P3 交付的 `TranslationQuickSetup` |
| 5 权限和音频 | 麦克风测试（已有）+ **系统音频测试**：让用户随便播放一段声音，看"对方"那一路有没有电平 | 两路都有电平；没有就给出"系统设置 → 隐私与安全性 → 麦克风 / 屏幕与系统录音"的指引 | P5 |
| 6 完成 | 列出每一步的状态（完成 / 跳过 / 失败）；"开始会议"前至少要有一路识别可用 | — | P5 |

其他要求：

- **进度保存**：`config.json` 键 `onboardingProgress`（当前步骤 + 每一步状态），中途退出下次接着做。
- **随时重跑**：设置 → 通用里加"重新运行首次设置"，立即生效，不用重启（现在从悬浮窗重跑要重启）。
- 去掉欢迎页用浏览器 `fetch` 探测 `localhost:11434` / `localhost:1234` 的逻辑（受 CORS 限制，也探测不到别的机器）。探测 Ollama 放进 P1 的快速设置里，由 Rust 发请求。
- "上传简历"修好（3.9）。
- **快速设置组件的约定**（P0 建占位，P1/P2/P3 各自实现）：放在 `src/settings/llm/LlmQuickSetup.tsx`、`src/settings/stt/SttQuickSetup.tsx`、`src/settings/translation/TranslationQuickSetup.tsx`，统一 props：`{ variant: "wizard" | "settings"; onStatusChange(status: "incomplete" | "ok" | "skipped" | "error", detail?: string): void }`。P0 的占位版本只显示一句说明和"去设置里配置"按钮，所以 P5 不用等别的包就能开发和合并。
- 导入/导出配置、恢复默认：之后再做。

M1（必须）：第 1–4 步接上快速设置组件、"上传简历"修复、去掉 localhost 探测、进度保存、全部文案中文。M2：第 5 步系统音频测试和权限指引、第 6 步汇总检查、设置里重跑不用重启。

### 3.9 已知 bug 修复清单

| bug | 根因 | 修法 | 包 |
|---|---|---|---|
| 悬浮窗每句话翻译两次 | `useTranslation()` 在 `App.tsx:56` 和 `OverlayView.tsx:133` 各挂了一次，各自注册监听 | P0 先删掉 `OverlayView.tsx` 里那一次（`App.tsx` 那次已经覆盖所有视图；P1 去锁后它会从"排队翻两次"变成"并发翻两次"，所以要最先合）；P3 再把 hook 拆成"事件监听"和"自动翻译"两个，并加测试：一段 final 文字只触发一次翻译请求 | P0 + P3 |
| "上传简历"没反应 | `FirstRunWizard.tsx:102-109` 调 `setSettingsOpen(true)`，但主窗口只在悬浮窗视图下渲染设置弹窗（`App.tsx:412`）| `App.tsx` 在主窗口视图也渲染设置弹窗，并直接打开"个人知识库"标签 | P5 |
| whisper_cpp 默认值和启动迁移冲突 | 引导默认"对方 = whisper_cpp"（`STTSetupStep.tsx:72-77`、`AudioSetupStep.tsx:47-62`，`presets.ts` 里两个预设也用它），首次加载配置时又把它改成 web_speech（我）/ Deepgram（对方）（`configStore.ts:1047-1054`、`1084-1090`），用户不知情。注释说 whisper_cpp "只能批量"，但**仓库里根本没有会后批量转写的实现**，它实际只被实时双通道路径使用（`audio_commands.rs:1506-1527`）| P2：把 whisper_cpp 当实时引擎：删掉 1047-1054 的迁移，1084-1090 改成只在值为空时设平台默认值；会议音频设置和底栏（经 `providerMeta.ts`）加上这个选项；去掉"仅批量"的标签；选了但没下载模型时给下载入口或警告。P5：引导的默认值由 P2 的快速设置决定 | P2 + P5 |
| Mac 上显示 Windows Speech | 前端没有任何平台过滤（`STTSettings.tsx:65-73`、`MeetingAudioSettings.tsx:64-72`、`ServiceStatusBar.tsx:63`），`configStore` 的默认值和迁移目标也是 windows_native；后端在 Mac 上退化成能量检测，只输出 `[speech: N s]` 占位文字（`windows_native.rs:739-880`）| 前端在 `providerMeta.ts` 里按平台过滤；默认值改成和平台相关；Mac 上已有的 windows_native 配置迁走（我 → web_speech，对方 → 已就绪的本地引擎）；后端在非 Windows 下 `create_stt_provider_for_party` 直接返回 None 并发一条调试错误，不再输出占位文字 | P2 |
| 自定义端点报错被 Ollama 回退吞掉 | `custom.rs:287-314`：`/chat/completions` 一失败就改发 Ollama 的 `/api/chat` | 去掉自动回退，"接口风格"由用户显式选；错误原样显示（状态码 + 响应体前 500 字符 + 实际请求地址）| P1 |
| Mac 上 Claude 登录按钮打不开终端 | `open_claude_login_terminal` 在 Mac 上也去启动 `cmd.exe` | 见 3.3 | P1 |
| whisper.cpp 没开 Metal | `Cargo.toml` 里 `whisper-rs = "0.16"` 没开 `metal` 特性；这时 `whisper-rs-sys` 的构建脚本会显式设 `GGML_METAL=OFF`（已在本机 cargo 缓存里的 `whisper-rs-sys-0.15.0/build.rs:258-264` 确认）| 加一段只对 macOS 生效的依赖声明 `[target.'cfg(target_os = "macos")'.dependencies] whisper-rs = { version = "0.16", features = ["metal"] }`，和通用声明合并特性，Windows 不受影响；开了特性后 `WhisperContextParameters::default()` 的 `use_gpu` 自动为 true，代码不用改。shader 用 `GGML_METAL_EMBED_LIBRARY` 内嵌，不需要 Metal 编译器，也不用往包里放 metallib。另加"使用 GPU"开关（默认开），初始化失败自动退回 CPU；写一个 `#[ignore]` 基准测试（用环境变量指定模型和 WAV，只读文件、不运行 App），报告里附开关前后同一段音频的耗时 | P2 |

## 4. 工作包

### 4.0 依赖关系

```
custom ─ 先合 test/claude-login-windows-only
   │
   P0 地基（身份隔离 + i18n 框架 + 共享契约和桩）── 合并后其余包同时开工，互相不等
   ├─ P1 LLM（建议拆 P1a 后端 / P1b 前端两个会话）
   ├─ P2 语音识别
   ├─ P3 翻译          用 P0 的 llm::api 桩、native_translation 字段、语言组件
   ├─ P4 个人知识库    用 P0 的 llm::api::resolve_connection 桩、端点组件
   ├─ P5 首次设置      用 P0 的快速设置占位组件（P1/P2/P3 合并后自动换成真的）
   └─ P6 中文扫尾
```

| 包 | 分支 | M1 粗估 | 会话数 | 主要风险 |
|---|---|---|---|---|
| P0 地基 | `plus/p0-foundation` | 0.5 人日 | 1（可拆 2）| 拖延会卡住所有包 |
| P1 LLM | `plus/p1a-llm-backend`、`plus/p1b-llm-frontend` | 2.5–3 人日 | 2 | 改动面最大；关键路径 |
| P2 语音识别 | `plus/p2-stt` | 2 人日 | 1（内部用子代理并行写 Soniox 协议层）| Rust 最重；Soniox 两个"未确认" |
| P3 翻译 | `plus/p3-translation` | 1.5 人日 | 1 | 显示链路细节多 |
| P4 个人知识库 | `plus/p4-rag` | 2 人日 | 1 | 新存储格式要一次定对 |
| P5 首次设置 | `plus/p5-onboarding` | 1 人日 | 1 | 依赖别的包交付快速设置组件 |
| P6 中文扫尾 | `plus/p6-i18n-sweep` | 1–1.5 人日 | 1 | 文案量大，需要用户校对 |

粗估按"有 AI 协助、集中投入"算（和 OVERHAUL_PLAN 同口径），合计约 12 人日；7–8 个会话并行，墙钟时间约 1.5–2 天，所以每个包都要守住 M1。

每个包会话的通用要求：开工前读第 2、5、6 节和自己的小节；只改第 6 节里归自己的文件和 2.3 节允许的位置；碰到需要别的包配合的事，写进共享笔记目录，不要自己去改别人的文件；完成 M1 时在笔记里写一份交接（做了什么、没做什么、测了什么、已知问题），通知主会话可以合并，然后继续 M2。

### 4.1 P0 地基

**谁来做**：建议主会话自己做，或开一个会话；也可以拆成两个会话并行：P0a 做第 1–2 步，P0b 做第 3 步里"只新建文件"的那些契约（`lib.rs`、`commands/mod.rs`、`ServiceStatusBar.tsx`、`types.ts` 这几处由 P0a 改，避免两个会话撞车）。

**第 0 步（主会话在 `custom` 上做，P0 开工前）**：`git merge --no-ff test/claude-login-windows-only`，让 `cargo test --lib` 在 Mac 上全绿。不改那个分支本身。

**第 1 步：身份隔离**——3.1 节全部。

**第 2 步：i18n 框架**——第 5 节：

- 加依赖 `i18next`、`react-i18next`（锁定精确版本）。
- `src/i18n/{index.ts, resources.ts, i18next.d.ts, README.md}`；5.3 节表里**全部**命名空间的 `en` / `zh-CN` 空 JSON 文件；`common` 填好常用词。
- `main.tsx` 渲染前 `await initI18n()`；`src/test/setup.ts` 固定 `en`。
- 设置 → 通用加"界面语言"；两个窗口用 `onKeyChange("uiLanguage")` 同步。
- Rust：`src-tauri/src/i18n.rs`（当前语言 + 托盘和提示文字表 + `current_ui_language()`）、命令 `set_ui_language`、`tray/menu.rs` 和 `tray/tooltip.rs` 用它；启动时从 `config.json` 读一次。
- 把 `SettingsOverlay.tsx`、`GeneralSettings.tsx`、`AboutSettings.tsx`、`UpdateToast.tsx` 完整翻成中文，作为各包的样板。
- `scripts/i18n-check.mjs`（key 对齐 + `--report` 硬编码报告）。

**第 3 步：共享契约**（合并后冻结：只能加字段、加函数，不能改签名；确实要改，先在共享笔记里提出，由主会话决定）

| 契约 | 文件 | 内容 | 之后归谁 |
|---|---|---|---|
| 端点规则 | `src-tauri/src/net/{mod,endpoint}.rs`、`src/lib/endpoint.ts`、`src/lib/endpointCases.json` | `join_endpoint(base, suffix)` 和预览警告（2.5 节规则）；认证配置 `AuthConfig {mode: none\|bearer\|header, header_name, prefix}` 和"把认证、自定义头加到请求上"的函数；`ResolvedConnection {id, kind, base_url, headers, timeout}`、`ConnectionSummary`（给 P4 复用 LLM 连接用）；前后端共用一份用例 | 冻结 |
| LLM 任务接口 | `src-tauri/src/llm/api.rs`，`llm/mod.rs` 加一行 `pub mod api;` | 见下面的签名。桩：忽略任务，从现在的 `LLMRouter` 取 provider 和模型，包成"每次调用时加锁"的 `LockedProvider`，行为和现在完全一样；`resolve_connection` 返回"未配置"，`list_connections` 返回空 | P1（只换函数体）|
| STT 引擎元数据 | `src/lib/stt/providerMeta.ts` | 从 `ServiceStatusBar.tsx` 抽出 `STT_LABELS`（38-49）、`STT_PROVIDER_OPTIONS`（53-71）、互斥和回退顺序（73-86）、需要 Key 的列表（660 附近）、本地模型 id 的映射（202-208），`ServiceStatusBar.tsx` 改成 import，行为不变。每项带 `platforms`、`requiresApiKey`、`isLocal`、`supportsNativeTranslation`、`hidden` | P2 |
| 每路识别配置 | `src/lib/types.ts` 的 `PartyAudioConfig`（`TWO-PARTY AUDIO MODEL` 分节）| 只加两个可选的 TS 字段：`language?: string`、`native_translation?: {mode: "off" \| "one_way" \| "two_way"; target_language?: string; language_a?: string; language_b?: string}`；Rust 侧由 P2 加 | P2 |
| 语言目录和组件 | `src/lib/languages.ts`、`src/components/LanguageCombobox.tsx` | 3.6 节 | 冻结 |
| 模型输入框 | `src/components/ModelCombobox.tsx` | 3.3 节的行为；纯 UI，候选由 props 传入。放在这个路径是为了和以后给上游的"手填模型"PR 一致 | 冻结 |
| 端点表单 | `src/components/EndpointFields.tsx` | Base URL 输入 + 实际地址预览和警告 + "补上 /v1"按钮、认证方式、密钥输入（组件不存密钥，通过 props `secretStatus`、`onSecretChange` 交给调用方）、自定义请求头编辑。P2 的远程 STT、P4 的 embedding 用，P1 的连接编辑器也可以用 | 冻结 |
| 平台、品牌常量 | `src/lib/platform.ts`、`src/lib/brand.ts` | `isMac()`、`isWindows()`；`APP_NAME`、`REPO_URL`、`UPSTREAM_URL`、`UPDATER_ENABLED` | 冻结 |
| 快速设置占位 | `src/settings/llm/LlmQuickSetup.tsx`、`src/settings/stt/SttQuickSetup.tsx`、`src/settings/translation/TranslationQuickSetup.tsx` | props 见 3.8 节；占位版只显示说明和"去设置里配置"按钮 | P1 / P2 / P3 |
| Rust 锚点 | `src-tauri/src/lib.rs`、`src-tauri/src/commands/mod.rs` | 模块区 `// == PLUS MODULES ==`；setup 里 `// == PLUS INIT: p1-llm ==`、`p2-stt`、`p4-rag`；`generate_handler!` 里 `// == PLUS COMMANDS: p1-llm ==`、`p2-stt`、`p4-rag`，各放在对应子系统原有分节的末尾，互不相邻；`commands/mod.rs` 末尾 `// == PLUS ==` 区 | — |

`llm/api.rs` 的签名（以 P1 调研为准，只加不改）：

```rust
pub enum LlmTask { Default, Assist(String), MeetingSummary, ActionItems, BookmarkSuggestions,
                   MeetingAsk, Translation, TranslationBatch, RagAnswer, Other(&'static str) }
impl LlmTask { pub fn from_mode(mode: &str) -> Self; pub fn key(&self) -> String; }
pub enum LlmKind { OpenAiCompat, Anthropic, Gemini, Ollama, ClaudeCli }
#[derive(Clone)]
pub struct ResolvedLlm { pub provider: Arc<dyn LLMProvider>, pub model: String,
                         pub connection_id: String, pub display_name: String, pub kind: LlmKind }
#[derive(Clone, Default)]
pub struct CompleteOptions { pub temperature: Option<f64>, pub max_tokens: Option<u64>,
                             pub timeout: Option<Duration>, pub cancel: Option<Arc<CancelToken>> }
pub enum LlmCallError { NotConfigured(String), Auth(String), Http { status: u16, body: String },
                        Network(String), Timeout, Cancelled, Empty, Other(String) }  // 实现 Display 和 Into<String>
pub async fn resolve_for_task(app: &AppHandle, task: &LlmTask) -> Result<ResolvedLlm, LlmCallError>;
/// 静默流式、收成整段文本（不发 llm_stream_*），按连接限并发、带超时，Claude 不可用时自动用备用
pub async fn complete_text(app: &AppHandle, task: &LlmTask, messages: Vec<LLMMessage>,
                           opts: CompleteOptions) -> Result<String, LlmCallError>;
/// 给还要旧类型的调用方（IntelligenceEngine::generate_assist），每次一把新锁
pub fn legacy_handle(r: &ResolvedLlm) -> Arc<tokio::sync::Mutex<Box<dyn LLMProvider>>>;
/// P4 复用 LLM 连接做 embedding / rerank 用；密钥已经从钥匙串取出，写日志必须打码
pub fn resolve_connection(app: &AppHandle, id: &str) -> Result<net::endpoint::ResolvedConnection, LlmCallError>;
pub fn list_connections(app: &AppHandle) -> Vec<net::endpoint::ConnectionSummary>;  // 不含密钥
```

约定：别的包只 `use crate::llm::api::*`，不直接碰 `LLMRouter`、`ProviderType`、`create_provider`（以后会删）。

**第 4 步：一行修复**：删掉 `OverlayView.tsx:133` 的 `useTranslation()`（悬浮窗每句翻译两次）。P1 去锁以后，这个 bug 会从"排队翻两次"变成"并发翻两次"，所以放在最先合的 P0 里。

**P0 改的文件**：3.1 节表里的全部文件；`package.json`、`package-lock.json`、`index.html`、`src/main.tsx`、`src/test/setup.ts`、`src/i18n/**`、`scripts/i18n-check.mjs`；`src/settings/{SettingsOverlay,GeneralSettings,AboutSettings}.tsx`、`src/components/UpdateToast.tsx`、`src/hooks/useUpdater.ts`；上表里的契约文件；`src/components/ServiceStatusBar.tsx`（只做抽取）、`src/lib/types.ts`（只加两个字段）、`src/overlay/OverlayView.tsx`（只删一行）；Rust 的 `src-tauri/src/{i18n,paths}.rs`、`net/**`、`tray/{menu,tooltip}.rs`、`commands/tray_commands.rs`（或新建 `commands/ui_commands.rs` 放 `set_ui_language`）、`lib.rs`、`commands/mod.rs`、`llm/api.rs`、`llm/mod.rs`（一行）、`llm/cli_agent/command.rs`（沙箱目录名）、`credentials/*`、`context/mod.rs`（目录）、`audio/recorder.rs`（目录）。

**验收**：

- 2.6 节四条命令全过（`i18n-check` 能识别全部命名空间）；3.1 节身份隔离的三条验收。
- `net/endpoint.rs` 和 `endpoint.ts` 都通过 `endpointCases.json` 的全部用例；`llm/api.rs` 的桩有一个用假 provider 的 `complete_text` 单测。
- `ServiceStatusBar` 抽取后现有测试不改也通过。
- 合并后主会话第一次运行：切换界面语言，主窗口、悬浮窗、托盘同时变；数据只写进 `com.plus.nexq`。

### 4.2 P1 LLM

**建议拆两个会话**，文件天然不重叠（Rust / TS）：

- **P1a 后端**（`plus/p1a-llm-backend`）：`llm/api.rs` 的真实实现；`connections`、`persist`（含迁移）、`http`、`compat`、`registry`；`LLMRouter` 改成门面（去锁）；新命令和旧命令垫片、镜像写回 `config.json`；`generate_assist`、`ask_meeting`、Claude 路由改走 `resolve_for_task`；3.3 节的 bug（自定义端点吞错、UTF-8 跨块、流里的错误、Gemini Key、Mac 登录）；AI 回答语言。
- **P1b 前端**（`plus/p1b-llm-frontend`）：`llmConnectionsStore`、连接列表和编辑器、任务路由表、服务商模板、`LlmQuickSetup`、`SettingsOverlay` 里 `llm` 标签那一行、`ServiceStatusBar` / `ClaudeCliSettings` / `AgentStatusChip` 的文案。

两边开工前先在共享笔记里定好 `llm_get_config` 返回的 JSON 结构（`LlmConfigView`：`schema_version`、`revision`、`connections`、`routing`、`response_language`、`migration`，字段按 3.3 节）和命令名；P1b 在 P1a 合并前用 mock 数据开发和测试。合并时 P1a 先合。

**M1**：3.3 节"M1"那一段。**M2**：底栏 `LlmQuickPicker`、路由展开到每个 AI 动作、完整的兼容开关界面、Claude 备用改用连接、Gemini 上下文缓存和 OpenRouter 目录按连接、Homebrew PATH。

**独占文件**：

- Rust：`src-tauri/src/llm/**`（`api.rs` 接手 P0 的桩）、`src-tauri/src/intelligence/**`、`commands/{llm,intelligence,meeting_chat,claude_cli,gemini_cache}_commands.rs`、新 `commands/llm_connection_commands.rs`。
- TS：`src/settings/LLMSettings.tsx`（原样保留，不再渲染）、`ClaudeCliSettings.tsx`、`openrouter/**`、`src/settings/llm/**`（接手 `LlmQuickSetup.tsx`）、`src/components/ServiceStatusBar.tsx`、`AgentStatusChip.tsx`、`src/components/llm/**`、`src/lib/llm/**`、`src/lib/claudeModels.ts`、`agentUsage.ts`、`src/stores/agentStore.ts`、新 `src/stores/llmConnectionsStore.ts`、`src/hooks/{useAgentFallbackToast,useMeetingAgentUsage,useSummaryGeneration,useMeetingChat,useActionItemsExtraction,useBookmarkSuggestions}.ts`。

**允许改的热点位置**：`lib.rs` 的 LLM 原有初始化块（248-270 换成 `llm::registry::init`、314-362 换成 `spawn_startup_tasks`）、`PLUS INIT: p1-llm`（`app.manage` 注册表）、`PLUS COMMANDS: p1-llm`；`commands/mod.rs` 一行；`SettingsOverlay.tsx` 的 `llm` 那一行和 import；`types.ts` / `ipc.ts` / `events.ts` 原则上不改（新东西放 `src/lib/llm/`），确需改时只动 P1 的分节。**不改** `configStore.ts`、`state.rs`、`App.tsx`。

**交付给别人**：`llm::api` 的真实实现（P3 的 LLM 翻译、P4 的测试回答自动受益）；`llm_config_changed` 事件；`resolve_connection` / `list_connections`（P4 的"复用 LLM 连接"）；`LlmQuickSetup`（P5）。要遵守：`rag::RagManager::search_async` 是 P4 的接口，P1 只调用。

**验收**：

- 单测：共享 URL 用例 + 各协议拼接；UTF-8 跨块；流里的错误；`<think>` 剥离；`extra_body` 合并；迁移五种情况（全新安装、custom bearer、Claude + 备用、坏文件、更高的 schema 版本）；垫片幂等；`get_provider()` 两次拿到的锁都能 `try_lock`（证明不再排队）；路由解析（跟随链、删除连接、停用连接、Claude 不可用转备用）。
- 手动：建 3 个连接（你那个不是 `/v1` 的 OpenAI 兼容端点、DeepSeek 或硅基流动、本机或局域网的 Ollama），预览地址都对；手填模型；测试成功和失败的显示；翻译和总结选不同模型；开着实时 LLM 翻译时 AI 助手不排队；错误的 Key 显示 401 原文；Mac 上 Claude 登录能打开终端。

**估时**：M1 约 2.5–3 人日（后端约 1.5、前端约 1.2）；M2 约 1 人日。

### 4.3 P2 语音识别

**M1**：远程 STT（3.4）；"我/对方"分开设识别语言和自动检测（3.6）；Soniox 基础版（3.5：转写、one_way 译文、入库、"对方"直出分支、keepalive、简单重连、设置卡片里的 Key / 区域 / 模型）；whisper_cpp 冲突、Mac 上隐藏 Windows Speech、Metal（3.9）；`MeetingAudioSettings` / `STTSettings` 改用 `providerMeta` 和 `LanguageCombobox`；`SttQuickSetup`；本包文件的中文化。**M2**：Soniox 说话人分离、端点参数、`/v1/models` 候选、重连后的时间偏移、290 分钟换会话、同室模式 two_way；远程 STT 积压合并；`presets.ts` 加"自建 Whisper"预设。

建议 P2 会话内部用子代理并行写 `stt/soniox.rs` 的协议层（消息解析、片段拼接、译文对齐、错误分类，全是纯函数 + 单测，只碰这一个新文件），主线同时做注册、发射任务重构和界面。

**独占文件**：

- Rust：`src-tauri/src/stt/**`（新 `openai_compat.rs`、`soniox.rs`、`language.rs`）、`src-tauri/src/audio/**`（`recorder.rs` 在 P0 之后）、`commands/{stt,audio,model}_commands.rs`、`Cargo.toml` 的 whisper-rs 段；可选 `scripts/macos-env.sh`（本地自用构建可以 `export GGML_NATIVE=ON`，发布构建不要开）。
- TS：`src/settings/{STTSettings,MeetingAudioSettings,LocalModelManager}.tsx`、`src/settings/presets.ts`、`src/settings/stt/**`（接手 `SttQuickSetup.tsx`，新 `OpenAICompatSttSettings.tsx`、`SonioxSettings.tsx`）、`src/lib/stt/**`（接手 `providerMeta.ts`）、`src/lib/sttWatchdog.ts`、`src/stores/configStore.ts`、`src/stores/resetMeeting.ts`、`src/hooks/{useSpeechRecognition,useAudioConfigSync,useSTTStatus,useModelDownload,useNoTranscriptWarning}.ts`、`src/overlay/{StatusBar,NoTranscriptBanner}.tsx`，以及这些文件的测试。

**允许改的热点位置**：`types.ts` / `ipc.ts` / `events.ts` 的 P2 分节（6.2 节），例如 `STTProviderType` 加 `"openai_compat" | "soniox"`、两个 `update_*_config` 的 IPC 包装、`testSTTConnection` 加可选参数；`lib.rs` 的 `PLUS INIT: p2-stt`（用 `app.manage` 注册两份共享配置，**不加进 `AppState`**）和 `PLUS COMMANDS: p2-stt`；`commands/mod.rs` 不需要（命令放在现有的 `stt_commands.rs`）。

**用别人的接口**：P0 的 `providerMeta`、`LanguageCombobox`、`ModelCombobox`、`EndpointFields`、`PartyAudioConfig` 字段；P3 保持不变的 `db::translation::save_translation`、`TranslationRouter::default_target_lang()`（只调用）。

**交付给别人**：Soniox 发出的 `translation_result`（P3 直接显示）；遵守 `native_translation`；`SttQuickSetup`（P5）。

**验收**：

- 单测：远程 STT 的地址、响应解析、按顺序的 worker；`party_lang`；分路语言迁移幂等、预设保留语言；各引擎"自动检测"映射；Groq 分路语言；Soniox 协议层（用录下来的消息序列回放：final / non-final、`<end>`、原文和译文交错、迟到的译文、各类错误）。
- 手动：你另一台机器上的 faster-whisper / vLLM 能出字；我 = 中文、对方 = 英文分别生效；对方用 Soniox 时字幕和中文译文实时出来，重启 App 后会议记录里还能看到译文；Metal 开关前后同一段音频的耗时写进报告；Mac 上看不到 Windows Speech；旧配置里的 whisper_cpp 不再被改成 Deepgram。

**估时**：M1 约 2 人日（Soniox 约 0.75）；M2 约 1 人日。

### 4.4 P3 翻译

**M1**：3.6 节"翻译"部分标"第一版"的全部；`useTranslation` 拆成两个 hook 并加"一段 final 只触发一次翻译"的回归测试；`TranslationQuickSetup`；本包文件的中文化。**M2**：3.6 节表里"之后"那一列中改动小的（自动翻译开关保存、`test_translation_connection` 尊重服务商参数、缓存键加上服务商和模型）。

**独占文件**：

- Rust：`src-tauri/src/translation/**`（新 `lang_map.rs`）、`commands/{translation,translation_model}_commands.rs`、`db/translation.rs`（`save_translation` 签名不变）。
- TS：`src/settings/{TranslationSettings,OpusMtModelManager}.tsx`、`src/settings/translation/**`（接手 `TranslationQuickSetup.tsx`）、`src/lib/translation/**`（新 `types.ts`、`ipc.ts`、`nativeTranslation.ts`）、`src/stores/translationStore.ts`、`src/hooks/useTranslation.ts`（及拆出来的新 hook）、`src/components/{TranslationPopup,SelectionToolbar}.tsx`、`src/overlay/{OverlayView,TranscriptPanel,TranscriptLine}.tsx`、`src/launcher/meeting-details/PostMeetingTranslationToolbar.tsx`。

**允许改的热点位置**：`App.tsx` 的翻译初始化（第 56 行、71–87 行，改成调用 `translationStore` 的同步函数并把错误显示出来）；`types.ts` / `events.ts` 的 Translation 分节（尽量不改，新类型放 `src/lib/translation/types.ts`，`TranslationResult` 加可选字段 `is_final?` 可以）；**不改** `lib.rs`（不加新命令）、`ipc.ts`、`configStore.ts`（通过 `setMeetingAudioConfig` 写 `native_translation`）。

**用别人的接口**：P0 的 `llm::api::complete_text`、`LanguageCombobox`、`languages.ts`、`providerMeta` 的 `supportsNativeTranslation`、`PartyAudioConfig.native_translation`。

**交付给别人**：`TranslationQuickSetup`（P5）；保持 `save_translation`、`default_target_lang()` 的签名，并把真实目标语言推给后端（P2 的 Soniox 依赖）。

**验收**：

- 单测：`lang_map`（DeepL、微软、谷歌的代码映射）、三家的端点拼接、输出清洗、静置防抖和过期守卫、按路过滤和"识别引擎自带翻译"的跳过规则、一段 final 只触发一次翻译请求、合并行拼接译文。
- 手动：目标语言自填 `ja` 能用；只翻译对方；DeepL 自定义端点；LLM 翻译用的是任务路由里的模型（P1 合并后验证）；AI 调用日志里每句话只有一次翻译。

**估时**：M1 约 1.5 人日；M2 约 0.5–1 人日。

### 4.5 P4 个人知识库

**M1 / M2 / 之后**：见 3.7 节末尾。

**独占文件**：

- Rust：`src-tauri/src/rag/**`（新 `engine.rs`、`store.rs`、`flat_index.rs`、`cjk.rs`、`indexer.rs`、`embedding/{mod,openai_compat,ollama}.rs`）、`src-tauri/src/context/**`（目录改动在 P0 之后）、`commands/{rag,context}_commands.rs`、新 `commands/rag_engine_commands.rs`、`db/{rag,context}.rs`。
- TS：`src/settings/ContextStrategySettings.tsx`、`src/settings/rag/**`、`src/context/**`、`src/lib/rag/**`、`src/stores/{ragStore,contextStore}.ts`、`src/hooks/useRagEvents.ts`。

**允许改的热点位置**：`lib.rs` 的 RAG 原有初始化（181-185 两行换成一行 `rag::RagManager::bootstrap(app.handle().clone(), &app_data_dir)`）、`PLUS COMMANDS: p4-rag`（约 7 个命令）；`commands/mod.rs` 一行；`Cargo.toml` 的 `# == PLUS: rag deps ==` 段（最多 `rayon`、`base64` 两行）。其余热点文件 **0 行**。

**用别人的接口**：P0 的 `net::endpoint`、`llm::api::resolve_connection` / `list_connections`（桩返回空，界面上就不显示"复用 LLM 连接"）、`ModelCombobox`、`EndpointFields`。

**交付给别人**：`RagManager::search_async`、`get_status` 等旧方法签名不变（P1 的 `intelligence_commands.rs` 在用）。

**验收**：

- 单测：共享 URL 用例；响应解析（乱序、base64、NaN）；重试分类；CJK token 估算和中文分块；平铺索引的结果和暴力全量计算一致；块哈希差异；指纹不一致时只走关键词；`rag.db` 迁移。假的嵌入服务用 tokio 原始 TCP 自己写，不加开发依赖。
- 手动：配你的 embedding 端点（地址、Key、模型、维度）；上传中英文文档建索引；改一个文档只重建变化的部分；换模型出现"需要重建"横幅且检索不混用；会议中 AI 助手能引用文档内容。

**估时**：M1 约 2 人日；M2 约 1 人日。

### 4.6 P5 首次设置

**M1 / M2**：见 3.8 节。

**独占文件**：`src/App.tsx`（翻译初始化那几行除外）、`src/components/wizard/**`（可以整体重写，`LLMSetupStep.test.tsx` 跟着改或删）、新 `src/lib/onboarding/**`、新 `src/stores/onboardingStore.ts`、`src/stores/meetingStore.ts`（例如"打开设置并定位到某个标签"需要的状态）。如果系统音频测试需要新的 Rust 命令，新建 `commands/onboarding_commands.rs` 并在共享笔记里请主会话加锚点（第一版尽量用现有的 `startAudioTest` / `getAudioPeakLevels`）。

**允许改的热点位置**：`GeneralSettings.tsx` 加"重新运行首次设置"入口（M2，一处）。

**用别人的接口**：P0 的三个快速设置占位组件（P1、P2、P3 合并后自动变成真的）、`changeUiLanguage()`。

**验收**：测试覆盖步骤状态机（前进、后退、跳过、进度恢复）、"上传简历"打开个人知识库、完成标记；手动在全新的数据目录里完整走一遍。

**估时**：M1 约 1 人日；M2 约 0.5 人日。

### 4.7 P6 中文扫尾

**范围**：第 6 节里归 P6 的全部文件（约 60 个界面文件、700–900 条文案）抽到 i18n 并翻成中文；日期和数字改用 `formatDate()` / `formatNumber()`（`AboutSettings.tsx:39` 已在 P0 处理，`lib/agentUsage.ts` 归 P1，其余归 P6）；`src/lib/scenarios.ts` 里场景的显示名称和说明（**不改提示词**）。不改任何逻辑。

**独占**：第 6 节标 P6 的文件；命名空间 `settings`、`launcher`、`overlay`、`calllog`、`misc`，以及 P0 合并后的 `common`。

**允许改的热点位置**：无。

**验收**：第 2.6 节四条命令；`node scripts/i18n-check.mjs --report` 对 P6 的文件清零（或逐条说明不翻的原因）；现有前端测试一个不改也能过（测试用 `en`）；拿不准的译法列进共享笔记，最后给用户统一校对。

**估时**：1–1.5 人日。之后：中文版默认场景和动作提示词；Rust 常见错误改成错误码再翻译。

## 5. 中文界面（i18n）落地

### 5.1 结论

同意先搭框架、各包顺手抽、扫尾包收尾的做法，用 `i18next` + `react-i18next`。另外补四点：

1. **命名空间文件由 P0 一次性全部建好**（两种语言各一个空 JSON），每个文件只归一个包；包只往自己的命名空间写 key，即使组件在别的目录里。这样各个包分支不会改同一个 JSON。
2. **key 有类型检查**：用 i18next 的 `CustomTypeOptions`，以 `en` 资源为准生成类型，`npx tsc --noEmit` 能查出拼错的 key；`en`/`zh-CN` 的 key 是否一一对应由 `scripts/i18n-check.mjs` 检查。
3. **`en` 资源逐字保留原英文，测试环境固定 `en`**。现有 14 个前端测试按英文文案找元素（`getByText` 之类），这样一个都不用改；以后给上游提 PR，英文界面也保持原样。
4. 项目里已有 `useTranslation`（`src/hooks/useTranslation.ts`，是转写翻译功能），和 react-i18next 的同名 hook 冲突。界面文案统一用 `useT()`（从 `src/i18n` 导出，内部包一层 react-i18next），非 React 代码用 `t()`。

为什么不选别的：Lingui / Paraglide 要编译插件和抽取工具链，FormatJS 偏重；i18next 支持命名空间拆文件、运行时切换语言、在 React 之外调用，上游维护者也最熟悉，以后提 PR 阻力最小。

### 5.2 目录

```
src/i18n/
  index.ts        initI18n()、useT()、t()、changeUiLanguage()、formatDate()、formatNumber()
  resources.ts    静态 import 全部命名空间（P0 维护，之后冻结）
  i18next.d.ts    CustomTypeOptions 类型增强（以 en 为准）
  README.md       命名规范 + 术语表（内容同本文 5.4 节和附录 C）
  locales/
    en/<命名空间>.json
    zh-CN/<命名空间>.json
scripts/i18n-check.mjs   key 对齐检查 + 硬编码报告（fork 专用）
```

### 5.3 命名空间和归属

| 命名空间 | 内容 | 归属 |
|---|---|---|
| `common` | 通用按钮、状态、单位：保存、取消、删除、编辑、添加、测试连接、测试中…、已连接、失败、重试、关闭、上一步、下一步、跳过、完成、启用、默认、自定义、自动检测、可选、必填、高级、加载中、复制、已复制、搜索、导入、导出、恢复默认，以及"操作失败：{{detail}}"这类包装 | P0 建并填好；之后只有 P6 能加 |
| `settings` | 设置外壳（侧栏分组和标签）、通用、关于；以及 P6 负责的其余设置页 | P0 → P6 |
| `llm` | LLM 连接、任务路由、底栏模型切换、Claude 订阅 | P1 |
| `stt` | 识别引擎、会议音频与设备、本地模型、预设、识别语言 | P2 |
| `translation` | 翻译设置、译文显示（包括 P3 负责的悬浮窗文件）| P3 |
| `rag` | 个人知识库、上下文策略 | P4 |
| `onboarding` | 首次设置 | P5 |
| `launcher` | 主窗口、会议列表、会议详情 | P6 |
| `overlay` | 悬浮窗（P3 负责的文件除外）| P6 |
| `calllog` | AI 调用日志 | P6 |
| `misc` | 零散组件、hooks、stores、lib 里的提示 | P6 |

文件归属见第 6 节。一个文件只归一个包，这个包负责把它的文案抽到**自己的**命名空间里。

### 5.4 写法规范

- key 形式 `<命名空间>:<区域>.<元素>.<属性>`，英文小驼峰，表达"这是什么"而不是原文（上游改了英文原文，key 不用变）。例：`llm:connections.editor.baseUrl.label`、`llm:connections.editor.baseUrl.hint`、`common:actions.save`。
- 插值用 `{{name}}`。产品名用 `{{appName}}`（`interpolation.defaultVariables` 注入 `"NexQ Plus"`），不要把 "NexQ" 写死进译文。
- 英文复数用 `_one` / `_other` 后缀；中文只写 `_other`。
- **不要在模块顶层调用 `t()`**，切换语言后不会更新。常量表里存 key（`labelKey: "settings:tabs.llm"`），渲染时再翻译。`ServiceStatusBar` 的 `STT_LABELS`、`SettingsOverlay` 的标签组都是这种情况。
- 不翻译：日志（`console.*`、`log::*`）、发给 AI 的提示词（另有"AI 回答语言"设置，见 3.3）、协议字段、语言代码、模型 ID、快捷键名。
- 后端返回的错误第一版原样显示（多为英文），界面用中文包一层："测试连接失败：{{detail}}"。以后再把常见错误改成错误码（见第 1 节"之后再做"）。
- 日期、数字用 `formatDate()` / `formatNumber()`（跟随当前界面语言），不要写死 `"en-US"`（`AboutSettings.tsx:39`、`lib/agentUsage.ts:17` 现在是写死的）。
- 中文标点用全角，中英文之间不加空格也行，但同一个命名空间里保持一致；术语按附录 C。

### 5.5 语言选择和窗口同步

- 设置项 `uiLanguage`：`"system" | "zh-CN" | "en"`，存 `config.json`，默认 `"system"`（系统语言以 `zh` 开头用 `zh-CN`，否则 `en`）；缺 key 时回退 `en`。
- 入口：设置 → 通用 → 界面语言；首次设置第一步（P5）。
- `main.tsx` 在渲染**之前** `await initI18n()`，四种窗口（launcher、overlay、meeting-prompt、devlog）都覆盖。
- 两个窗口用 `store.onKeyChange("uiLanguage")` 同步，和 `configStore.ts:1208-1268` 现有做法一致；切换不需要重启。`<html lang>` 跟着改。
- Rust 侧：新 `src-tauri/src/i18n.rs` 保存当前语言和托盘/提示文字表（`tray/menu.rs` 约 15 条、`tray/tooltip.rs` 约 6 条，手写 match，不引入新 crate）；新命令 `set_ui_language(lang)`，前端切换语言时调用，再调用现有的 `rebuildTrayMenu()`。启动时 Rust 先从 `config.json` 读一次 `uiLanguage`，免得托盘先显示一下英文。系统语言跟随时，Rust 不自己探测，等前端推一次。
- `src/test/setup.ts` 里用 `lng: "en"` 初始化，保证测试稳定。

### 5.6 各包怎么抽

- 只处理第 6 节里归自己的文件。原英文写进 `en/<ns>.json`，中文写进 `zh-CN/<ns>.json`，两边 key 相同。
- 先抽用户看得见的：标签、按钮、说明、占位符、toast、错误标题、空状态；再抽 tooltip 和 `aria-label`。
- 模块顶层的选项表（例如语言列表、引擎列表）改成存 key 或在组件里 `useMemo` 生成。
- 合并前：`node scripts/i18n-check.mjs` 通过；`node scripts/i18n-check.mjs --report <本包文件>` 里剩下的条目要么清掉，要么在报告里说明为什么不翻（品牌名、协议字段等）。
- 中文译文要自然，按附录 C 统一术语；拿不准的在共享笔记里列出来，最后让用户统一校对。

### 5.7 和上游同步时

i18n 只做在 fork 里的话，上游每改一处界面英文都会和 `t()` 调用冲突。处理办法：保留 fork 的 `t()`，把上游的新英文写进 `en/*.json` 对应 key，再更新 `zh-CN`；上游新加的界面先合进来（英文硬编码），下一次扫尾时补。所以 v1 之后要尽快合一次上游，之后保持每周合（OVERHAUL_PLAN 第 6 节）。

### 5.8 以后提给上游

框架（`src/i18n/` + 一个页面）可以单独成一个 PR，先在 naxhq/NexQ#28 问维护者意见（OVERHAUL_PLAN 3.4）。fork 的命名空间拆分、`useT` 命名、类型检查都按上游可接受的样子做，到时候只需要按页面拆批。

## 6. 文件归属总表

规则：一个文件只归一个包（标了"之后"的，表示 P0 先改一处、合并后交给后面的包）；不在表里的新文件，归创建它的包；表里没列、也不是新建的文件，第一版谁都不改，需要改先在共享笔记里登记。测试文件跟着被测文件走。

### 6.1 前端 `src/`

| 归属 | 文件 |
|---|---|
| **P0** | `main.tsx`、`i18n/**`、`test/setup.ts`；`lib/{brand,endpoint,languages,platform}.ts`、`lib/endpointCases.json`；`components/{ModelCombobox,LanguageCombobox,EndpointFields,UpdateToast}.tsx`；`hooks/useUpdater.ts`；`settings/{SettingsOverlay,GeneralSettings,AboutSettings}.tsx`（之后：`SettingsOverlay` 只有 P1 能改 `llm` 那一行，`GeneralSettings` 只有 P5 能加一个入口）|
| **P0 之后 P1** | `components/ServiceStatusBar.tsx`（P0 只做 STT 元数据抽取）、`settings/llm/LlmQuickSetup.tsx` |
| **P0 之后 P2** | `lib/stt/providerMeta.ts`、`settings/stt/SttQuickSetup.tsx` |
| **P0 之后 P3** | `overlay/OverlayView.tsx`（P0 只删一行）、`settings/translation/TranslationQuickSetup.tsx` |
| **P1** | `settings/{LLMSettings,ClaudeCliSettings}.tsx`、`settings/openrouter/**`、`settings/llm/**`；`components/{ServiceStatusBar,AgentStatusChip}.tsx`、`components/llm/**`；`lib/llm/**`、`lib/{claudeModels,agentUsage}.ts`；`stores/agentStore.ts`、`stores/llmConnectionsStore.ts`（新）；`hooks/{useAgentFallbackToast,useMeetingAgentUsage,useSummaryGeneration,useMeetingChat,useActionItemsExtraction,useBookmarkSuggestions}.ts` |
| **P2** | `settings/{STTSettings,MeetingAudioSettings,LocalModelManager}.tsx`、`settings/presets.ts`、`settings/stt/**`；`lib/stt/**`、`lib/sttWatchdog.ts`；`stores/{configStore,resetMeeting}.ts`；`hooks/{useSpeechRecognition,useAudioConfigSync,useSTTStatus,useModelDownload,useNoTranscriptWarning}.ts`；`overlay/{StatusBar,NoTranscriptBanner}.tsx` |
| **P3** | `settings/{TranslationSettings,OpusMtModelManager}.tsx`、`settings/translation/**`；`lib/translation/**`；`stores/translationStore.ts`；`hooks/useTranslation.ts`（和拆出来的新 hook）；`components/{TranslationPopup,SelectionToolbar}.tsx`；`overlay/{OverlayView,TranscriptPanel,TranscriptLine}.tsx`；`launcher/meeting-details/PostMeetingTranslationToolbar.tsx`；`App.tsx` 的翻译初始化代码块（第 56 行、71–87 行）|
| **P4** | `settings/ContextStrategySettings.tsx`、`settings/rag/**`；`context/**`；`lib/rag/**`；`stores/{ragStore,contextStore}.ts`；`hooks/useRagEvents.ts` |
| **P5** | `App.tsx`（翻译初始化代码块除外）；`components/wizard/**`；`lib/onboarding/**`；`stores/{meetingStore,onboardingStore}.ts` |
| **P6** | 其余全部有界面文案的文件：`launcher/**`（除上面 P3 那个）；`overlay/**`（除上面 P2、P3 的）；`calllog/**`；`meeting-prompt/**`；`components/**`（除上面列出的）；`settings/{AIActionsSettings,ScenarioSettings,HotkeySettings,ShortcutButton,StealthSettings,MeetingDetectionSettings,PromptPreviewDialog,AudioSettings,NoisePresetSettings,ConfidenceSettings}.tsx`；`hooks/**`、`stores/**`、`lib/**` 里除上面列出的文件 |
| 不翻、不改 | `demo/**`（演示数据）|
| 按分节 | `lib/types.ts`、`lib/ipc.ts`、`lib/events.ts`（6.2）|

### 6.2 `types.ts` / `ipc.ts` / `events.ts` 的分节归属

三个文件顶部的 `import type {…}` 块**谁都不改**。表里没有的分节冻结。

| 包 | `types.ts` 分节 | `ipc.ts` 分节 | `events.ts` 分节 |
|---|---|---|---|
| P1 | `AI/LLM TYPES`、`OPENROUTER ENRICHED MODEL`、`LLM PROVIDER TYPES`、`CLAUDE CLI (SUBSCRIPTION) TYPES`、`AI ACTION CONFIG TYPES`、`IPC EVENT PAYLOAD TYPES` 里的 `Stream*` 类型 | `LLM`、`Intelligence`、`Action Configs`、`Gemini Context Cache`、`Claude CLI (subscription)`、`Ask this meeting` | `LLM STREAM EVENTS`、`CLAUDE CLI EVENTS` |
| P2 | `AUDIO TYPES`、`TRANSCRIPT TYPES`、`DEEPGRAM CONFIG`、`GROQ CONFIG`、`STT PROVIDER TYPES`、`LOCAL STT ENGINE TYPES`、`TWO-PARTY AUDIO MODEL`（P0 先加两个字段）、`STT CONNECTION STATUS` | `Audio`、`STT`、`Whisper Dual-Pass Config`、`Local STT Models`、`Deepgram Config`、`Groq Config`、`Pause Threshold`、`Deepgram Cost Estimation`、`In-Person Meeting Mode` | `TRANSCRIPT EVENTS`、`AUDIO EVENTS`、`MODEL DOWNLOAD EVENTS`、`STT STATUS EVENTS`、`SPEAKER DETECTION EVENTS` |
| P3 | `Translation`、`OPUS-MT Models` | `Translation`、`OPUS-MT Models` | `Events: Translation` |
| P4 | `CONTEXT TYPES`、`RAG / CONTEXT INTELLIGENCE TYPES` | `Context`、`RAG` | `RAG EVENTS` |

### 6.3 Rust 和构建配置

| 归属 | 文件 |
|---|---|
| **P0** | `src-tauri/tauri.conf.json`、`tauri.macos.conf.json`、`tauri.windows.conf.json`、`Info.plist`；`build-mac.sh`、`index.html`、`package.json`、`package-lock.json`、`scripts/i18n-check.mjs`；`src-tauri/src/{i18n,paths}.rs`（新）、`net/**`（新）、`credentials/**`、`tray/**`、`commands/tray_commands.rs`、`state.rs`、`db/migrations.rs` |
| **P0 建锚点，各包按 2.3 改** | `src-tauri/src/lib.rs`、`commands/mod.rs` |
| **P0 之后 P1** | `llm/api.rs`（桩）、`llm/mod.rs`（一行）、`llm/cli_agent/command.rs`（沙箱目录名）|
| **P0 之后 P2** | `audio/recorder.rs`（录音目录）|
| **P0 之后 P4** | `context/mod.rs`（上下文目录）|
| **P1** | `llm/**`、`intelligence/**`、`commands/{llm,intelligence,meeting_chat,claude_cli,gemini_cache}_commands.rs`、`commands/llm_connection_commands.rs`（新）|
| **P2** | `stt/**`、`audio/**`、`commands/{stt,audio,model}_commands.rs`、`Cargo.toml` 的 whisper-rs 段、`scripts/macos-env.sh`（可选）|
| **P3** | `translation/**`、`commands/{translation,translation_model}_commands.rs`、`db/translation.rs` |
| **P4** | `rag/**`、`context/**`、`commands/{rag,context}_commands.rs`、`commands/rag_engine_commands.rs`（新）、`db/{rag,context}.rs`、`Cargo.toml` 的 `# == PLUS: rag deps ==` 段 |
| **P5** | `commands/onboarding_commands.rs`（新，只在确实需要时）|
| 冻结 | `meeting_detect/**`、`db/{mod,meetings,meeting_chat}.rs`、`commands/{meeting,recording,stealth,settings,log,updater,credential}_commands.rs`、`logging.rs`、`ort_runtime.rs`、`build.rs`、`.github/**` |

## 7. 合并顺序和集成验收

### 7.1 时间线（目标：11-03 能装）

| 时间 | 做什么 | 谁 |
|---|---|---|
| 11-01 晚 | 把 `test/claude-login-windows-only` 合进 `custom`；P0 开工（可拆成 P0a、P0b 两个会话并行）；合并 P0；主会话编一次、运行一次，按 3.1 的验收确认身份隔离 | 主会话 + 1–2 个会话 |
| 11-02 | P1a、P1b、P2、P3、P4、P5、P6 七个会话并行。每个包先做完 M1 并在共享笔记里交接，通知主会话，再做 M2 | 7 个 worktree 会话 |
| 11-02 晚 – 11-03 上午 | 谁的 M1 好了就合谁（推荐顺序见 7.2），每合一个跑一遍 7.3 的检查；处理集成胶水（7.4）；`./build-mac.sh` 打包安装 | 主会话 |
| 11-03 | 用户按 7.5 试用；修问题；没做完的 M2 顺延 | 用户 + 主会话 |

同时编译的会话多时机器会卡：前端为主的 P1b、P5、P6 基本只跑 `tsc` 和 `vitest`，真正吃 CPU 的是 P1a、P2、P3、P4 四个 Rust 会话，各自第一次全量编译之后都是增量。

到 11-03 中午还没完成 M1 的包，先不合，用已经合进来的部分出第一版；没合的功能保持原样（还是上游的行为），不会坏。

### 7.2 合并顺序

1. **P0**（地基）：其余所有包都从合并 P0 之后的 `custom` 拉分支。
2. **P1 LLM**（P1a 先、P1b 后）：`llm::api` 的真实实现在这里，P3、P4、P5 都会用到；`ServiceStatusBar.tsx` 也归它。
3. **P2 STT**：`configStore.ts` 的所有者；Soniox 引擎发出的译文事件给 P3 用。
4. **P3 翻译**：依赖 P1（LLM 翻译走任务路由）和 P2（Soniox 译文、每路语言）。P1、P2 没合时它也能编译（用的是 P0 的桩），只是 LLM 翻译还走旧的全局模型、Soniox 译文暂时没有来源。
5. **P4 RAG**：基本独立。
6. **P5 首次设置**：用 P1、P2、P3 交付的"快速设置"组件；那些包没合时显示的是 P0 的占位组件。
7. **P6 中文扫尾**：文件和别的包不重叠，放最后合是为了让前面的合并 diff 干净；如果它先做完，也可以提前合。

顺序只是推荐，不是硬依赖：因为有 P0 的桩，任何一个包都能单独合进 `custom` 并通过编译。

### 7.3 每次合并后的检查

在 `custom` 上（主会话的工作目录）：

1. 第 2.6 节的四条命令全部通过。
2. `generate_handler!` 里本包的命令都在，`commands/mod.rs` 的 `pub mod` 都在（解决冲突时容易漏）。
3. `node scripts/i18n-check.mjs --report src` 的剩余条数只减不增。
4. 有冲突时按第 2.3 节的裁决方处理，处理结果单独提交：`chore(integration): merge plus/pX-…`。

### 7.4 集成胶水（不归任何一个包、合并后由主会话做）

- `Cargo.lock`、`package-lock.json` 冲突后重新生成。
- 把各包在共享笔记里登记的"需要别的包配合"的事项逐条处理（例如某个包需要的 npm 依赖、需要在别人文件里加的一行）。
- 全量跑一遍 `node scripts/i18n-check.mjs --report src`，零散的漏网文案由主会话补到 P6 的命名空间。
- 第一版发布前合一次上游 `main`（`git merge main`，`main` 先快进到 `upstream/main`），冲突按 5.7 处理。如果时间紧，可以放到 v1 之后马上做。

### 7.5 打包和用户验收

```bash
bash -c 'source scripts/macos-env.sh && ./build-mac.sh'
```

装到 `/Applications/NexQ Plus.app`（P0 改过脚本之后才能跑这条）。用户验收清单：

1. `/Applications` 里官方 NexQ 和 NexQ Plus 并存，两个都能打开；NexQ Plus 第一次打开是空白配置，首次设置是中文。
2. 主窗口、所有设置页、悬浮窗、托盘菜单都是中文；切到 English 立即生效，两个窗口同时变。
3. 新建一个 OpenAI 兼容连接，Base URL 填你那个不是 `/v1` 的地址，预览里的最终地址正确；模型名手填；测试通过；AI 助手能流式回答。
4. 给"实时翻译"选一个快模型、给"会议总结"选一个强模型；开着实时 LLM 翻译时点 AI 助手，两边同时出结果，不排队。
5. 故意填错 Key：看到的是 401 原始错误和实际请求地址，不再是 Ollama 的错误。
6. 我 = 中文、对方 = 英文（或自动检测），分别生效；对方用 Soniox，字幕和中文译文实时出来；我用你另一台机器上的远程 STT，能出字。
7. 翻译目标语言自填一个代码（例如 `ja`）能用；可以只翻译"对方"；LLM 翻译用的是指定的连接和模型；每句话只翻译一次（看 AI 调用日志）。
8. 本地 whisper.cpp 开 GPU（Metal）后，同一段音频明显比关掉快。
9. 个人知识库配上 OpenAI 兼容的 embedding 端点（地址、Key、模型、维度），上传一个文档建索引；改一下文档，只重建改了的部分；测试检索能搜到中文内容。
10. 首次设置里"上传简历"能打开个人知识库；中途退出，再打开能接着做。
11. （用 Claude 订阅的话）Mac 上"登录"按钮能打开终端。
12. 官方 NexQ 的数据目录 `~/Library/Application Support/com.nexq.app` 和钥匙串里的 `NexQ:*` 条目都没变。

## 8. 风险和应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 六个包并行、集成时间只有半天 | 11-03 装不上 | 每个包分 M1/M2，M1 先合；P0 的桩保证任何一个包都能单独合进 `custom` 并编译通过；按第 9 节问题 5，没完成的包不等 |
| P1、P2 工作量最大，是关键路径 | 第一版缺 LLM 自定义或 Soniox | P1 拆成前后端两个会话；P2 会话内部用子代理写 Soniox 协议层；两个包的 M1 都按"先能用、再好用"排序（例如 P1 的底栏快切、P2 的说话人分离都在 M2）|
| 新的原生依赖在 Windows 上链接失败 | 以后发 Windows 版时才暴露 | 第一版不引入新的 C/C++ 依赖（3.7）；以后要加，fork 的 CI 在 Windows 上做一次 release 链接（上游 CI 只跑 `cargo check`）|
| P0 拖延 | 所有包都开不了工 | P0 拆成 P0a（身份隔离 + i18n 框架）、P0b（共享契约）两个会话并行；P0 只做骨架和桩，不做功能 |
| Soniox 文档里两个"未确认"（译文到达时序、one_way 遇到目标语言）| 字幕错位、漏译 | 片段拼接写成纯函数 + 兜底规则 + 单元测试；第一次真实联调专门看这两点 |
| 抽取 i18n 改动面大 | 界面回归、测试挂 | `en` 逐字保留原文、测试固定 `en`；各包自测；P6 最后合 |
| 上游每月一百多个提交 | 之后合并越来越难 | 新代码进新文件、热点文件只在锚点加一行；第一版之后立刻合一次上游，之后每周合（OVERHAUL_PLAN 第 6 节）|
| ad-hoc 签名每次重编 cdhash 都变 | 麦克风、系统录音权限可能要反复授权；钥匙串条目访问可能弹窗 | 可选：按 OVERHAUL_PLAN 4.5 建一个自签名代码签名证书，`tauri.macos.conf.json` 的 `signingIdentity` 指向它（P0 可以顺手做，需要用户在钥匙串里点几下）|
| Metal 构建或运行出问题 | whisper.cpp 崩溃、变慢 | Metal 只在 macOS target 开；运行时 GPU 开关，初始化失败自动退回 CPU |
| 旧配置迁移出错 | 用户要重填 Key | 迁移只读不删、只跑一次、有单元测试；自用版本来就是全新安装，影响有限 |
| 联调烧真实额度 | Soniox、LLM 费用 | 协议层用录制数据做单元测试；联调用短音频；建议给 Soniox project 设月度预算上限 |
| 多个会话同时编译 | 机器卡顿 | 每个 worktree 独立 `target`；`cargo test` 错开跑；第一次全量编译后都是增量 |
| 两个版本同时运行 | 全局快捷键、会议检测弹窗互相干扰 | 不同时运行（关于页写明）|

## 9. 需要用户拍板的问题

都给了推荐默认值。不回答就按默认值做，方案不会因此停下来。

1. **AI 用什么语言回答？**（影响 AI 助手、会议总结、会议问答、待办提取；翻译不受影响）
   默认：**跟随界面语言（中文）**。可选：跟随会议转写的语言（即现在的行为）、固定某种语言。设置放在"设置 → AI 模型 → 任务路由"页顶部，随时可改。
2. **自动更新怎么处理？**
   默认：**第一版完全关闭**。以后要自动更新，再按 Phase 5 自己生成签名密钥、在 fork 的 Releases 发版。
3. **Soniox 两路都开，还是只开"对方"？**
   默认：**只有"对方"用 Soniox**（识别 + 实时翻译成中文，约 $0.12/小时起）；"我"用本地 whisper.cpp（开 Metal）或你的远程 STT，不翻译。两路都用 Soniox（约 $0.24/小时起）的配置同样支持，在设置里切换即可。
4. **要不要把官方版的数据带过来？**
   默认：**不自动导入**，保证两边互不影响。已下载的本地模型可以按 3.1 的命令手动复制；会议记录导入以后再做。
5. **11-03 中午还有包没完成第一版范围，怎么办？**
   默认：**先用已经合并的部分出包**，没合进来的功能保持上游原样（不会坏），剩下的顺延到下一版，不为凑齐全部功能推迟能装的版本。

## 附录 A：Soniox 实时 API 速查（2026-11-01 官方文档）

> 文档站已迁到 `docs.soniox.com`，任意页面 URL 加 `.mdx` 能拿到 Markdown 原文，全量在 `https://docs.soniox.com/llms-full.txt`，实现时直接查。下面标"未确认"的是文档没写清或前后矛盾的地方，第一次用真实 Key 联调时要验证。没有官方 Rust SDK；移植时最值得读的是官方 JS SDK 的 `packages/core/src/realtime/stt.ts`（github.com/soniox/soniox-js）。

**端点**

| 区域 | REST | 实时 WebSocket |
|---|---|---|
| 美国（默认）| `https://api.soniox.com` | `wss://stt-rt.soniox.com/transcribe-websocket` |
| 欧盟 | `https://api.eu.soniox.com` | `wss://stt-rt.eu.soniox.com/transcribe-websocket` |
| 日本 | `https://api.jp.soniox.com` | `wss://stt-rt.jp.soniox.com/transcribe-websocket` |
| 印度 | `https://api.in.soniox.com` | `wss://stt-rt.in.soniox.com/transcribe-websocket` |

区域跟着 Soniox 的 project 走，Key 必须打对应区域的域名。区域 WS 路径文档没逐个写出，按同样的 `/transcribe-websocket` 处理（未确认）。

**鉴权**（2026-10 改版）

- 握手时带 `Authorization: Bearer <key>`（原生客户端用这个；浏览器才用 `Sec-WebSocket-Protocol: soniox-api-key, <key>`）。
- 首条消息里的 `api_key` 字段**已弃用**，2027-01-15 起只在首条消息带 Key 的连接会被 401 拒绝。**NexQ 一开始就用握手头，start 消息里不放 Key。**
- Key 错误时握手照样成功，随后收到一条错误帧再被关闭，所以要按错误帧处理鉴权失败。
- 临时 Key：`POST /v1/auth/temporary-api-key`（`usage_type: "transcribe_websocket"`、`expires_in_seconds` 1–3600、可选 `max_session_duration_seconds`），返回 `snx_temp_…`。官方建议不可信客户端用临时 Key；NexQ 是用户自带 Key 的桌面程序，Key 只在 Rust 里用、存钥匙串，**第一版直接用长期 Key**。

**模型**

- 当前唯一在用的实时模型 `stt-rt-v5`（2026-06-16 发布），**默认值**。`stt-rt-v4` 是指向 v5 的别名；更老的 `stt-rt-v3`、`stt-rt-preview*` 已移除。
- `GET /v1/models`（Bearer，Key 需要 "Model listing" 权限）返回 `{"models":[…]}`：`id`、`name`、`aliased_model_id`、`transcription_mode`（`real_time`/`async`）、`languages`、`translation_targets`、`two_way_translation_pairs`、`one_way_translation`/`two_way_translation`（`"all_languages"`）、各种 `supports_*` 能力标志。界面用它做候选列表（过滤 `real_time`）+ 允许手填；"测试 Key"也调它：200 正常，401 Key 无效，403 Key 有效但缺列模型权限（实时转写可能仍可用）。

**start 消息**（连接后第一条，文本帧 JSON）

| 字段 | 说明 |
|---|---|
| `model` | 必填，如 `stt-rt-v5` |
| `audio_format` | 必填。裸 PCM 用 `pcm_s16le` 等全名（还要给 `sample_rate`、`num_channels`）；带容器的用 `auto` |
| `language_hints` | ISO 639-1 两字母数组（中文只有 `zh`，没有地区变体），只做偏置 |
| `language_hints_strict` | 尽量只输出 hints 里的语言；只给一种语言时效果最好 |
| `enable_language_identification` | token 带 `language` |
| `enable_speaker_diarization` | token 带 `speaker`（"1"、"2"…，最多 15 人）|
| `enable_endpoint_detection` | 输出 `<end>` 作为一句话的结束 |
| `max_endpoint_delay_ms` | 500–3000，默认 2000（字幕场景建议 1000–1500）|
| `endpoint_sensitivity`、`endpoint_latency_adjustment_level` | 仅 v5，旧模型传了报 400；按 `/v1/models` 的 `supports_*` 决定是否显示 |
| `context` | 对象：`general`（`[{key,value}]`）、`text`、`terms`（专有名词）、`translation_terms`（`[{source,target}]`）；总共不超过约 8000 token；按输入 token 计费 |
| `translation` | `{"type":"one_way","target_language":"zh"}` 或 `{"type":"two_way","language_a":"zh","language_b":"en"}`；每个会话只能一个目标语言或一对语言 |
| `client_reference_id` | ≤256 字符，记进用量日志，建议 `nexq:<会议 id>:<you\|them>` |

**音频和控制消息**

- 音频用二进制帧，按实时速度发，建议每 100 ms 一帧（16 kHz s16le 单声道 = 3200 字节）。**静音也照常发**：端点检测要靠"听到"停顿，而且按会话时长计费，持续推流不多花钱。
- 静音期间完全不发数据超过 **20 秒**会被 408 断开；只有主动闭麦/暂停时改发 `{"type":"keepalive"}`，每 5–10 秒一次。
- 手动定稿 `{"type":"finalize"}`，服务器回一个 `<fin>` token；不要太频繁（每几秒一次可以）。
- **结束流发空的文本帧 `""`**（空二进制帧只算空音频，不会结束），然后等 `"finished": true`。
- 单个会话最长 **300 分钟**，到点 413，要新开会话。

**返回消息**

- 普通消息：`tokens`、`final_audio_proc_ms`、`total_audio_proc_ms`；最后一条带 `finished: true`。
- token：`text`（子词，自带前导空格，直接拼接）、`start_ms`/`end_ms`（**译文 token 没有**）、`confidence`、`is_final`、`speaker`、`language`、`translation_status`（`original`/`translation`/`none`，只在开了翻译时出现）、`source_language`（只在译文 token 上）。
- 拼接规则：每条消息里的 final token 只出现一次，追加到已定稿部分；non-final token 是"当前完整的尾部"，每条消息整体替换上一条的尾部。显示 = 已定稿 + 当前尾部。
- 原文和译文在同一条流里交错：一段原文，接着这段的译文，再下一段原文……译文在句子中途就开始流出，和原文不是逐 token 对应，靠顺序对齐。官方 S2S demo 的做法：每句维护 `{原文 final, 原文 partial, 译文 final, 译文 partial}`，每条消息先清空两个 partial，遇到 `<end>` 就把当前句存档、开新句。"一句的译文一定在它的 `<end>` 之前到齐"文档没保证（未确认），要做兜底：句子已存档后才到的译文，补到上一句。
- 错误帧：`tokens: []` + `error_code`、`error_type`（**按它分支**）、`error_message`、`more_info`、`request_id`，之后服务器关闭连接。

**错误和重连**

| 情况 | 处理 |
|---|---|
| 408 `request_timeout`、500、503、WS 1006 无 close frame | 自动重连，指数退避加抖动（1 秒起，上限 30 秒）|
| 429 `limit_exceeded` / `max_concurrent_connections_reached` | 至少等 20 秒再试（断开的旧流可能还占着并发名额）|
| 413 `max_duration_reached` | 立即新开会话 |
| 400 / 401 / 402（余额或预算用完）/ 403 | 不重试，把原因显示给用户 |

默认限额：每分钟 100 次请求、10 路并发（两路会话占 2 路）。每个会话的时间戳从 0 开始，重连后要按已发送的采样数维护偏移量。

**价格**：实时约 $0.12/小时/会话（按会话时长计，暂停也计费），译文按输出 token 另计，估计每路每小时多约 $0.06（官方说法有冲突，以用量日志为准）。"我"和"对方"各开一个会话 ≈ $0.24/小时起。

**网络**：用户机器上 soniox 域名解析到 `198.18.x.x`，是 fake-IP 代理（TUN 模式），直连 WebSocket 会走代理，可用。`tokio-tungstenite` 本身不支持 HTTP/SOCKS 代理，非 TUN 用户要另做隧道（之后再做）。

## 附录 B：LectureLive 对照表（借鉴什么、不照搬什么）

LectureLive（`PLus123456/lecture-live`，GPL-3.0，HEAD `396fe75`）只借鉴设计：数据模型、字段、默认值、交互。NexQ 是 MIT，部分改动以后要提给上游，**不复制它的代码**，实现时也不要打开它的源文件对着改写。

| 方面 | LectureLive 的做法 | NexQ 怎么用 |
|---|---|---|
| LLM 数据模型 | 三层：网关（连接：名称、Base URL、Key、是否 Anthropic）→ 模型库（模型 ID 手填、显示名、类型 TEXT/EMBEDDING、是否支持图片、最大输出、上下文窗口、验证状态）→ 用途路由（每个用途一个默认模型，可单独设温度和思考模式）| 采用三层思路，但做成单用户版本：**连接**（含多种协议、认证方式、自定义请求头）→ 连接下的**模型列表**（手填 + `/models` 拉取的候选）→ **任务路由**（每个任务选"连接 + 模型 + 参数覆盖"，或跟随默认）。见 3.3 |
| 用途和默认温度 | 问答 0.6、实时摘要 0.3、最终总结 0.4、关键词 0.2、翻译 0.2；实时摘要卡片上提示"高频，建议关闭思考" | 作为 NexQ 各任务的默认参数参考；高频任务（实时翻译、问题检测）在界面上提示"选快模型、关闭思考" |
| 思考模式 | 四值（不发 / 自动 / 强制 / 按深度）+ 深度档位，统一换算成 Anthropic 的 `budget_tokens` 或 OpenAI 的 `reasoning_effort` | 第一版只做"是否解析 `reasoning_content`"和"额外请求体 JSON"（用户可以自己写 `reasoning_effort`）；完整的思考模式换算放到之后。LectureLive 对所有兼容端点都发 `reasoning_effort`、关闭时还发 `minimal`，不少兼容端点会 400，**不照搬** |
| 模型验证 | 每个模型一个状态（未验证 / 正常 / 失败）+ 最后错误 + 最后检查时间，改了模型 ID 就重置；连接卡片汇总显示 | 采用一半。"测试对话"对指定模型发一次最小请求（`max_tokens` 很小、内容 `ping`），第一版结果记在连接上（`verified_at_ms` + 最后一次错误），按模型分别记状态放到之后 |
| URL 规则 | Base URL 原样 + `/chat/completions`；Anthropic 是 Base + `/v1/messages`（两种协议规则不对称）；没有覆盖、没有预览 | 同样"不自动补 `/v1`"，另加完整地址覆盖和实时预览（2.5 节）。每种协议沿用 NexQ 现有的拼接方式（Anthropic 是 Base + `/v1/messages`，见 `llm/anthropic.rs:205`，所以 Anthropic 的 Base URL 不含 `/v1`），规则不对称没关系，界面预览把最终地址写清楚 |
| Key | 加密存库，前端只看到掩码；编辑时留空表示保留；改端点必须重新输入 Key | Key 进钥匙串、前端只看"已保存 + 尾号"；**改了 Base URL 或协议时要求重新输入 Key**（防止已存的 Key 被发到新主机）这一条采用 |
| 内网限制 | 出站只允许公网、强制 HTTPS | **不照搬**：桌面端必须能连 localhost、局域网、http（Ollama、LM Studio、自建服务）|
| Soniox 配置 | 模型 `stt-rt-v5`；`language_hints` 平时 `[源语言]`；只有一个提示时开 `language_hints_strict`；开说话人分离、语言识别、端点检测；`max_endpoint_delay_ms` 2000；`context.general` 放领域和主题，`terms` 合并手填术语和文件关键词（总预算 6000 字符），并把术语原样放进 `translation_terms`（术语不翻译）| 采用大部分；但 `language_hints_strict` **默认关闭**（会议里中英混说会被压掉一种语言）；端点延迟、说话人分离做成可调；`context` 用会议名称、场景、参会人、个人知识库里的关键词填（之后再做）|
| Soniox 分段 | final 追加、non-final 整体替换；按端点事件分段，或者"足够长且以句末标点结尾"时分段；暂停、停止、重连前先强制结算当前段 | 采用（见 3.5）。会议场景另外按说话人切段 |
| 译文对齐 | 每段的译文状态（等待 / 流式 / 完成）；段语言已经是目标语言时直接显示原文；two_way 时目标语言取另一种；译文先按时间对齐，没有时间戳的挂到当前段或待补段 | 采用"状态 + 原文直通 + 待补兜底"。Soniox 的译文 token 本身没有时间戳，所以 NexQ 按**顺序**对齐（3.5）|
| 连接生命周期 | 寿命到期前 30 秒主动换连接；最多重连 5 次，间隔 1.5 秒起每次 ×1.5，连接稳定 8 秒才清零重试计数；单场上限错误不重试；运行中改了相关设置就重建会话（时间轴延续）| 采用重连参数和"稳定 8 秒才清零"；300 分钟上限前主动换连接；改语言/翻译设置时重建会话 |
| 不照搬 | 临时 Key 签发、额度预扣、用量对账、用户组配额（多租户 SaaS 才需要）；空闲 5 分钟自动暂停；靠"暂停超过 15 秒就重建"代替 keepalive | NexQ 是单用户桌面端：Rust 直接持 Key 连 WebSocket，暂停时发 keepalive |
| 翻译 | 实时翻译默认走 Soniox 原生 one_way；同传页用 two_way；文本翻译用 LLM（提示词写死）；语言表有 4 份不同步的副本 | Soniox 原生翻译和 LLM 翻译都支持，按"每一路"选；LLM 翻译提示词可编辑；**语言表只维护一份**（代码、中文名、英文名、本语言名，P0 的 `src/lib/languages.ts`）|
| 首次设置 | 步骤：数据库 → 管理员 → LLM → Soniox；不做任何连通性测试；表单不保存 | 只借鉴"自动跳到第一个没完成的步骤"；NexQ 每一步都实际测一次（LLM 发 ping、Soniox 调 `/v1/models`、STT 录几秒试识别），进度要保存 |
| 界面多语言 | 自研 Context，资源是 TS 对象，缺 key 时直接显示 key 路径，`t()` 不校验 key | 不照搬：NexQ 用 i18next，缺 key 回退英文，key 有类型检查（第 5 节）|
| 观测 | 日志只记元数据（模型、用途、耗时、用量），不记内容；界面显示建连耗时和出字延迟（指数平滑）| 日志原则采用；NexQ 已有 `StreamLatency`，Soniox 接上即可 |

## 附录 C：术语表

| 英文 | 中文 | 备注 |
|---|---|---|
| Overlay | 悬浮窗 | |
| Launcher | 主窗口 | |
| Meeting | 会议 | |
| Transcript | 转写记录；实时显示时叫"字幕" | |
| Segment | 片段 | |
| You / Them | 我 / 对方 | 同室模式下的 Room 叫"现场" |
| Speaker | 说话人 | |
| Diarization | 说话人分离 | |
| STT（Speech-to-Text）| 语音识别 | |
| Engine | 识别引擎 | STT 用"引擎" |
| Provider | 服务商 | LLM、翻译用"服务商" |
| Connection | 连接 | LLM 连接配置档 |
| Task routing | 任务路由 / 按任务选模型 | |
| Model | 模型 | |
| Base URL | 接口地址（Base URL）| 首次出现时括注英文 |
| API Key | API Key | 不译 |
| Endpoint | 端点 | |
| Auth | 认证方式 | |
| Header | 请求头 | |
| Test connection | 测试连接 | |
| Translation | 翻译 | |
| Source / Target language | 源语言 / 目标语言 | |
| Auto-detect | 自动检测 | |
| Context | 上下文 | |
| Context Intelligence / RAG | 个人知识库（RAG）| |
| Embedding | 向量化（embedding）| |
| Index / Indexing | 索引 / 建立索引 | |
| Chunk | 文本块 | |
| Rerank | 重排序 | |
| Hybrid search | 混合检索 | |
| AI Actions | AI 动作 | |
| Assist | AI 助手 | |
| Summary | 会议总结 | |
| Action items | 待办事项 | |
| Bookmark | 书签 | |
| Topic | 话题 | |
| Scenario | 场景 | |
| Stealth mode / Hide from Screen Share | 共享屏幕时隐藏 | |
| Hotkey / Shortcut | 快捷键 | |
| Noise preset | 降噪预设 | |
| Confidence | 置信度 | |
| Call log | AI 调用日志 | |
| Recording | 录音 | |
| Local model | 本地模型 | |
| Fallback | 备用 | |
| Subscription（Claude）| 订阅 | |
| Ask this meeting | 问这场会议 | |
| First-run wizard / Onboarding | 首次设置 | |
