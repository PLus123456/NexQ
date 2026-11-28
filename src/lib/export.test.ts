import { beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportMeetingMinutes, exportStudyNotes, exportToMarkdown, saveExportFile } from "./export";
import { useScenarioStore } from "../stores/scenarioStore";
import type { Meeting, ScenarioTemplate } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));
vi.mock("../stores/toastStore", () => ({ showToast: vi.fn() }));

const exportTitle = (defaultName: string) => saveExportFile({
  defaultName,
  extension: "md",
  filterLabel: "Markdown",
  content: "Meeting notes",
});

describe("Markdown export's scenario", () => {
  const markdown = (ai_scenario: Meeting["ai_scenario"]) =>
    exportToMarkdown({ id: "m-1", title: "Standup", start_time: "2026-10-19T13:00:00Z", transcript: [], ai_interactions: [], ai_scenario } as unknown as Meeting);

  it("reads a built-in scenario's id as words", () => {
    expect(markdown("team_meeting")).toContain("**Scenario:** team meeting");
  });

  it("uses a custom scenario's name", () => {
    useScenarioStore.setState({
      customScenarios: [{ id: "custom_1", name: "Board review", is_custom: true } as ScenarioTemplate],
    });
    expect(markdown("custom_1")).toContain("**Scenario:** Board review");
    useScenarioStore.setState({ customScenarios: [] });
  });
});

describe("historical meeting exports", () => {
  const startTime = "2026-11-27T00:00:00Z";
  const meeting: Meeting = {
    id: "meeting",
    title: "Two sections",
    start_time: startTime,
    end_time: null,
    duration_seconds: 60,
    summary: null,
    config_snapshot: null,
    transcript: [
      { id: "first", text: "Legacy relative timestamp", timestamp_ms: 5000, speaker: "Them", is_final: true, confidence: 1 },
      { id: "second", text: "Absolute timestamp", timestamp_ms: Date.parse(startTime) + 15_000, speaker: "User", is_final: true, confidence: 1 },
      { id: "third", text: "Exactly on the boundary", timestamp_ms: Date.parse(startTime) + 30_000, speaker: "Them", is_final: true, confidence: 1 },
    ],
    topic_sections: [
      { id: "one", title: "Part one", start_ms: 0, end_ms: 30_000 },
      { id: "two", title: "Part two", start_ms: 30_000 },
    ],
    ai_interactions: [],
  };

  it.each([exportStudyNotes, exportMeetingMinutes])("puts legacy offsets and epoch times into the right sections in %o", (formatter) => {
    const markdown = formatter(meeting);
    const [, first, second] = markdown.split(/### Part (?:one|two)\n/);
    expect(first).toContain("Legacy relative timestamp");
    expect(first).toContain("Absolute timestamp");
    expect(first).not.toContain("Exactly on the boundary");
    expect(second).toContain("Exactly on the boundary");
    expect(second).not.toContain("Absolute timestamp");
  });

  it("removes reasoning blocks and keeps each action on one Markdown line", () => {
    const markdown = exportToMarkdown({
      ...meeting,
      ai_interactions: [{
        id: "answer", meeting_id: meeting.id, mode: "AskQuestion", provider: "test", model: "model",
        question_context: "", response: "<think>private reasoning</think>Final answer", timestamp: startTime, latency_ms: 1,
      }],
      action_items: [{ id: "action", text: "Book a room\r\n  and send an invite", completed: false, timestamp_ms: 0 }],
    });
    expect(markdown).toContain("- [ ] Book a room and send an invite");
    expect(markdown).toContain("Final answer");
    expect(markdown).not.toContain("private reasoning");
  });
});

describe("export filenames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(save).mockResolvedValue(null);
  });

  it.each([
    "项目讨论 2026", "專案會議", "日本語の会議", "한국어 회의",
    "Réunion café", "Cafe\u0301", "Обсуждение", "اجتماع ١٢٣",
    "Sprint_42 - review", "Release v2.3 (final) — notes, 100%! 🎉",
  ])("preserves valid filename characters in %s", async (title) => {
    await exportTitle(title);
    expect(save).toHaveBeenCalledWith({
      defaultPath: `${title}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
  });

  it("removes path separators, reserved punctuation and control characters", async () => {
    await exportTitle('项目<>:"/\\|?*\u0000\u0001\u001f讨论');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "项目讨论.md" }));
  });

  it.each(["", "   ", '<>:"/\\|?*', ".", "..", "... "])("falls back for an empty sanitized title %j", async (title) => {
    await exportTitle(title);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "meeting.md" }));
  });

  it("removes trailing dots and spaces", async () => {
    await exportTitle("  项目讨论. . ");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "项目讨论.md" }));
  });

  it.each(["CON", "prn", "Aux", "NUL", "COM1", "LPT9", "COM¹", "LPT²", "con.notes"])("escapes Windows device name %s", async (title) => {
    await exportTitle(title);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `_${title}.md` }));
  });

  it("writes to the Unicode path selected by the user", async () => {
    vi.mocked(save).mockResolvedValue("/exports/项目讨论.md");
    expect(await exportTitle("项目讨论")).toBe(true);
    expect(writeTextFile).toHaveBeenCalledWith("/exports/项目讨论.md", "Meeting notes");
  });

  it("removes leading dots so the file isn't hidden", async () => {
    await exportTitle("../会议/记录\\总结:?");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "会议记录总结.md" }));
  });

  it("bounds multibyte titles without splitting a Unicode character", async () => {
    await exportTitle("会".repeat(200));
    const path = vi.mocked(save).mock.calls[0][0]!.defaultPath!;
    expect(new TextEncoder().encode(path).length).toBeLessThan(255);
    expect(path).toBe(`${"会".repeat(66)}.md`);
  });

  it("does not write when the save dialog is cancelled", async () => {
    expect(await exportTitle("会议")).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
