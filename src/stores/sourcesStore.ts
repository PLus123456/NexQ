import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type {
  EnvVar,
  McpCheckStatus,
  McpServer,
  McpTool,
  McpTransport,
  NotesFolder,
  PersonalSourcesConfig,
  SourceToggles,
} from "../lib/types";
import { setPersonalSources, type SourceConfigWrite } from "../lib/ipc";
import { useConfigStore } from "./configStore";

// Same plugin-store file as `configStore`, so the launcher and the overlay see
// each other's changes through `onKeyChange`.
const STORE_FILE = "config.json";
const CONFIG_KEY = "personalSources";
const TOGGLES_KEY = "sourceToggles";

export const DEFAULT_SOURCES_CONFIG: PersonalSourcesConfig = {
  notes_folders: [],
  mcp_servers: [],
  mcp_notice_seen: false,
};

export const DEFAULT_SOURCE_TOGGLES: SourceToggles = { notes: false, tools: false };

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

// ── Normalizing what was saved (older shapes, hand edits, damage) ──

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function normalizeFolder(raw: unknown): NotesFolder | null {
  if (!isObject(raw)) return null;
  const path = str(raw.path);
  const id = str(raw.id);
  if (!path || !id) return null;
  return { id, label: str(raw.label) || path, path, enabled: raw.enabled === true };
}

function normalizeTransport(raw: unknown): McpTransport | null {
  if (!isObject(raw)) return null;
  if (raw.type === "stdio" && typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    return { type: "stdio", command: raw.command, args };
  }
  if (raw.type === "http" && typeof raw.url === "string") {
    const names = Array.isArray(raw.header_names)
      ? raw.header_names.filter((a): a is string => typeof a === "string")
      : [];
    return { type: "http", url: raw.url, header_names: names };
  }
  return null;
}

function normalizeEnv(raw: unknown): EnvVar[] {
  if (!Array.isArray(raw)) return [];
  const out: EnvVar[] = [];
  for (const e of raw) {
    if (!isObject(e) || typeof e.name !== "string" || !e.name) continue;
    const secret = e.secret === true;
    // A secret never has a value here, whatever was saved.
    out.push({ name: e.name, secret, value: secret ? null : typeof e.value === "string" ? e.value : "" });
  }
  return out;
}

function normalizeTools(raw: unknown): McpTool[] {
  if (!Array.isArray(raw)) return [];
  const out: McpTool[] = [];
  for (const t of raw) {
    if (!isObject(t) || typeof t.name !== "string" || !t.name) continue;
    out.push({ name: t.name, full_name: str(t.full_name), allowed: t.allowed === true });
  }
  return out;
}

function normalizeCheck(raw: unknown): McpCheckStatus | null {
  if (!isObject(raw)) return null;
  return {
    ok: raw.ok === true,
    tool_count: typeof raw.tool_count === "number" ? raw.tool_count : 0,
    error: typeof raw.error === "string" ? raw.error : null,
    checked_at_ms: typeof raw.checked_at_ms === "number" ? raw.checked_at_ms : 0,
  };
}

function normalizeServer(raw: unknown): McpServer | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const key = str(raw.key);
  const transport = normalizeTransport(raw.transport);
  if (!id || !key || !transport) return null;
  return {
    id,
    key,
    label: str(raw.label) || key,
    transport,
    enabled: raw.enabled === true,
    env: normalizeEnv(raw.env),
    tools: normalizeTools(raw.tools),
    last_check: normalizeCheck(raw.last_check),
    needs_sign_in: raw.needs_sign_in === true,
  };
}

/** Saved sources with every missing field filled in; a damaged entry is dropped, never a crash. */
export function normalizeSourcesConfig(raw: unknown): PersonalSourcesConfig {
  if (!isObject(raw)) return { ...DEFAULT_SOURCES_CONFIG, notes_folders: [], mcp_servers: [] };
  const folders = Array.isArray(raw.notes_folders) ? raw.notes_folders : [];
  const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  return {
    notes_folders: folders.map(normalizeFolder).filter((f): f is NotesFolder => f !== null),
    mcp_servers: servers.map(normalizeServer).filter((s): s is McpServer => s !== null),
    mcp_notice_seen: raw.mcp_notice_seen === true,
  };
}

function normalizeToggles(raw: unknown): SourceToggles {
  if (!isObject(raw)) return { ...DEFAULT_SOURCE_TOGGLES };
  return { notes: raw.notes === true, tools: raw.tools === true };
}

/** Which kinds of source have something an answer could use right now. */
export function enabledKinds(c: PersonalSourcesConfig): { notes: boolean; tools: boolean } {
  return {
    notes: c.notes_folders.some((f) => f.enabled),
    tools: c.mcp_servers.some((s) => s.enabled && !s.needs_sign_in && s.tools.some((t) => t.allowed)),
  };
}

/** Same value, same text, whatever order its keys come back in. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

// ── Store ──

type SourcesConfigEdit = PersonalSourcesConfig | ((latest: PersonalSourcesConfig) => PersonalSourcesConfig);

interface SourcesWriteOptions {
  durable?: boolean;
  pendingIds?: string[];
  canCommit?: () => boolean;
}

interface SourcesState {
  config: PersonalSourcesConfig;
  toggles: SourceToggles;
  loaded: boolean;
  /** Why the backend refused the last config (an invalid or duplicate server key); `null` when it took it. */
  pushError: string | null;
  load: () => Promise<void>;
  /** Set, save and give to the backend. A required persistence failure rejects. */
  setConfig: (c: SourcesConfigEdit, options?: SourcesWriteOptions) => Promise<void>;
  /** Save the settings to disk and reject if the backend cannot complete the change. */
  setConfigDurably: (c: SourcesConfigEdit) => Promise<void>;
  /**
   * Set and save. A pill flipped here applies to the next answer. Pass a
   * function to change the latest value (two quick clicks each see the other's
   * result).
   */
  setToggles: (t: SourceToggles | ((latest: SourceToggles) => SourceToggles)) => void;
}

/** Notices of our own saves come back through `onKeyChange`; skip them. */
const ownToggleSaves: string[] = [];
const OWN_SAVES_KEPT = 16;

async function persistToggles(value: SourceToggles): Promise<void> {
  let mine: string | null = null;
  try {
    const store = await getStore();
    mine = fingerprint(value);
    ownToggleSaves.push(mine);
    if (ownToggleSaves.length > OWN_SAVES_KEPT) ownToggleSaves.shift();
    await store.set(TOGGLES_KEY, value);
  } catch (e) {
    const recorded = mine === null ? -1 : ownToggleSaves.lastIndexOf(mine);
    if (recorded >= 0) ownToggleSaves.splice(recorded, 1);
    console.error("[sourcesStore] Failed to persist your source switches:", e);
  }
}

/** Persistence and backend changes share a queue within the window. */
let configWrites: Promise<void> = Promise.resolve();

function enqueueConfigWrite(write: () => Promise<void>): Promise<void> {
  const next = configWrites.then(write, write);
  configWrites = next.catch(() => {});
  return next;
}

/**
 * At startup the window can ask before the backend has finished setting up
 * (Tauri: "state not managed ... call `.manage()`"). That's not a refusal:
 * wait and send again, for up to ~30 s.
 */
const STARTING_RE = /state not managed/i;
const STARTING_WAIT_MS = 150;
const STARTING_TRIES = 200;

const SOURCE_CONFIG_CHANGED = "SOURCE_CONFIG_CHANGED";
const MAX_WRITE_ATTEMPTS = 8;

async function sendWhenReady(
  config: PersonalSourcesConfig,
  pendingIds?: string[],
  write?: SourceConfigWrite,
  canCommit?: () => boolean,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (canCommit?.() === false) throw new Error("Source editing was cancelled");
    try {
      return await setPersonalSources(config, pendingIds, write);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!STARTING_RE.test(message) || attempt >= STARTING_TRIES) throw e;
      await new Promise((r) => setTimeout(r, STARTING_WAIT_MS));
    }
  }
}

function showBackendError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn("[sourcesStore] Backend refused the sources:", message);
  useSourcesStore.setState({ pushError: message });
}

let watchingSaved: Promise<void> | null = null;

async function watchSaved(): Promise<void> {
  const store = await getStore();
  return watchingSaved ??= Promise.allSettled([
    store.onKeyChange<unknown>(CONFIG_KEY, (saved) => {
      if (saved === undefined || saved === null) return;
      useSourcesStore.setState({ config: normalizeSourcesConfig(saved) });
    }),
    store.onKeyChange<unknown>(TOGGLES_KEY, (saved) => {
      if (saved === undefined || saved === null) return;
      const own = ownToggleSaves.indexOf(fingerprint(saved));
      if (own >= 0) {
        ownToggleSaves.splice(own, 1);
        return;
      }
      useSourcesStore.setState({ toggles: normalizeToggles(saved) });
    }),
  ]).then((results) => {
    const failure = results.find((result) => result.status === "rejected");
    if (!failure) return;
    for (const result of results) if (result.status === "fulfilled") result.value();
    watchingSaved = null;
    throw failure.reason;
  });
}

export const useSourcesStore = create<SourcesState>((set, get) => {
  const saveConfig = (edit: SourcesConfigEdit, { durable = false, pendingIds, canCommit }: SourcesWriteOptions = {}) =>
    enqueueConfigWrite(async () => {
      try {
        const store = await getStore();
        for (let attempt = 1; ; attempt++) {
          const expected = await store.get(CONFIG_KEY);
          const visible = get().config;
          const previous = expected == null ? visible : normalizeSourcesConfig(expected);
          const config = normalizeSourcesConfig(typeof edit === "function" ? edit(previous) : edit);
          try {
            await sendWhenReady(config, pendingIds, { expected: expected ?? null, durable }, canCommit);
            set((state) => ({
              config: state.config === visible ? config : state.config,
              pushError: null,
            }));
            return;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (message !== SOURCE_CONFIG_CHANGED) throw e;
            if (attempt >= MAX_WRITE_ATTEMPTS) throw new Error("The source settings changed in another window. Try again.");
          }
        }
      } catch (e) {
        if (canCommit?.() !== false) showBackendError(e);
        if (durable) throw e;
      }
    });

  return {
    config: DEFAULT_SOURCES_CONFIG,
    toggles: DEFAULT_SOURCE_TOGGLES,
    loaded: false,
    pushError: null,

    load: () => enqueueConfigWrite(async () => {
      try {
        const store = await getStore();
        await watchSaved();
        const before = get();
        // Loading never writes: an old config.json keeps exactly what it had.
        const config = normalizeSourcesConfig(await store.get<unknown>(CONFIG_KEY));
        const toggles = normalizeToggles(await store.get<unknown>(TOGGLES_KEY));
        set((state) => ({
          config: state.config === before.config ? config : state.config,
          toggles: state.toggles === before.toggles ? toggles : state.toggles,
          loaded: true,
        }));
        // The backend is the source of truth for answers: give it what we have.
        await sendWhenReady(get().config).then(() => set({ pushError: null }), showBackendError);
      } catch (e) {
        console.error("[sourcesStore] Failed to load:", e);
        set({ loaded: true });
      }
    }),

    setConfig: saveConfig,
    setConfigDurably: (c) => saveConfig(c, { durable: true }),

    setToggles: (t) => {
      let toggles: SourceToggles = { notes: false, tools: false };
      set((state) => {
        const next = typeof t === "function" ? t(state.toggles) : t;
        toggles = { notes: next.notes === true, tools: next.tools === true };
        return { toggles };
      });
      void persistToggles(toggles);
    },
  };
});

/**
 * The pills as they are right now, for a request the user makes. `undefined`
 * off the Claude subscription, or with no source set up at all (nothing to
 * send, so nobody who never set sources up sends anything new); otherwise each
 * pill that is on and has a source behind it. Both off still goes out when
 * sources exist: Shorten and FollowUp follow the answer they work on.
 */
export function requestToggles(): SourceToggles | undefined {
  if (useConfigStore.getState().llmProvider !== "claude_cli") return undefined;
  const { config, toggles } = useSourcesStore.getState();
  const kinds = enabledKinds(config);
  if (!kinds.notes && !kinds.tools) return undefined;
  return { notes: toggles.notes && kinds.notes, tools: toggles.tools && kinds.tools };
}
