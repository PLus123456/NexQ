// A stand-in for the Tauri backend, so the real React UI runs in a plain
// browser. main.tsx installs it BEFORE it loads any app module: several of
// them talk to Tauri as soon as they are imported. This file imports nothing
// from the app.

import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type Args = Record<string, unknown>;
/** Answers one `invoke(command, args)`; may return a promise. */
export type CommandHandler = (args: Args) => unknown;
type Invoke = (cmd: string, args?: Args, options?: unknown) => Promise<unknown>;

/** The windows the app has (tauri.conf.json), as the window API lists them. */
const WINDOWS = ["launcher", "overlay", "captions"];

const handlers = new Map<string, CommandHandler>();
const reported = new Set<string>();
const visible = new Map<string, boolean>(WINDOWS.map((label) => [label, false]));

// ── plugin-store: one in-memory file per path, shared by every `load` ───────

const stores = new Map<string, Map<string, unknown>>();
const storePaths: string[] = []; // resource id → path

function storeId(path: string): number {
  if (!stores.has(path)) stores.set(path, new Map());
  let rid = storePaths.indexOf(path);
  if (rid < 0) rid = storePaths.push(path) - 1;
  return rid;
}

const storeOf = (args: Args) => stores.get(storePaths[args.rid as number]) ?? new Map<string, unknown>();

/** Like the plugin: every window (the writer too) hears a change. */
function storeChanged(args: Args, exists: boolean) {
  const rid = args.rid as number;
  void emitEvent("store://change", { path: storePaths[rid], resourceId: rid, key: args.key, value: args.value ?? null, exists });
}

function installStorePlugin() {
  onCommand("plugin:store|load", (a) => storeId(a.path as string));
  onCommand("plugin:store|get_store", (a) => (stores.has(a.path as string) ? storeId(a.path as string) : null));
  onCommand("plugin:store|get", (a) => [storeOf(a).get(a.key as string) ?? null, storeOf(a).has(a.key as string)]);
  onCommand("plugin:store|has", (a) => storeOf(a).has(a.key as string));
  onCommand("plugin:store|set", (a) => {
    storeOf(a).set(a.key as string, a.value);
    storeChanged(a, true);
    return null;
  });
  onCommand("plugin:store|delete", (a) => {
    const existed = storeOf(a).delete(a.key as string);
    if (existed) storeChanged(a, false);
    return existed;
  });
  onCommand("plugin:store|keys", (a) => [...storeOf(a).keys()]);
  onCommand("plugin:store|values", (a) => [...storeOf(a).values()]);
  onCommand("plugin:store|entries", (a) => [...storeOf(a).entries()]);
  onCommand("plugin:store|length", (a) => storeOf(a).size);
  for (const cmd of ["clear", "reset"]) onCommand(`plugin:store|${cmd}`, (a) => (storeOf(a).clear(), null));
  for (const cmd of ["save", "reload"]) onCommand(`plugin:store|${cmd}`, () => null);
}

// ── windows ─────────────────────────────────────────────────────────────────

function installWindowPlugin() {
  onCommand("plugin:window|get_all_windows", () => WINDOWS);
  onCommand("plugin:webview|get_all_webviews", () => WINDOWS.map((label) => ({ label, windowLabel: label })));
  onCommand("plugin:window|is_visible", (a) => visible.get(a.label as string) ?? false);
  onCommand("plugin:window|show", (a) => (visible.set(a.label as string, true), note(`window "${a.label}" shown`)));
  onCommand("plugin:window|hide", (a) => (visible.set(a.label as string, false), note(`window "${a.label}" hidden`)));
  onCommand("plugin:window|set_ignore_cursor_events", (a) =>
    note(`window "${a.label}" ${a.value ? "lets the mouse through (locked)" : "takes the mouse again (unlocked)"}`));
  onCommand("plugin:window|scale_factor", () => window.devicePixelRatio);
  for (const cmd of ["is_minimized", "is_maximized", "is_fullscreen"]) onCommand(`plugin:window|${cmd}`, () => false);
  onCommand("plugin:window|is_focused", () => true);
}

/** Says in the console what a window call would have done in the app. */
function note(what: string): null {
  console.info(`[harness] ${what}`);
  return null;
}

// ── the app's own commands ──────────────────────────────────────────────────

/**
 * The four commands the overlay calls when it mounts (the caption strip calls
 * none). Any other command resolves to null and is named once in the console
 * (see `handle`), so one that needs a real answer here is easy to spot.
 */
function installAppDefaults() {
  onCommand("get_question_detection_settings", () => ({
    revision: 1,
    settings: { mode: "hybrid", confidence_threshold: 0.7, log_requests: false, prediction_enabled: false, prediction_prepare_answers: true },
    effective_mode: "hybrid",
    fallback_reason: null,
  }));
  onCommand("get_question_predictions", () => ({ meeting_id: null, revision: 0, enabled: false, expires_at_ms: 0, predictions: [] }));
  // One invented connection that answers everything (the status bar names it).
  // The app fills in the fields left out here (lib/llm/connection.ts).
  onCommand("llm_get_config", () => ({
    schema_version: 1,
    revision: 1,
    connections: [{ id: "c_harness", name: "Synthetic", kind: "openai_compat", enabled: true, default_model: "synthetic-model" }],
    routing: { default: { target: { connection_id: "c_harness", model: null }, params: {} }, tasks: {} },
    effective: {
      default: {
        source: "default", connection_id: "c_harness", connection_name: "Synthetic", kind: "openai_compat",
        model: "synthetic-model", via_fallback: false, error: null,
      },
    },
    claude_available: false,
  }));
  // No Claude session is open.
  onCommand("get_agent_sessions", () => []);
  onCommand("plugin:shell|open", (a) => note(`would open ${String(a.path)} in the system browser`));
}

// ── install ─────────────────────────────────────────────────────────────────

/** Sets or replaces the answer to a command (scenes use it to simulate answers). */
export function onCommand(command: string, handler: CommandHandler) {
  handlers.set(command, handler);
}

function handle(command: string, args: Args = {}): unknown {
  const handler = handlers.get(command);
  if (handler) return handler(args);
  if (!reported.has(command)) {
    reported.add(command);
    console.info(`[harness] no mock for "${command}": it resolves to null`, args);
  }
  return null;
}

interface TauriInternals {
  invoke: Invoke;
}

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

/**
 * Installs the fake backend for the window labelled `currentWindow`
 * ("overlay", "captions"…). Events are mocked too: `emitEvent` reaches every
 * `listen` of the app.
 */
export function installTauriMocks(currentWindow: string) {
  mockWindows(currentWindow, ...WINDOWS.filter((label) => label !== currentWindow));
  mockConvertFileSrc("macos");
  mockIPC((command, args) => handle(command, args as Args | undefined), { shouldMockEvents: true });

  // @tauri-apps/api sends `eventId` when a listener stops; the mock looks for
  // `id`, keeps the stopped listener and then warns on every later event.
  const mocked = internals();
  const invoke = mocked.invoke;
  mocked.invoke = (cmd, args, options) =>
    invoke(cmd, cmd === "plugin:event|unlisten" && args ? { ...args, id: args.eventId } : args, options);

  // plugin-os answers from values the app injects at start, not through invoke.
  Object.assign(window, {
    __TAURI_OS_PLUGIN_INTERNALS__: {
      platform: "macos", os_type: "macos", family: "unix", arch: "aarch64", version: "15.0.0", exe_extension: "", eol: "\n",
    },
  });
  visible.set(currentWindow, true);

  installStorePlugin();
  installWindowPlugin();
  installAppDefaults();
}

/** Sends a backend event to the app, as Rust's `emit` would. */
export function emitEvent(event: string, payload?: unknown): Promise<unknown> {
  return internals().invoke("plugin:event|emit", { event, payload });
}
