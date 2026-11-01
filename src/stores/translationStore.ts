import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type {
  TranslationProviderType,
  TranslationDisplayMode,
  TranslationResult,
} from "../lib/types";
import { setTranslationLanguages } from "../lib/ipc";
import { setTranslationProviderWithOptions } from "../lib/translation/ipc";
import type {
  LlmTranslationSettings,
  TranslateParties,
  TranslationBackendStatus,
  TranslationEndpoints,
  TranslationErrorEvent,
} from "../lib/translation/types";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_LIVE_SETTLE_MS,
  DEFAULT_LLM_SETTINGS,
  DEFAULT_PROVIDER,
  DEFAULT_TRANSLATE_PARTIES,
  clampSettleMs,
  defaultTargetLanguage,
} from "../lib/translation/defaults";
import { AUTO_LANGUAGE, normalizeLanguageCode } from "../lib/languages";
import { currentUiLanguage, t } from "../i18n";
import { showToast } from "./toastStore";

const STORE_FILE = "translation-config.json";

// Singleton store instance, lazily initialized
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

/**
 * Persist a key-value pair to the Tauri plugin-store.
 * Fire-and-forget: errors are logged but do not block the UI.
 */
async function persistValue(key: string, value: unknown): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch (err) {
    console.error(`[translationStore] Failed to persist "${key}":`, err);
  }
}

const PROVIDERS: readonly TranslationProviderType[] = ["microsoft", "google", "deepl", "opus-mt", "llm"];

function isProvider(value: unknown): value is TranslationProviderType {
  return PROVIDERS.includes(value as TranslationProviderType);
}

function isDisplayMode(value: unknown): value is TranslationDisplayMode {
  return value === "inline" || value === "hover";
}

function readParties(value: unknown): TranslateParties | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<Record<keyof TranslateParties, unknown>>;
  return {
    you: typeof v.you === "boolean" ? v.you : DEFAULT_TRANSLATE_PARTIES.you,
    them: typeof v.them === "boolean" ? v.them : DEFAULT_TRANSLATE_PARTIES.them,
  };
}

function readStrings<T extends object>(value: unknown, defaults: T): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const out = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    if (typeof v[key] === "string") out[key] = v[key];
  }
  return out as T;
}

/** A target / source language as stored ("auto" allowed only for the source). */
function readLanguage(value: unknown, allowAuto: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = normalizeLanguageCode(value);
  if (!code || (code === AUTO_LANGUAGE && !allowAuto)) return undefined;
  return code;
}

export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The latest text this window sent for translation, per segment. A result or
 * failure for any other text belongs to a request that a newer one replaced
 * (the line grew), so it is ignored.
 */
const liveRequests = new Map<string, string>();

function isStale(segmentId: string, originalText: string | undefined): boolean {
  if (originalText === undefined) return false;
  const latest = liveRequests.get(segmentId);
  return latest !== undefined && latest !== originalText;
}

const ERROR_TOAST_INTERVAL_MS = 20_000;
let lastErrorToast: { detail: string; at: number } | null = null;

/** One toast per distinct failure every 20 s (a broken provider fails every line). */
export function notifyTranslationError(detail: string): void {
  const now = Date.now();
  if (lastErrorToast && lastErrorToast.detail === detail && now - lastErrorToast.at < ERROR_TOAST_INTERVAL_MS) return;
  lastErrorToast = { detail, at: now };
  showToast(t("translation:errors.translateFailed", { detail }), "error");
}

const SYNC_DEBOUNCE_MS = 600;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncSeq = 0;

interface TranslationState {
  // Persisted preferences
  provider: TranslationProviderType;
  targetLang: string;
  sourceLang: string; // "auto" or a language code
  displayMode: TranslationDisplayMode;
  autoTranslateEnabled: boolean;
  selectionToolbarEnabled: boolean;
  cacheEnabled: boolean;
  /** Parties the translation pipeline translates (engine-side translation is in meetingAudioConfig). */
  translateParties: TranslateParties;
  endpoints: TranslationEndpoints;
  llm: LlmTranslationSettings;
  /** How long a live line must stay unchanged before it is translated. */
  liveSettleMs: number;

  // Session state (not persisted)
  autoTranslateActive: boolean; // current session toggle
  translations: Map<string, TranslationResult>; // segmentId → result
  translating: Set<string>; // segmentIds currently being translated
  /** Why a line's translation failed (cleared when one arrives). */
  errors: Map<string, string>;
  batchProgress: { completed: number; total: number } | null;
  /** The backend's answer to the last provider switch (null until the first one). */
  backendStatus: TranslationBackendStatus | null;

  // Actions
  setProvider: (provider: TranslationProviderType) => void;
  setTargetLang: (lang: string) => void;
  setSourceLang: (lang: string) => void;
  setDisplayMode: (mode: TranslationDisplayMode) => void;
  setAutoTranslateEnabled: (enabled: boolean) => void;
  setSelectionToolbarEnabled: (enabled: boolean) => void;
  setCacheEnabled: (enabled: boolean) => void;
  setTranslateParties: (parties: TranslateParties) => void;
  setEndpoint: (provider: keyof TranslationEndpoints, url: string) => void;
  setLlmSettings: (patch: Partial<LlmTranslationSettings>) => void;
  setLiveSettleMs: (ms: number) => void;
  setAutoTranslateActive: (active: boolean) => void;
  addTranslation: (result: TranslationResult) => void;
  addTranslations: (results: TranslationResult[]) => void;
  setTranslating: (segmentId: string, isTranslating: boolean) => void;
  /** A live line was sent for translation with this text. */
  startLiveRequest: (segmentId: string, text: string) => void;
  /** Its request failed; false when a newer request for the line replaced it. */
  failLiveRequest: (segmentId: string, text: string, error: string) => boolean;
  /** A `translation_error` event. */
  handleTranslationError: (event: TranslationErrorEvent) => void;
  setBackendStatus: (status: TranslationBackendStatus) => void;
  setBatchProgress: (progress: { completed: number; total: number } | null) => void;
  clearTranslations: () => void;
  /** Pushes the provider and its settings to the backend; the result also lands in backendStatus. */
  syncBackend: () => Promise<TranslationBackendStatus>;
  loadConfig: () => Promise<void>;
}

export const useTranslationStore = create<TranslationState>((set, get) => {
  /** Settings edits (addresses, prompts) reach the backend once typing pauses. */
  const scheduleSync = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void get().syncBackend();
    }, SYNC_DEBOUNCE_MS);
  };

  const pushLanguages = () => {
    const { targetLang, sourceLang } = get();
    setTranslationLanguages(targetLang, sourceLang === AUTO_LANGUAGE ? undefined : sourceLang).catch(() => {});
  };

  return {
    // Persisted defaults
    provider: DEFAULT_PROVIDER,
    targetLang: "en", // loadConfig: the saved one, else the UI language
    sourceLang: AUTO_LANGUAGE,
    displayMode: "inline",
    autoTranslateEnabled: true,
    selectionToolbarEnabled: true,
    cacheEnabled: true,
    translateParties: { ...DEFAULT_TRANSLATE_PARTIES },
    endpoints: { ...DEFAULT_ENDPOINTS },
    llm: { ...DEFAULT_LLM_SETTINGS },
    liveSettleMs: DEFAULT_LIVE_SETTLE_MS,

    // Session defaults
    autoTranslateActive: false,
    translations: new Map(),
    translating: new Set(),
    errors: new Map(),
    batchProgress: null,
    backendStatus: null,

    setProvider: (provider) => {
      set({ provider });
      persistValue("provider", provider);
      void get().syncBackend();
    },
    setTargetLang: (lang) => {
      const code = readLanguage(lang, false);
      if (!code) return;
      set({ targetLang: code });
      persistValue("targetLang", code);
      // Sync to backend immediately so all windows + translate calls use it
      pushLanguages();
    },
    setSourceLang: (lang) => {
      const code = readLanguage(lang, true);
      if (!code) return;
      set({ sourceLang: code });
      persistValue("sourceLang", code);
      // Sync to backend immediately
      pushLanguages();
    },
    setDisplayMode: (mode) => {
      set({ displayMode: mode });
      persistValue("displayMode", mode);
    },
    setAutoTranslateEnabled: (enabled) => {
      set({ autoTranslateEnabled: enabled });
      persistValue("autoTranslateEnabled", enabled);
    },
    setSelectionToolbarEnabled: (enabled) => {
      set({ selectionToolbarEnabled: enabled });
      persistValue("selectionToolbarEnabled", enabled);
    },
    setCacheEnabled: (enabled) => {
      set({ cacheEnabled: enabled });
      persistValue("cacheEnabled", enabled);
    },
    setTranslateParties: (parties) => {
      const next = { you: parties.you, them: parties.them };
      set({ translateParties: next });
      persistValue("translateParties", next);
    },
    setEndpoint: (provider, url) => {
      const endpoints = { ...get().endpoints, [provider]: url };
      set({ endpoints });
      persistValue("endpoints", endpoints);
      scheduleSync();
    },
    setLlmSettings: (patch) => {
      const llm = { ...get().llm, ...patch };
      set({ llm });
      persistValue("llm", llm);
      scheduleSync();
    },
    setLiveSettleMs: (ms) => {
      const liveSettleMs = clampSettleMs(ms);
      set({ liveSettleMs });
      persistValue("liveSettleMs", liveSettleMs);
    },
    setAutoTranslateActive: (active) => set({ autoTranslateActive: active }),

    addTranslation: (result) => {
      const id = result.segment_id;
      if (!id || isStale(id, result.original_text)) return;
      set((state) => {
        const updated = new Map(state.translations);
        updated.set(id, result);
        const translating = new Set(state.translating);
        translating.delete(id);
        if (!state.errors.has(id)) return { translations: updated, translating };
        const errors = new Map(state.errors);
        errors.delete(id);
        return { translations: updated, translating, errors };
      });
    },
    addTranslations: (results) => {
      set((state) => {
        const updated = new Map(state.translations);
        const translating = new Set(state.translating);
        const errors = new Map(state.errors);
        for (const r of results) {
          if (r.segment_id && !isStale(r.segment_id, r.original_text)) {
            updated.set(r.segment_id, r);
            translating.delete(r.segment_id);
            errors.delete(r.segment_id);
          }
        }
        return { translations: updated, translating, errors };
      });
    },
    setTranslating: (segmentId, isTranslating) => {
      set((state) => {
        const updated = new Set(state.translating);
        if (isTranslating) updated.add(segmentId);
        else updated.delete(segmentId);
        return { translating: updated };
      });
    },
    startLiveRequest: (segmentId, text) => {
      liveRequests.set(segmentId, text);
      set((state) => {
        const translating = new Set(state.translating);
        translating.add(segmentId);
        if (!state.errors.has(segmentId)) return { translating };
        const errors = new Map(state.errors);
        errors.delete(segmentId);
        return { translating, errors };
      });
    },
    failLiveRequest: (segmentId, text, error) => {
      if (isStale(segmentId, text)) return false;
      set((state) => {
        const translating = new Set(state.translating);
        translating.delete(segmentId);
        const errors = new Map(state.errors);
        errors.set(segmentId, error);
        return { translating, errors };
      });
      return true;
    },
    handleTranslationError: (event) => {
      const id = event.segment_id;
      if (!id || isStale(id, event.original_text)) return;
      set((state) => {
        const translating = new Set(state.translating);
        translating.delete(id);
        const errors = new Map(state.errors);
        errors.set(id, event.error);
        return { translating, errors };
      });
    },
    setBackendStatus: (status) => set({ backendStatus: status }),
    setBatchProgress: (progress) => set({ batchProgress: progress }),
    clearTranslations: () => {
      liveRequests.clear();
      set({ translations: new Map(), translating: new Set(), errors: new Map() });
    },

    syncBackend: async () => {
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      const seq = ++syncSeq;
      const { provider, endpoints, llm } = get();
      let status: TranslationBackendStatus;
      try {
        await setTranslationProviderWithOptions(provider, { endpoints, llm });
        status = { provider, ok: true };
      } catch (err) {
        status = { provider, ok: false, error: errorMessage(err) };
        console.warn("[translationStore] Translation provider not ready:", status.error);
      }
      // An older call finishing late must not overwrite a newer answer.
      if (seq === syncSeq) set({ backendStatus: status });
      return status;
    },

    loadConfig: async () => {
      try {
        const store = await getStore();
        const provider = await store.get<unknown>("provider");
        const targetLang = await store.get<unknown>("targetLang");
        const sourceLang = await store.get<unknown>("sourceLang");
        const displayMode = await store.get<unknown>("displayMode");
        const autoTranslateEnabled = await store.get<unknown>("autoTranslateEnabled");
        const selectionToolbarEnabled = await store.get<unknown>("selectionToolbarEnabled");
        const cacheEnabled = await store.get<unknown>("cacheEnabled");
        const translateParties = readParties(await store.get<unknown>("translateParties"));
        const endpoints = readStrings(await store.get<unknown>("endpoints"), DEFAULT_ENDPOINTS);
        const llm = readStrings(await store.get<unknown>("llm"), DEFAULT_LLM_SETTINGS);
        const liveSettleMs = await store.get<unknown>("liveSettleMs");
        const savedSource = readLanguage(sourceLang, true);

        set({
          ...(isProvider(provider) && { provider }),
          // Never chosen: the UI language (not saved, so it keeps following it).
          targetLang: readLanguage(targetLang, false) ?? defaultTargetLanguage(currentUiLanguage()),
          ...(savedSource && { sourceLang: savedSource }),
          ...(isDisplayMode(displayMode) && { displayMode }),
          ...(typeof autoTranslateEnabled === "boolean" && { autoTranslateEnabled }),
          ...(typeof selectionToolbarEnabled === "boolean" && { selectionToolbarEnabled }),
          ...(typeof cacheEnabled === "boolean" && { cacheEnabled }),
          ...(translateParties && { translateParties }),
          ...(endpoints && { endpoints }),
          ...(llm && { llm }),
          ...(typeof liveSettleMs === "number" && { liveSettleMs: clampSettleMs(liveSettleMs) }),
        });

        // The backend needs the real target language (the STT engine's own
        // translation follows it), not its built-in default.
        pushLanguages();

        // Cross-window sync: when another window changes the store,
        // update this window's Zustand state automatically. (The window that
        // made the change already told the backend.)
        store.onKeyChange<unknown>("provider", (val) => {
          if (isProvider(val)) set({ provider: val });
        });
        store.onKeyChange<unknown>("targetLang", (val) => {
          const code = readLanguage(val, false);
          if (code) set({ targetLang: code });
        });
        store.onKeyChange<unknown>("sourceLang", (val) => {
          const code = readLanguage(val, true);
          if (code) set({ sourceLang: code });
        });
        store.onKeyChange<unknown>("displayMode", (val) => {
          if (isDisplayMode(val)) set({ displayMode: val });
        });
        store.onKeyChange<unknown>("autoTranslateEnabled", (val) => {
          if (typeof val === "boolean") set({ autoTranslateEnabled: val });
        });
        store.onKeyChange<unknown>("selectionToolbarEnabled", (val) => {
          if (typeof val === "boolean") set({ selectionToolbarEnabled: val });
        });
        store.onKeyChange<unknown>("cacheEnabled", (val) => {
          if (typeof val === "boolean") set({ cacheEnabled: val });
        });
        store.onKeyChange<unknown>("translateParties", (val) => {
          const parties = readParties(val);
          if (parties) set({ translateParties: parties });
        });
        store.onKeyChange<unknown>("endpoints", (val) => {
          const next = readStrings(val, DEFAULT_ENDPOINTS);
          if (next) set({ endpoints: next });
        });
        store.onKeyChange<unknown>("llm", (val) => {
          const next = readStrings(val, DEFAULT_LLM_SETTINGS);
          if (next) set({ llm: next });
        });
        store.onKeyChange<unknown>("liveSettleMs", (val) => {
          if (typeof val === "number") set({ liveSettleMs: clampSettleMs(val) });
        });

        console.log("[translationStore] Config loaded from store (with cross-window sync)");
      } catch (err) {
        console.error("[translationStore] Failed to load config:", err);
      }
    },
  };
});
