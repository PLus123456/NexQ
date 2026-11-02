# NexQ 上游功能提案草稿

状态：**仅本地草稿，未发布**。核对日期：2026-11-02（Asia/Singapore）。目标仓库：`naxhq/NexQ`。

每份提案先给中文概要，再给可复制的英文标题和正文。英文正文在 `BEGIN DRAFT` / `END DRAFT` 注释之间。中文说明、发帖顺序和资料表供自己参考，不随正文发布。

本次只起草；发布 issue、discussion 或回复都需要用户另行明确同意。获准发布时，按用户要求显式写 `--repo naxhq/NexQ`，不要使用当前目录推断发布目标。本文件不执行发布命令。

## 核对依据与写作边界

- 已先执行 `git fetch upstream`，再用 `git show upstream/main:<路径>` 读取官方贡献规则和模板；本次 `upstream/main` 为 `a1d78901ee0d2e16715715d278d5b685a7f5dc16`。
- fork 参考基线：`custom` 的 `f202f43`。设计背景来自 [OVERHAUL_PLAN.md](OVERHAUL_PLAN.md) 第 2、3 节和 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)；已对照实际代码，避免把计划中的功能都写成已验证成果。
- [官方 CONTRIBUTING](https://github.com/naxhq/NexQ/blob/a1d78901ee0d2e16715715d278d5b685a7f5dc16/CONTRIBUTING.md) 要求新提供方、窗口、数据库迁移和音频采集改动先开 issue 或 discussion 商量，PR 保持小范围，重构与行为改动分开。
- [Feature request 模板](https://github.com/naxhq/NexQ/blob/a1d78901ee0d2e16715715d278d5b685a7f5dc16/.github/ISSUE_TEMPLATE/feature_request.yml) 要求先写问题，再写方案、替代方案、Area 和是否愿意贡献；以下正文沿用这些字段。开放式设计讨论可发到现有的 **Ideas** 分类。
- 已通过 `gh` 只读核对：[Issue #5](https://github.com/naxhq/NexQ/issues/5) 已关闭，维护者曾说明界面多语言不在近期路线图；[Discussion #28](https://github.com/naxhq/NexQ/discussions/28) 请求中文界面，目前仍无回复；[Issue #37](https://github.com/naxhq/NexQ/issues/37) 已通过调用 Anthropic Models API 修复。
- 下文中的实现链接指向公开的 [fork `custom`](https://github.com/PLus123456/NexQ/tree/custom)，供维护者阅读代码、构建体验。它是持续变化的参考实现，不代表已通过上游验收，也不要求上游采用 fork 的全部架构。实际投稿 PR 应从当时最新的 `upstream/main` 拆出通用改动。

## 1. 中文界面 / i18n 框架（完整稿，优先级最高）

中文概要：先承认 #5 的路线图决定，再承接 #28 的中文界面需求，询问维护者是否接受有人持续维护的分批贡献。第一步只引入框架、抽取一个小页面的英文；后续按页面抽取，再启用中文。中文翻译由我维护，但新增 UI 文案必须走 `t()`、资源文件和语言切换回归仍会给维护者带来长期成本，正文直接说明这些成本及减负办法。

建议位置：新建 **Ideas Discussion**，正文关联 #5 和 #28；如果维护者希望集中讨论，也可以把正文作为 #28 的回复。选一个主讨论位置即可，不重开 #5，不同时重复发 issue 和 discussion。若改用 Feature request，标题加 `[Feature]:`，Area 选 `Other`。

英文标题：**Proposal: incremental UI internationalization with maintained Simplified Chinese translations**

<!-- BEGIN DRAFT: i18n -->

### Problem or use case

NexQ's settings, onboarding and meeting controls are difficult to navigate for users who are more comfortable reading Chinese. Transcript translation helps with meeting content; these users also need to understand the interface that configures it.

I read [the maintainer's response in #5](https://github.com/naxhq/NexQ/issues/5#issuecomment-5879557912), which separated UI localization from speech-to-speech translation and virtual microphone routing, and explained that these features were outside the near-term roadmap. That issue is now closed. There is also a specific request for a Chinese interface in [Discussion #28](https://github.com/naxhq/NexQ/discussions/28).

Would you be open to a contributor-maintained, incremental UI localization effort? I would take on the initial extraction and ongoing Simplified Chinese translations. This proposal is limited to interface text; the TTS and virtual microphone requests from #5 would remain separate.

### Proposed solution

I have implemented English / Simplified Chinese UI localization in my personal fork, using `i18next` and `react-i18next`. The [public `custom` branch](https://github.com/PLus123456/NexQ/tree/custom) is available to inspect or build. Useful starting points are the [i18n module and contributor notes](https://github.com/PLus123456/NexQ/tree/custom/src/i18n), [English and Chinese resources](https://github.com/PLus123456/NexQ/tree/custom/src/i18n/locales), and [locale checker](https://github.com/PLus123456/NexQ/blob/custom/scripts/i18n-check.mjs).

I would adapt this work to upstream's preferred conventions through small PRs:

1. **Foundation and one English-only pilot page.** Add the runtime, typed translation keys, brief contributor instructions and one small page's extracted strings. Preserve the current English wording and keep English as the only enabled UI language at this stage. This gives us a concrete example to review before changing the rest of the interface.
2. **English extraction in small batches.** Convert one settings area or a few closely related components at a time, then onboarding, launcher and overlay. Keep each PR focused on text extraction, with before/after English screenshots. Include labels, tooltips, accessibility text and toast messages. Unconverted pages can remain English while this work progresses.
3. **Simplified Chinese resources and language selection.** Review `zh-CN` resources in namespace-sized batches, then add a persisted language setting, English fallback and synchronization between launcher and overlay. Keep the existing English experience as the default during rollout. Automatic system-language selection can be agreed separately. Test language changes, restart persistence and both windows before enabling the locale.
4. **Native UI follow-up.** Handle tray text and other agreed native surfaces in a separate PR. Translating backend error details would need its own design; raw provider errors can remain intact inside a translated UI message initially.

The fork organizes resources as `src/i18n/locales/{en,zh-CN}/<namespace>.json`, grouped by feature. English is the source of truth. The small `useT` alias for react-i18next's hook keeps UI localization distinct from NexQ's transcript-translation hooks. Stable keys, interpolation and plural handling avoid rewriting keys whenever English wording changes. I would preserve upstream's product name and extract from upstream's current screens.

#### Ongoing maintenance cost

Accepting i18n changes the everyday contribution workflow. **New user-facing text will need a `t()` call and an English resource entry**, and changed wording will need translation follow-up. Maintainers will also inherit the i18n dependencies, resource-file review and occasional layout or language-switching regressions. My maintaining Chinese translations reduces that work, but does not remove the cost of adopting the framework.

I would keep that cost manageable in these ways:

- Document a short recipe with copyable examples: add a semantic key to the relevant English namespace, call `t()` where the text is rendered, and use placeholders for dynamic values. Avoid module-level translated constants that become stale when the language changes.
- Keep namespaces small and grouped by feature. Keep translation-only corrections separate from functional changes so English-speaking reviewers can assess behavior without reviewing Chinese wording.
- Maintain the Chinese terminology and resources myself, including follow-ups when upstream changes text. Other contributors should be able to provide the English entry and request translation help.
- Derive key types from English resources, keep ordinary UI tests fixed to English, and add focused checks for language persistence, fallback and synchronization across windows. Review representative Chinese screenshots for clipped text and inaccessible controls.
- Keep protocol identifiers, model IDs, logs, user content and AI prompts outside UI localization. UI language should not implicitly change meeting translation or AI output behavior.

#### CI and incomplete translations

The fork's `scripts/i18n-check.mjs` checks locale files, duplicate keys, matching keys with plural handling, and interpolation placeholders. Its `--report` mode also identifies likely hard-coded English text; that report is heuristic and cannot establish translation quality or complete coverage.

I propose adding the locale check to CI as part of adoption. The foundation PR would adapt it to the initially enabled English resources; Chinese key parity would be checked when `zh-CN` is introduced. Hard-coded text reporting should initially cover converted areas, so unfinished extraction elsewhere does not block unrelated contributions.

The fork currently fails on missing Chinese keys. For upstream, I suggest keeping structural errors blocking and allowing a narrowly tracked temporary missing-translation exception, with runtime English fallback, when a feature is ready before its Chinese text. I would implement that exception policy explicitly in the checker and clear the translation backlog; it is an upstream adaptation, not something the existing script already does. This avoids making English feature releases wait on my availability while keeping missing translations visible in CI. If you prefer strict parity for every merge, we should agree that contributor obligation before enabling Chinese.

For implementation PRs I would run the checks in CONTRIBUTING, include before/after screenshots for UI changes, and describe manual launcher/overlay checks. The published fork is a reference implementation; upstream-specific tests and review would still be required.

### Alternatives considered

- Continue maintaining the localized fork. This remains workable if i18n does not fit the roadmap, although each upstream UI change then requires another extraction or merge adjustment downstream.
- Translate only a few screens. That is a useful pilot, but leaves users navigating mixed-language settings without a consistent contribution workflow.
- Adopt a different library or key convention. I am happy to discuss an existing upstream preference before preparing the foundation PR.

Would the foundation plus one English-only pilot page be a useful first PR? Agreement on that limited step would be enough to start; the later rollout could follow your review capacity.

### Area

Other — UI localization across settings, onboarding, launcher and overlay.

### Would you like to work on this?

Yes, I can open a pull request. I would maintain the Simplified Chinese translations and prepare the incremental PRs once we agree on the approach.

<!-- END DRAFT: i18n -->

## 2. 自定义 LLM 端点、手填模型 ID、按任务选模型（短稿）

中文概要：明确官方已经有 Custom 端点，提案是补足其使用方式，而不是说上游完全不支持。尊重 #37 的 API 模型列表方案，在候选下拉之外允许手填；先提这个小改动，再单独讨论多连接和任务路由，保持现有默认模型行为。

建议位置：**Ideas Discussion**；若维护者只接受最小范围，就把手填模型部分单独整理成 Feature request。Area：`AI copilot (LLM)`。

英文标题：**Proposal: custom LLM connections with editable model selection and optional task routing**

<!-- BEGIN DRAFT: llm -->

### Problem or use case

NexQ already supports a Custom LLM endpoint, but model selection still depends on the returned list. A working endpoint may expose chat completions without `/models`, a newly available model may not yet appear in discovery results, or a proxy may require its own model alias. Users also may want a fast model for live translation and a different model for summaries or meeting Q&A.

The [fix for #37](https://github.com/naxhq/NexQ/issues/37#issuecomment-6484743028) usefully replaced the hard-coded Anthropic list with API discovery. I would preserve that discovery workflow and add a manual option alongside it.

### Proposed solution

Start with an editable model combobox: **API-fetched dropdown suggestions plus a free-text model ID**. A discovery failure should remain visible but should not prevent saving an explicit ID. Preserve the entered ID, show that it will be sent as entered, and offer an explicit request test whose failures are reported clearly. Apply the same behavior to settings, setup and quick selection in focused PRs.

Then, if useful, discuss named connections with their own endpoint, credentials and default model, followed by optional per-task connection/model overrides. Tasks would initially inherit the current default; selecting another model for translation would not require changing the assistant or summary model. Credentials would remain in the OS credential store, and existing settings would need a reviewed migration.

My [fork implementation](https://github.com/PLus123456/NexQ/tree/custom/src/settings/llm) includes these features and a [shared model combobox](https://github.com/PLus123456/NexQ/blob/custom/src/components/ModelCombobox.tsx). I would extract the combobox first and discuss the connection/routing design separately. Would that smaller first contribution fit your preferred direction?

### Alternatives considered

Refreshing API lists remains the default path. Editing configuration manually or changing a single global model between tasks works around some cases, but neither solves endpoints without discovery cleanly.

### Area

AI copilot (LLM)

### Would you like to work on this?

Yes, I can open a pull request after scope agreement, with tests for missing model lists, arbitrary IDs and default task inheritance as those stages are introduced.

<!-- END DRAFT: llm -->

## 3. Soniox STT：实时识别、原生翻译与多区域（短稿）

中文概要：把 Soniox 定位为 STT 提供方，其译文随识别流进入现有字幕链路；每路独立选择，避免又调用一遍外部翻译。fork 已有多区域和选路代码，但建议上游先接受固定区域与基本识别/翻译，自动选路和故障切换另提，保留用户对启用区域的控制。

建议位置：**Feature request issue**；新提供方及音频事件接入先征求方案意见。Area：`Transcription (STT)`。

英文标题：**[Feature]: Soniox STT with live translation and regional endpoint selection**

<!-- BEGIN DRAFT: soniox -->

### Problem or use case

I would like to use Soniox for live transcription and receive its native translated text in NexQ's transcript view. Users also need to select the service region appropriate to their setup, with credentials associated with that region.

### Proposed solution

Add Soniox as an optional STT provider, selectable independently for You and Them. Each selected audio stream would have its own session. Expose region, model and language settings, plus optional one-way translation to a chosen target language. Match partial/final transcripts and translated text to stable segment IDs, and route the translations through the existing display/history path. When native translation is enabled for a stream, skip the separate automatic translation request for that stream.

The [provider and protocol implementation in my fork](https://github.com/PLus123456/NexQ/blob/custom/src-tauri/src/stt/soniox.rs) and [region router](https://github.com/PLus123456/NexQ/blob/custom/src-tauri/src/stt/soniox_regions.rs) cover US, EU, Japan and India configurations, per-region keys, and fixed, latency-based or ordered region selection.

For upstream I suggest fixed-region configuration first, followed by transcription and native-translation integration in reviewable steps. Automatic selection/failover could be a separate opt-in follow-up restricted to user-enabled regions. The integration touches audio result emission and segment handling, so I would agree on those changes before opening PRs. Protocol tests and manual two-stream checks would cover delayed translations, reconnects and duplicate translation requests.

Would a basic provider with fixed-region selection and optional one-way translation be an acceptable initial scope?

### Alternatives considered

Existing STT providers combined with NexQ's translation pipeline remain useful. A separate Soniox application would not integrate its transcripts and translations into NexQ's meeting history.

### Area

Transcription (STT)

### Would you like to work on this?

Yes, I can open a pull request once we agree on provider and event integration.

<!-- END DRAFT: soniox -->

## 4. 远程 / 自托管 STT（短稿）

中文概要：接入运行在另一台机器上的 Whisper 兼容服务，配置地址、模型和可选 Key。明确这是分段 HTTP 转写，延迟取决于分段和服务器；首版不承诺通用 WebSocket 或两路分别连接不同服务器，也不把“支持 OpenAI 兼容协议”写成已测试过所有服务。

建议位置：**Feature request issue**；新增通用 STT 提供方先讨论。Area：`Transcription (STT)`。

英文标题：**[Feature]: Remote and self-hosted STT through an OpenAI-compatible transcription endpoint**

<!-- BEGIN DRAFT: remote-stt -->

### Problem or use case

I would like to run Whisper on another machine and use it from NexQ. Local inference on the meeting laptop is not always practical, while the existing hosted transcription integrations do not provide a generic endpoint setting for a self-hosted service.

### Proposed solution

Add an optional OpenAI-compatible STT provider with a base URL, manually editable model ID and optional API key. Send multipart audio requests to `/audio/transcriptions`, preserving the configured path prefix and showing the final request URL. Allow localhost/LAN services, including deployments without authentication. Keep any saved key in the OS credential store.

This would support chunked HTTP transcription from self-hosted Whisper services exposing that contract, such as compatible speaches deployments. It would not imply arbitrary Whisper servers are compatible or provide token-streaming latency. Connection testing should exercise transcription explicitly and should not depend solely on `/models` being available.

My [fork provider](https://github.com/PLus123456/NexQ/blob/custom/src-tauri/src/stt/openai_compat.rs) provides a reference. I propose one shared endpoint configuration initially, with independent provider/language selection for You and Them. Network work should stay off the capture loop, with bounded buffering, timeouts and ordered results. Tests would cover slow/error responses and a manual two-stream session. Multiple named STT endpoints and WebSocket protocols can follow separately.

Would you prefer a new generic provider or a narrowly scoped generalization of the existing Whisper API integration?

### Alternatives considered

Running Whisper locally or using the existing hosted providers already serves many users; hard-coding another server URL requires rebuilding NexQ for each deployment.

### Area

Transcription (STT)

### Would you like to work on this?

Yes, I can prepare a focused PR after we agree on where this belongs.

<!-- END DRAFT: remote-stt -->

## 5. RAG 可配置 embedding 端点（短稿）

中文概要：现有 Ollama 路径继续保留，新增可自填地址、模型、认证和维度的 OpenAI 兼容 embedding。重点说明换模型后不能混用旧向量、远程调用会发送文档片段；fork 的独立索引库和检索优化不捆绑提给上游，任何索引元数据迁移先商量。

建议位置：**Ideas Discussion**，先定配置和索引兼容方式；收敛后转 Feature request 也可。Area：`Context / RAG`。

英文标题：**Proposal: configurable OpenAI-compatible embedding endpoints for RAG**

<!-- BEGIN DRAFT: embeddings -->

### Problem or use case

NexQ's current RAG embedder uses Ollama. I would like to use a self-hosted or hosted embedding service independently of the chat model, including a model suited to Chinese or multilingual documents.

### Proposed solution

Keep the Ollama path and add an optional OpenAI-compatible `/embeddings` provider. Expose a persistent base URL, model ID, authentication settings and expected dimensions, with a connection test. Make sending a `dimensions` request parameter optional because endpoints differ in what they accept. Store secrets in the OS credential store and make the destination clear before enabling remote embedding, since document chunks and search queries will be sent there.

The index must record which embedding configuration produced its vectors and validate response dimensions. A model or embedding-space change must require an explicit rebuild before those vectors are used with new queries; equal dimensions alone do not make two models compatible. Existing documents should be retained, and paid re-embedding should require user confirmation. Embedding selection would remain separate from chat task routing.

My fork includes an [embedding adapter](https://github.com/PLus123456/NexQ/blob/custom/src-tauri/src/rag/embedding/openai_compat.rs), [configuration](https://github.com/PLus123456/NexQ/blob/custom/src-tauri/src/rag/config.rs) and [settings UI](https://github.com/PLus123456/NexQ/blob/custom/src/settings/rag/EmbeddingSection.tsx). It also has broader indexing changes; the upstream proposal can be limited to endpoint configuration and the index-compatibility safeguards it needs. Any metadata/schema migration should be agreed first, with upgrade and rebuild tests.

Would you be interested in that limited scope, and where would you prefer the embedding identity to be stored?

### Alternatives considered

Ollama remains suitable for many local deployments. Running an adapter outside NexQ adds setup work and still leaves model changes and index compatibility to manage.

### Area

Context / RAG

### Would you like to work on this?

Yes, I can prepare small PRs after agreement on the provider interface and index metadata.

<!-- END DRAFT: embeddings -->

## 建议的发帖与贡献顺序

以下是节奏建议，不是官方额外门槛，也不是现在发布或新建 PR 的授权。不要一次把五个大提案全发出去。

| 顺序 | 建议动作 | 原因与进入下一步的条件 |
|---|---|---|
| 0 | 先完成维护者点名的 macOS CI PR | [#56 已合并](https://github.com/naxhq/NexQ/pull/56)，[维护者明确邀请补 `cargo test --lib`](https://github.com/naxhq/NexQ/pull/56#issuecomment-6568299307)。本次核对时，该账号的官方 PR 列表只有 #56；CI 按待办安排，不能写成已经提交或合并。 |
| 1 | 再完成 1–2 个与中文使用相关的小 bug 修复 | 候选如流式 UTF-8 分块乱码、合并字幕行丢失后续译文；先在最新上游复现，已修就跳过。分别提 PR，避免混入 i18n 或提供方重构。 |
| 2 | CI 与上述小修复合并后，优先发 i18n 完整提案 | 回应 #5 的路线图顾虑，关联 #28 的需求，先询问是否接受框架 + 一个英文页面。维护者同意后再准备分批 PR；若暂不接受，继续留在 fork，不反复重开 #5。 |
| 3 | 发 LLM 短提案，优先争取候选列表 + 手填模型 ID | 以 #37 的 API discovery 作为基础。先落地独立的小选择器改动，多连接、配置迁移和任务路由另行达成共识。 |
| 4 | 发远程 / 自托管 STT 提案 | 先商定复用已有集成还是新增通用提供方，再实现最小 HTTP 转写范围。 |
| 5 | 发 Soniox 提案 | 先固定区域和原生翻译链路，自动多区域选路另批；把音频事件、分段和重复翻译处理列为重点评审项。 |
| 6 | 发 RAG embedding 提案 | 先确定索引身份、重建行为及迁移，避免一次提交整个 RAG 重写。若维护者更关注 RAG，可与前两项交换顺序。 |

i18n 和其他功能在技术上可以独立推进，不需要等中文框架全站铺完才谈模型或 STT。建议同时只推进一个需要架构意见的大讨论，按维护者反馈调整节奏。

发帖前重新用 `gh` 只读核对关联 issue、discussion、PR 和最新上游实现，更新已经变化的句子；由用户确认具体稿件和发布位置后再发。真正进入实现 PR 时，按官方模板说明测试范围，UI 改动附前后截图，音频/STT/悬浮窗改动补手动 smoke test；未做过的平台和实测不要标成已通过。
