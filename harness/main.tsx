// Entry of the preview harness: the app's real UI in a plain browser.
// See README.md (in Chinese) for the address parameters and the scenes.
//
// Order matters: the Tauri mocks are installed first, and only then are the
// app's modules loaded (dynamic imports), because some talk to Tauri on import.

import { StrictMode, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import "../src/index.css";
import { emitEvent, installTauriMocks } from "./mocks";
import type { CaptionEventName, SceneName } from "./scenes";

type View = "overlay" | "captions";
type Language = "zh-CN" | "en";

// ── what the address asks for ───────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const view: View = params.get("view") === "captions" ? "captions" : "overlay";
const language: Language = params.get("lang") === "en" ? "en" : "zh-CN";
const theme = params.get("theme") === "light" ? "light" : "dark";

/** The windows' sizes in tauri.conf.json. */
const DEFAULT_SIZE: Record<View, [number, number]> = { overlay: [500, 700], captions: [900, 140] };

function size(name: "w" | "h", fallback: number): number {
  const value = Number.parseInt(params.get(name) ?? "", 10);
  return Number.isFinite(value) && value >= 60 ? Math.min(value, 4000) : fallback;
}
const width = size("w", DEFAULT_SIZE[view][0]);
const height = size("h", DEFAULT_SIZE[view][1]);

installTauriMocks(view);
document.documentElement.classList.toggle("dark", theme === "dark");
// From the console: `harness.emit("transcript_final", { segment: … })` sends a backend event.
Object.assign(window, { harness: { emit: emitEvent } });

// ── the page around the app ─────────────────────────────────────────────────

const DESKTOP =
  "repeating-linear-gradient(90deg, rgb(255 255 255 / 0.07) 0 2px, transparent 2px 96px), "
  + "linear-gradient(135deg, #12304d 0%, #3c2b63 45%, #73323f 100%)";
const CHECKERBOARD = "repeating-conic-gradient(#b9b9b9 0% 25%, #f1f1f1 0% 50%) 0 0 / 24px 24px";
/** Bright and dark patches next to each other, like a frame of video. */
const PHOTO =
  "radial-gradient(circle at 28% 35%, #f8d66b 0, transparent 42%), "
  + "radial-gradient(circle at 78% 62%, #6fe3dc 0, transparent 48%), "
  + "linear-gradient(160deg, #1d2b3a, #4a3f78)";

const note: CSSProperties = {
  font: "12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#e5e7eb",
  background: "rgb(0 0 0 / 0.6)",
  padding: "6px 10px",
  whiteSpace: "pre-wrap",
};

/**
 * The frame stands in for the window: the app fills it. It sits in the page's
 * top left corner, so a browser window of the same size shows the app alone.
 * The transform keeps `position: fixed` parts of the app (toasts, menus) inside.
 */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div data-harness-frame style={{ position: "relative", width, height, overflow: "hidden", transform: "translateZ(0)" }}>
      {children}
    </div>
  );
}

/** Below the frame, outside a screenshot of the frame: what is shown, and the other scenes. */
function Legend({ scene, scenes }: { scene: SceneName | null; scenes: readonly SceneName[] }) {
  const link = (label: string, change: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) next.set(key, value);
    return <a key={label} href={`?${next}`} style={{ color: "#93c5fd", marginRight: 10 }}>{label}</a>;
  };
  return (
    <div style={{ ...note, width: "fit-content", maxWidth: "100vw" }}>
      {`预览页，数据全部是合成的 · ${view}${scene ? ` / ${scene}` : ""} · ${width}×${height} · ${language} · ${theme}\n`}
      {scenes.map((name) => link(name, { view: "overlay", scene: name }))}
      {link("captions", { view: "captions" })}
      {link(language === "en" ? "zh-CN" : "en", { lang: language === "en" ? "zh-CN" : "en" })}
      {link(theme === "dark" ? "light" : "dark", { theme: theme === "dark" ? "light" : "dark" })}
    </div>
  );
}

// ── views ───────────────────────────────────────────────────────────────────

type Scenes = typeof import("./scenes");

async function overlayPage(scenes: Scenes): Promise<ReactNode> {
  const scene = scenes.SCENES.find((name) => name === params.get("scene")) ?? "idle";
  scenes.seedOverlayScene(scene, language === "en" ? "Mock interview · Backend engineer" : "模拟面试 · 后端工程师");
  // As App.tsx renders the overlay window: the meeting view, the call log beside it, toasts on top.
  const [{ OverlayView }, { CallLogPanel }, { ToastContainer }] = await Promise.all([
    import("../src/overlay/OverlayView"),
    import("../src/calllog"),
    import("../src/components/Toast"),
  ]);
  return (
    <div style={{ minHeight: "100vh", background: DESKTOP }}>
      <Frame>
        <div className="text-foreground" style={{ display: "flex", height: "100%" }}>
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <OverlayView />
          </div>
          <CallLogPanel />
        </div>
        <ToastContainer />
      </Frame>
      <Legend scene={scene} scenes={scenes.SCENES} />
    </div>
  );
}

const NO_EVENTS: Record<CaptionEventName, { count: number; last: string }> = {
  transcript_update: { count: 0, last: "" },
  transcript_final: { count: 0, last: "" },
  translation_result: { count: 0, last: "" },
};

/** Plays the caption script while shown, and says below the frame what was sent. */
function CaptionsPage({ scenes, children }: { scenes: Scenes; children: ReactNode }) {
  const [sent, setSent] = useState(NO_EVENTS);
  useEffect(
    () => scenes.playCaptionScript((name, text) => {
      setSent((before) => ({ ...before, [name]: { count: before[name].count + 1, last: text } }));
    }),
    [scenes],
  );
  return (
    <div style={{ position: "relative", minHeight: "100vh", background: CHECKERBOARD }}>
      {/* Half checkerboard, half picture: how the strip reads on both. */}
      <div style={{ position: "absolute", top: 0, bottom: 0, left: width / 2, right: 0, background: PHOTO }} />
      <Frame>{children}</Frame>
      <div style={{ position: "relative" }}>
        <div data-harness-events style={{ ...note, width: "fit-content", maxWidth: "100vw" }}>
          {"脚本发出的事件（合成对话，循环播放）\n"}
          {(Object.keys(sent) as CaptionEventName[])
            .map((name) => `${name} ×${sent[name].count}${sent[name].last ? `  ${sent[name].last.slice(-60)}` : ""}`)
            .join("\n")}
        </div>
        <Legend scene={null} scenes={scenes.SCENES} />
      </div>
    </div>
  );
}

async function captionsPage(scenes: Scenes): Promise<ReactNode> {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const { CaptionsWindow } = await import("../src/captions/CaptionsWindow");
  return (
    <CaptionsPage scenes={scenes}>
      <CaptionsWindow />
    </CaptionsPage>
  );
}

// ── start ───────────────────────────────────────────────────────────────────

async function start() {
  const [{ createRoot }, { initI18n }, scenes] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n"),
    import("./scenes"),
  ]);
  // A fixed language: the harness has no stored setting, and no tray to tell.
  await initI18n({ language });
  const page = view === "captions" ? await captionsPage(scenes) : await overlayPage(scenes);
  createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>);
}

start().catch((err: unknown) => {
  // Shown in the page, so a screenshot of a broken harness says why.
  console.error("[harness] could not start:", err);
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  document.getElementById("root")!.textContent = `harness: ${message}`;
});
