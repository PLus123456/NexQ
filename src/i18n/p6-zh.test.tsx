// Chinese rendering of the P6 pages: nothing user-facing is left in English
// (apart from product, technical and key names), and the Chinese resources
// follow the punctuation rules in README.md.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The AI actions page loads its configuration from the backend; without one it keeps the built-in defaults.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "get_action_configs") throw new Error("no backend");
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { changeUiLanguage } from ".";
import { zhCN } from "./resources";
import { untranslatedWords } from "../test/untranslated";
import { MeetingCard } from "../launcher/MeetingCard";
import { RecentMeetings } from "../launcher/RecentMeetings";
import { HotkeySettings } from "../settings/HotkeySettings";
import { NoisePresetSettings } from "../settings/NoisePresetSettings";
import { ConfidenceSettings } from "../settings/ConfidenceSettings";
import { MeetingDetectionSettings } from "../settings/MeetingDetectionSettings";
import { StealthSettings } from "../settings/StealthSettings";
import { ScenarioSettings } from "../settings/ScenarioSettings";
import { AIActionsSettings } from "../settings/AIActionsSettings";
import { ModeButtons } from "../overlay/ModeButtons";
import { SpeakerStatsPanel } from "../overlay/SpeakerStatsPanel";
import { TranscriptContextMenu } from "../overlay/TranscriptContextMenu";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useSpeakerStore } from "../stores/speakerStore";
import type { MeetingSummary } from "../lib/types";

/** Words that stay in English in a Chinese UI: product, technical and key names. */
const KEEP = [
  "NexQ", "Plus", "AI", "API", "VAD", "RAG", "Claude", "CLI", "Top", "Ctrl", "Cmd", "Shift", "Alt", "Esc", "Enter",
  "Space", "dB", "Zoom", "Teams", "Microsoft", "Google", "Meet", "Webex", "Discord", "Slack", "Huddle", "OBS",
  "ScreenCaptureKit", "macOS", "Windows", "Take", "My", "token", "Markdown", "JSON", "SRT", "Escape", "Control", "Meta",
];

/** Action ids, shown as small tags on the AI action cards. */
const ACTION_IDS = ["Assist", "WhatToSay", "Shorten", "FollowUp", "Recap", "AskQuestion"];

/** The page as the user reads it: AI prompts shown in <pre> / <textarea> are data, not UI text. */
function scan(container: HTMLElement, keep: readonly string[] = []): string[] {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("pre, textarea").forEach((el) => el.remove());
  return untranslatedWords(copy, [...KEEP, ...keep]);
}

const meeting = (overrides: Partial<MeetingSummary> = {}): MeetingSummary => ({
  id: "m-1",
  title: "周会",
  start_time: new Date().toISOString(),
  end_time: null,
  duration_seconds: 1800,
  segment_count: 4,
  has_summary: false,
  ...overrides,
});

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => {
    await changeUiLanguage("zh-CN");
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await act(async () => {
    await changeUiLanguage("en");
  });
});

describe("Chinese UI", () => {
  it("meeting cards", () => {
    const { container } = render(
      <MeetingCard
        meeting={meeting({ audio_mode: "in_person", ai_scenario: "team_meeting" } as Partial<MeetingSummary>)}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        isLive
      />,
    );
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重命名" })).toBeInTheDocument();
    expect(scan(container)).toEqual([]);
  });

  it("the recent meetings list groups by day", () => {
    const { container } = render(
      <RecentMeetings meetings={[meeting()]} onSelect={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "今天" })).toBeInTheDocument();
    expect(scan(container)).toEqual([]);
  });

  it("the empty meeting list", () => {
    const { container } = render(
      <RecentMeetings meetings={[]} onSelect={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} />,
    );
    expect(screen.getByText("还没有会议")).toBeInTheDocument();
    expect(scan(container)).toEqual([]);
  });

  it.each([
    ["hotkeys", HotkeySettings],
    ["noise presets", NoisePresetSettings],
    ["confidence", ConfidenceSettings],
    ["meeting detection", MeetingDetectionSettings],
    ["hide from screen share", StealthSettings],
    ["scenarios", ScenarioSettings],
    ["AI actions", AIActionsSettings],
  ] as const)("settings: %s", async (_name, Page) => {
    const { container } = render(<Page />);
    await act(async () => {});
    expect(container.textContent).toMatch(/[一-鿿]/);
    expect(scan(container, ACTION_IDS)).toEqual([]);
  });

  it("the action buttons use the Chinese names", () => {
    const { container } = render(<ModeButtons />);
    for (const name of ["助手", "怎么说", "精简", "追问", "回顾", "提问"]) {
      expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(scan(container)).toEqual([]);
  });

  it("speaker stats name the fixed speakers in Chinese", () => {
    act(() => useSpeakerStore.getState().initForOnline());
    const { container } = render(<SpeakerStatsPanel isOpen />);
    expect(screen.getByText("我")).toBeInTheDocument();
    expect(screen.getByText("对方")).toBeInTheDocument();
    expect(scan(container)).toEqual([]);
  });

  it("the transcript context menu", () => {
    const { container } = render(
      <TranscriptContextMenu
        x={10}
        y={10}
        isBookmarked={false}
        onBookmark={vi.fn()}
        onAddNote={vi.fn()}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("添加书签")).toBeInTheDocument();
    expect(scan(container)).toEqual([]);
  });

  it("the error screen", () => {
    const Boom = () => {
      throw new Error("故障");
    };
    // React re-throws the render error to the window; keep jsdom from printing it.
    const mute = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener("error", mute);
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    window.removeEventListener("error", mute);
    expect(screen.getByText("出了点问题")).toBeInTheDocument();
    expect(scan(container)).toEqual([]);
  });
});

// ── Resources ───────────────────────────────────────────────────────────────

/** Chinese values in these namespaces that are meant to contain no Chinese (brand and technical names). */
const NO_CHINESE_OK = new Set([
  "common:components.endpointFields.auth.modes.bearer",
  "common:components.endpointFields.secret.label",
  "common:components.endpointFields.auth.keyPlaceholder",
  "settings:about.links.github",
  "settings:meetingDetection.apps.zoom",
  "settings:meetingDetection.apps.teams",
  "settings:meetingDetection.apps.googleMeet",
  "settings:meetingDetection.apps.webex",
  "settings:meetingDetection.apps.slack",
  "settings:meetingDetection.apps.discord",
  "calllog:panel.stats.tokens",
  "calllog:sidebar.stats.tokens",
  "calllog:prompt.tokens.label",
]);

function flatten(obj: object, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value as object, path, out);
  }
  return out;
}

describe("Chinese resources (settings, launcher, overlay, calllog, misc, common)", () => {
  const entries = (["common", "settings", "launcher", "overlay", "calllog", "misc"] as const).flatMap((ns) =>
    Object.entries(flatten(zhCN[ns])).map(([key, value]) => ({ id: `${ns}:${key}`, value })),
  );
  const CJK = "\\u4e00-\\u9fff";

  it("has no empty values and Chinese in every text", () => {
    const empty = entries.filter((e) => e.value.trim() === "").map((e) => e.id);
    expect(empty).toEqual([]);
    const latinOnly = entries
      .filter((e) => !new RegExp(`[${CJK}]`).test(e.value) && /[A-Za-z]{3,}/.test(e.value.replace(/\{\{[^}]*\}\}/g, "")))
      .map((e) => e.id)
      .filter((id) => !NO_CHINESE_OK.has(id));
    expect(latinOnly).toEqual([]);
  });

  it("uses the Chinese ellipsis, full-width punctuation and spaces around Latin text", () => {
    const text = (v: string) => v.replace(/\{\{[^}]*\}\}/g, "X").replace(/<\/?[A-Za-z][^>]*>/g, "");
    const dots = entries.filter((e) => /\.\.\./.test(e.value)).map((e) => e.id);
    expect(dots).toEqual([]);
    const halfWidth = entries
      .filter((e) => new RegExp(`[${CJK}][,;!?()]|[,;!?()][${CJK}]|[${CJK}]:|:[${CJK}]`).test(text(e.value)))
      .map((e) => e.id);
    expect(halfWidth).toEqual([]);
    const glued = entries
      .filter((e) => new RegExp(`[${CJK}][A-Za-z0-9]|[A-Za-z0-9][${CJK}]`).test(text(e.value)))
      .map((e) => e.id)
      // The placeholder is filled with a Chinese word: "按{{scenario}}场景整理", "{{label}}音量".
      .filter((id) => id !== "launcher:export.options.scenario.description" && id !== "settings:audio.meter.ariaLabel");
    expect(glued).toEqual([]);
  });

  it("calls the product {{appName}}, never NexQ", () => {
    const named = entries.filter((e) => /NexQ/.test(e.value)).map((e) => e.id);
    // The official app and its repository are named on purpose in these.
    expect(named.filter((id) => id !== "settings:about.coexistence.detail" && id !== "settings:about.credit")).toEqual([]);
  });
});
