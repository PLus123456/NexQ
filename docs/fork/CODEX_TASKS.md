# 交给 Codex 的任务（2026-11-02）

> 状态：两项都已完成，2026-11-02 合进 `custom`（任务 A：`b12dd8a`，任务 B：`80ecf61`）。下面的内容留作记录，不用再做。

下面两项互不依赖，可以同时做。M1（LLM 逐句提问检测）已经合进 `custom`，两项都从 `custom` 拉分支。

## 通用要求

- 每项开一个 git worktree，照你之前的做法放在 `.worktrees/` 下，分支名见各任务。不要直接改主检出 `/Users/plus/NexQ`，也不要动 `.claude/worktrees/` 里 Claude 会话的工作区。
- 做完在自己的分支上提交（git config 里已设好身份）。**不要合进 `custom`，不要推送，不要打包安装 App。** 这两项和 Claude 在做的 RAG 重排序都完成后，由 Claude 统一合并、打包。
- 提交前跑检查。只改前端的任务可以不跑 cargo：
  - `npx tsc --noEmit`
  - `npm test`
  - `bash -c '. "$HOME/.cargo/env" && source scripts/macos-env.sh && cd src-tauri && cargo test --lib'`
  - `node scripts/i18n-check.mjs`
- 新的界面文字要有 en 和 zh-CN 两份。拿不准的中文用词追加到 `docs/fork/TRANSLATION_REVIEW.md`。
- 不读用户的钥匙串，不用用户的 Key 调付费 API，测试一律用 mock。
- 最后用中文汇报：分支名、做了什么、检查结果、怎么验收。

## 任务 A：M2，预测对方接下来要问的问题

分支：`codex/m2-question-prediction`

**背景**：M1 的用法和行为见 `docs/fork/TRIAL_GUIDE.md` 的"LLM 提问检测 M1"一节。那一节最后写着 M2 还没做：预测接下来 1–3 个问题，提前生成答案并复用。用户最初的想法是：对方讲到某个地方时，模型提前猜到对方要问什么，等真问到时答案已经准备好了。

**要做的**

1. **预测**：会议进行中，根据最近一段双方原文，预测对方接下来最可能问的 1–3 个问题。
   - 触发频率比 M1 低：对方说完一段、停顿较长或换话题时才触发，不要每句都请求。
   - 和 M1 一样同一时间只跑一个请求，可以取消，有超时和预算；失败就静默跳过。
2. **提前生成答案**：走回答（Assist）那条路由，在后台给预测的问题提前生成答案。生成数量要有上限，比如只给置信度最高的 1–2 个生成。
3. **复用**：M1 检测到真实问题后，判断它和哪个预测是同一个问题。用 LLM 判断、embedding 相似度或文本相似度都行，选又准又快的。
   - 命中：立刻显示准备好的答案，并标明是提前准备的。
   - 没命中：照常生成，这次的预测作废。
4. **界面**：
   - 悬浮窗：显示"对方可能会问"的列表，可以折叠，不干扰主界面；点一下能看到预备的答案。
   - 设置页：在 M1 的提问检测卡片附近，加下面几项：
     - 总开关，默认关闭，因为会多花 token。
     - 预测用的模型：建议在任务路由里新增一个任务，单独选模型，和 M1 一样不继承默认模型。
     - "提前生成答案"可以单独关掉。
5. **生命周期**：
   - 会议结束、设置变化、切换会议时，取消没跑完的预测和预生成。
   - 预测和没用上的预备答案不存进会议 AI 对话；用上的答案按正常回答保存。
   - 打开"在 AI 调用日志中记录提问检测"时，预测请求也要出现在日志里。
6. **测试和文档**：
   - Rust 和前端测试要覆盖：触发频率；同时只跑一个和取消；命中和没命中；开关关闭时不发请求。
   - 在 TRIAL_GUIDE 里补 M2 的用法和人工验收步骤。

## 任务 B：清掉剩下的 36 处英文

分支：`codex/i18n-leftovers`

`node scripts/i18n-check.mjs --report src` 现在报 36 处，全在两个文件里：

- `src/settings/LLMSettings.tsx`（34 处）：提供方列表的名称和说明，例如 "Local models via Ollama"、"Ultra-fast inference"、"Multi-provider gateway"、"Custom"。这个旧页面只在新版 LLM 设置加载失败时作为兜底出现，见 `src/settings/llm/LlmSettingsPage.tsx`。
- `src/settings/AboutSettings.tsx`（2 处）："Tauri 2"、"React + Rust"。

**要做的**

- 说明性的文字改成 `t()`，en 和 zh-CN 两份放进合适的命名空间。
- 产品名和品牌名保持原文，比如 Ollama、LM Studio、Anthropic、Groq、Google Gemini、Tauri、React、Rust。处理方法二选一：
  - 在那一行加 `i18n-ignore` 标记，`scripts/i18n-check.mjs` 会跳过含这个标记的行；
  - 挪到常量里。

**完成标准**

- `node scripts/i18n-check.mjs --report src` 报 0 处。
- `node scripts/i18n-check.mjs` 通过。
- 新加的中文用词追加到 `docs/fork/TRANSLATION_REVIEW.md`。
