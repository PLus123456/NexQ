import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "../lib/types";

const invoke = vi.hoisted(() => vi.fn());
const saveExportFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../lib/export", () => ({ saveExportFile }));
vi.mock("../hooks/useMeetingAgentUsage", () => ({ useMeetingAgentUsage: () => ({ sessions: [], usage: null }) }));
vi.mock("../stores/agentStore", () => ({
  useAgentStore: Object.assign((select: (state: { status: null }) => unknown) => select({ status: null }), {
    getState: () => ({ init: () => {} }),
  }),
}));

import { CallLogPanel } from "./CallLogPanel";
import { useCallLogStore } from "../stores/callLogStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useTranslationStore } from "../stores/translationStore";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command) => command === "export_translated_transcript" ? "bilingual content" : undefined);
  saveExportFile.mockReset();
  saveExportFile.mockResolvedValue(true);
  useCallLogStore.setState({ isOpen: true, entries: [] });
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
  useTranslationStore.setState({ targetLang: "es" });
  useTranscriptStore.setState({ segments: [
    { id: "final", text: "Hello", speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 1 },
    { id: "interim", text: "In progress", speaker: "Them", timestamp_ms: 2000, is_final: false, confidence: 1 },
  ] });
});

afterEach(cleanup);

describe("CallLogPanel translation export", () => {
  it("copies bilingual text using the native clipboard and includes the latest final line", async () => {
    render(<CallLogPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /copy to clipboard/i })));

    expect(invoke).toHaveBeenCalledWith("export_translated_transcript", {
      meetingId: "m1", targetLang: "es", format: "bilingual_txt",
      liveSegments: [{ id: "final", text: "Hello", speaker: "Them", timestamp_ms: 1000 }],
    });
    expect(invoke).toHaveBeenCalledWith("write_tray_clipboard", { text: "bilingual content" });
  });

  it("exports Markdown through the native file save helper", async () => {
    render(<CallLogPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Bilingual transcript (.md)" })));

    expect(saveExportFile).toHaveBeenCalledWith({
      defaultName: "transcript-bilingual-md", extension: "md", filterLabel: "MD", content: "bilingual content",
    });
  });
});
