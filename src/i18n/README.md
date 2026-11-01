# UI translations (i18n)

NexQ Plus uses [i18next](https://www.i18next.com/) + react-i18next. English is
the source language; Simplified Chinese (`zh-CN`) is the second one.

```
src/i18n/
  index.ts        initI18n(), useT(), t(), Trans, changeUiLanguage(), useUiLanguage(),
                  currentUiLanguage(), UI_LANGUAGES, UI_LANGUAGE_NAMES,
                  formatDate(), formatNumber()
  resources.ts    static imports of every namespace (P0 only)
  i18next.d.ts    typed keys, generated from the en resources
  locales/
    en/<namespace>.json
    zh-CN/<namespace>.json
scripts/i18n-check.mjs   key check + hard-coded text report
```

## Using it

```tsx
import { useT } from "../i18n";

function SaveButton() {
  // The first namespace is the default; list every namespace the component uses.
  const { t } = useT(["settings", "common"]);
  return <button title={t("general.save.hint")}>{t("common:actions.save")}</button>;
}
```

- React components: `useT(namespace)`. It is react-i18next's `useTranslation`
  under another name, because `src/hooks/useTranslation.ts` is the transcript
  translation feature. The key types only allow the namespaces you pass:
  `useT("settings")` rejects `t("common:…")`, so write
  `useT(["settings", "common"])`. `useT()` alone means `common`.
- Markup inside a translated string: `<Trans t={t} i18nKey="…" components={{
  strong: <strong />, upstream: <a href={…} /> }} />` with
  `"…<strong>AI Actions</strong>…"` in the JSON. Name the tags after what they
  are (`strong`, `upstream`), **never after HTML void elements** (`link`,
  `img`, `br`, `input`, `meta`…): those render empty.
- Outside React (stores, toasts, dialogs): `import { t } from "../i18n"` and
  call `t("settings:updates.toast.ready", { version })` **when the text is
  needed**. Never at module top level: the value would not follow a language
  change. Constant tables store keys (`labelKey: "tabs.llm"`) and translate at
  render time.
- Dates and numbers: `formatDate(value, options?)`, `formatNumber(value,
  options?)` follow the UI language. Don't hard-code `"en-US"`.
- The language setting: `useUiLanguage()` → `{ setting, language }`;
  `changeUiLanguage("system" | "zh-CN" | "en")` stores it in `config.json`
  (`uiLanguage`), switches every window and the tray. `UI_LANGUAGE_NAMES` has
  each language's own name ("简体中文", "English") for language pickers.
- Tests run in English (`src/test/setup.ts`; the setting starts as `"en"`, not
  `"system"`), so the `en` values must stay the original English text. A test
  that switches with `await changeUiLanguage("zh-CN")` must switch back to
  `"en"` afterwards (`afterEach`).

## Namespaces and owners

One namespace per work package; a package only writes keys into its own
namespace files, even for components that live elsewhere.

| Namespace | Content | Owner |
|---|---|---|
| `common` | Shared buttons, states, units, error wrappers ("Operation failed: {{detail}}"), the shared components (`components.*`) | P0, then P6 |
| `settings` | Settings shell (sidebar groups, tabs), General, About, updates; later the other settings pages | P0, then P6 |
| `llm` | LLM connections, task routing, model picker, Claude subscription | P1 |
| `stt` | Recognition engines, meeting audio and devices, local models, presets, recognition languages | P2 |
| `translation` | Translation settings and translated text display | P3 |
| `rag` | Personal knowledge base, context strategy | P4 |
| `onboarding` | First-run setup | P5 |
| `launcher` | Main window, meeting list, meeting details | P6 |
| `overlay` | Overlay (except the translation package's files) | P6 |
| `calllog` | AI call log | P6 |
| `misc` | Remaining components, hooks, stores, lib messages | P6 |

Adding a namespace means editing `resources.ts` (P0 only).

## Writing keys

- Form: `<namespace>:<area>.<element>.<property>`, lowerCamelCase, naming
  **what the thing is**, not its English text (so an upstream wording change
  doesn't change the key): `llm:connections.editor.baseUrl.label`,
  `llm:connections.editor.baseUrl.hint`, `common:actions.save`.
- Interpolation: `{{name}}`. The product name is `{{appName}}` (injected
  automatically as "NexQ Plus"); never write "NexQ" into a translation.
- Plurals: en `key_one` / `key_other`, zh-CN only `key_other`; call with
  `t("key", { count })`.
- Same `{{placeholders}}` in both languages (the check enforces it).
- Not translated: logs (`console.*`, `log::*`), prompts sent to the AI,
  protocol fields, language codes, model ids, shortcut key names.
- Backend errors are shown as they come (mostly English), wrapped:
  `t("common:errors.testFailed", { detail })`.
- Chinese uses full-width punctuation (，。：；！？（）“”). Keep the style
  consistent within a namespace. Terms: see the glossary below.

## Checking

```bash
node scripts/i18n-check.mjs
```

```bash
node scripts/i18n-check.mjs --report src/settings/STTSettings.tsx src/lib/stt
```

The first command checks that both languages have the same keys (plurals
compared by base key), valid JSON without duplicate keys, and matching
placeholders. `--report` lists English text that looks hard-coded (a
heuristic for self-review; mark deliberate literals with an `i18n-ignore`
comment on the same line). `--fail-on-report` also fails on findings.

## Glossary

| English | 中文 | Note |
|---|---|---|
| Overlay | 悬浮窗 | |
| Launcher | 主窗口 | |
| Meeting | 会议 | |
| Transcript | 转写记录；实时显示时叫“字幕” | |
| Segment | 片段 | |
| You / Them | 我 / 对方 | In-person mode's Room: 现场 |
| Speaker | 说话人 | |
| Diarization | 说话人分离 | |
| STT (Speech-to-Text) | 语音识别 | |
| Engine | 识别引擎 | STT uses “引擎” |
| Provider | 服务商 | LLM and translation use “服务商” |
| Connection | 连接 | An LLM connection profile |
| Task routing | 任务路由 / 按任务选模型 | |
| Model | 模型 | |
| Base URL | 接口地址（Base URL） | Add the English in parentheses on first mention |
| API Key | API Key | Not translated |
| Endpoint | 端点 | |
| Auth | 认证方式 | |
| Header | 请求头 | |
| Test connection | 测试连接 | |
| Translation | 翻译 | |
| Source / Target language | 源语言 / 目标语言 | |
| Auto-detect | 自动检测 | |
| Context | 上下文 | |
| Context Intelligence / RAG | 个人知识库（RAG） | |
| Embedding | 向量化（embedding） | |
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
| Subscription (Claude) | 订阅 | |
| Ask this meeting | 问这场会议 | |
| First-run wizard / Onboarding | 首次设置 | |
