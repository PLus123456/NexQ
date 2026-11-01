// translationStore: saved settings, the two windows staying in step through
// the plugin-store (as in configStore.crossWindow.test.ts), and what it tells
// the backend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
      // Like the Rust side: every window (the writer included) hears the change.
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));

/** A window: a fresh module graph (own Zustand store) that has loaded the translation config. */
async function openWindow(uiLanguage: "en" | "zh-CN" = "en") {
  vi.resetModules();
  const { useUiLanguageStore } = await import("../i18n");
  useUiLanguageStore.setState({ language: uiLanguage });
  const { useTranslationStore } = await import("./translationStore");
  await useTranslationStore.getState().loadConfig();
  return useTranslationStore;
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

beforeEach(() => {
  saved.clear();
  keyListeners.length = 0;
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("translationStore: new install", () => {
  it("defaults to LLM translation of the other side, into the UI language", async () => {
    const store = await openWindow("zh-CN");
    const state = store.getState();
    expect(state.provider).toBe("llm");
    expect(state.translateParties).toEqual({ you: false, them: true });
    expect(state.targetLang).toBe("zh-CN");
    expect(state.sourceLang).toBe("auto");
    expect(state.liveSettleMs).toBe(1200);
    // Live translation costs quota on every line: off until chosen.
    expect(state.autoTranslateEnabled).toBe(false);
    // The backend learns the real target (the STT engine's own translation follows it).
    expect(calls("set_translation_languages")).toEqual([{ targetLang: "zh-CN", sourceLang: undefined }]);
    // Following the UI language isn't a choice: nothing is saved.
    expect(saved.has("targetLang")).toBe(false);
  });

  it("an English UI translates into English", async () => {
    const store = await openWindow("en");
    expect(store.getState().targetLang).toBe("en");
  });

  it("saved values win; invalid ones are ignored", async () => {
    saved.set("provider", "deepl");
    saved.set("targetLang", "JA");
    saved.set("sourceLang", "en_us");
    saved.set("translateParties", { you: true });
    saved.set("liveSettleMs", 50);
    saved.set("endpoints", { deepl: "http://deeplx.lan/v2", google: 42 });
    let store = await openWindow();
    let state = store.getState();
    expect(state.provider).toBe("deepl");
    expect(state.targetLang).toBe("ja");
    expect(state.sourceLang).toBe("en-US");
    expect(state.translateParties).toEqual({ you: true, them: true });
    expect(state.liveSettleMs).toBe(300);
    expect(state.endpoints).toEqual({ deepl: "http://deeplx.lan/v2", microsoft: "", google: "" });

    saved.set("provider", "bogus");
    saved.set("targetLang", "auto");
    saved.set("translateParties", "yes");
    store = await openWindow();
    state = store.getState();
    expect(state.provider).toBe("llm");
    expect(state.targetLang).toBe("en");
    expect(state.translateParties).toEqual({ you: false, them: true });
  });
});

describe("translationStore: across windows", () => {
  it("settings changed in one window reach the other", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();

    launcher.getState().setTranslateParties({ you: true, them: false });
    launcher.getState().setTargetLang("pt_br");
    launcher.getState().setSourceLang("auto");
    launcher.getState().setEndpoint("microsoft", "https://api.translator.azure.cn");
    launcher.getState().setLlmSettings({ glossary: "sprint => 冲刺" });
    launcher.getState().setLiveSettleMs(2500);

    await vi.waitFor(() => expect(overlay.getState().translateParties).toEqual({ you: true, them: false }));
    const state = overlay.getState();
    expect(state.targetLang).toBe("pt-BR");
    expect(state.endpoints.microsoft).toBe("https://api.translator.azure.cn");
    expect(state.llm).toEqual({ systemPrompt: "", userTemplate: "", glossary: "sprint => 冲刺" });
    expect(state.liveSettleMs).toBe(2500);

    // The next start reads them back.
    const nextStart = await openWindow();
    expect(nextStart.getState().translateParties).toEqual({ you: true, them: false });
    expect(nextStart.getState().targetLang).toBe("pt-BR");
  });

  it("only the window that changed the provider tells the backend", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    invoke.mockClear();
    launcher.getState().setProvider("google");
    await vi.waitFor(() => expect(overlay.getState().provider).toBe("google"));
    expect(calls("set_translation_provider")).toHaveLength(1);
  });
});

describe("translationStore: backend sync", () => {
  it("sends the provider with its addresses and prompts", async () => {
    const store = await openWindow();
    store.setState({
      provider: "deepl",
      endpoints: { deepl: "http://deeplx.lan/v2", microsoft: "", google: "" },
      llm: { systemPrompt: "S", userTemplate: "", glossary: "" },
    });
    const status = await store.getState().syncBackend();
    expect(status).toEqual({ provider: "deepl", ok: true });
    expect(calls("set_translation_provider")).toEqual([
      {
        provider: "deepl",
        region: undefined,
        options: {
          endpoints: { deepl: "http://deeplx.lan/v2", microsoft: "", google: "" },
          llm: { systemPrompt: "S", userTemplate: "", glossary: "" },
        },
      },
    ]);
    expect(store.getState().backendStatus).toEqual({ provider: "deepl", ok: true });
  });

  it("keeps the reason a provider isn't ready instead of swallowing it", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_translation_provider") throw "API key missing for provider: microsoft";
      return undefined;
    });
    const store = await openWindow();
    store.setState({ provider: "microsoft" });
    const status = await store.getState().syncBackend();
    expect(status).toEqual({ provider: "microsoft", ok: false, error: "API key missing for provider: microsoft" });
    expect(store.getState().backendStatus).toEqual(status);
  });

  it("address and prompt edits reach the backend once typing pauses", async () => {
    const store = await openWindow();
    vi.useFakeTimers();
    invoke.mockClear();
    store.getState().setEndpoint("deepl", "http://d");
    store.getState().setEndpoint("deepl", "http://deeplx");
    store.getState().setLlmSettings({ systemPrompt: "Be brief." });
    expect(calls("set_translation_provider")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    const pushed = calls("set_translation_provider");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      options: { endpoints: { deepl: "http://deeplx" }, llm: { systemPrompt: "Be brief." } },
    });
  });
});

describe("translationStore: live results", () => {
  it("a result for text that was replaced by a newer request is dropped", async () => {
    const store = await openWindow();
    const result = (original: string, translated: string) => ({
      segment_id: "s1",
      original_text: original,
      translated_text: translated,
      source_lang: "en",
      target_lang: "de",
      provider: "DeepL",
    });
    store.getState().startLiveRequest("s1", "Hi");
    store.getState().startLiveRequest("s1", "Hi there");
    store.getState().addTranslation(result("Hi", "Hallo"));
    expect(store.getState().translations.has("s1")).toBe(false);
    expect(store.getState().failLiveRequest("s1", "Hi", "late failure")).toBe(false);
    expect(store.getState().errors.has("s1")).toBe(false);
    store.getState().addTranslation(result("Hi there", "Hallo zusammen"));
    expect(store.getState().translations.get("s1")?.translated_text).toBe("Hallo zusammen");

    // Results the window never asked for (Soniox, saved ones) are always taken.
    store.getState().addTranslations([{ ...result("other", "x"), segment_id: "s2" }]);
    expect(store.getState().translations.has("s2")).toBe(true);

    store.getState().clearTranslations();
    store.getState().addTranslation(result("Hi", "Hallo"));
    expect(store.getState().translations.get("s1")?.translated_text).toBe("Hallo");
  });
});
