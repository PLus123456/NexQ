// A displayed line can be several merged segments (mergeConsecutiveSegments);
// its translation is every segment's, not just the first one's.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

import { TranscriptLine } from "./TranscriptLine";
import { useTranslationStore } from "../stores/translationStore";
import { mergeConsecutiveSegments } from "../lib/mergeSegments";
import type { TranscriptSegment, TranslationResult } from "../lib/types";

const T0 = 1_700_000_000_000;

function segment(id: string, text: string, offset: number): TranscriptSegment {
  return { id, text, speaker: "Them", speaker_id: "them", timestamp_ms: T0 + offset, is_final: true, confidence: 0.9 };
}

function translation(id: string, text: string, provider = "soniox"): TranslationResult {
  return { segment_id: id, original_text: id, translated_text: text, source_lang: "en", target_lang: "zh-CN", provider };
}

/** Three sentences Soniox finalized one by one, shown as one line. */
const merged = mergeConsecutiveSegments([
  segment("sx_1", "Good morning.", 0),
  segment("sx_2", "Let's start.", 1000),
  segment("sx_3", "First item.", 2000),
]);

beforeEach(() => {
  useTranslationStore.getState().clearTranslations();
  useTranslationStore.setState({ displayMode: "inline" });
});

afterEach(() => {
  cleanup();
});

describe("TranscriptLine translations", () => {
  it("merges into one line", () => {
    expect(merged).toHaveLength(1);
    expect(merged[0].originalIds).toEqual(["sx_1", "sx_2", "sx_3"]);
  });

  it("shows the translation of every merged segment", () => {
    useTranslationStore.getState().addTranslations([
      translation("sx_1", "早上好。"),
      translation("sx_2", "我们开始吧。"),
      translation("sx_3", "第一项。"),
    ]);
    render(<TranscriptLine segment={merged[0]} />);
    expect(screen.getByText("早上好。我们开始吧。第一项。")).toBeInTheDocument();
  });

  it("shows what has arrived while later sentences are still translating", () => {
    useTranslationStore.getState().addTranslation(translation("sx_1", "早上好。"));
    useTranslationStore.getState().setTranslating("sx_2", true);
    render(<TranscriptLine segment={merged[0]} />);
    expect(screen.getByText("早上好。")).toBeInTheDocument();
    expect(screen.queryByText("Translating...")).not.toBeInTheDocument();
  });

  it("says it is translating before anything arrived", () => {
    useTranslationStore.getState().setTranslating("sx_3", true);
    render(<TranscriptLine segment={merged[0]} />);
    expect(screen.getByText("Translating...")).toBeInTheDocument();
  });

  it("shows a failure instead of a spinner that never ends", () => {
    useTranslationStore.getState().handleTranslationError({ segment_id: "sx_1", error: "HTTP 401: invalid key" });
    render(<TranscriptLine segment={merged[0]} />);
    const failed = screen.getByText("Translation failed");
    expect(failed).toHaveAttribute("title", "HTTP 401: invalid key");
  });

  it("a single segment still works", () => {
    useTranslationStore.getState().addTranslation(translation("solo", "你好", "DeepL"));
    render(<TranscriptLine segment={segment("solo", "Hello", 0)} />);
    expect(screen.getByText("你好")).toBeInTheDocument();
  });
});
