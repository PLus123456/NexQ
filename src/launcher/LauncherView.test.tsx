import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LauncherView } from "./LauncherView";
import { deleteMeetingHistory, listMeetingHistoryIds, searchMeetings } from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useContextStore } from "../stores/contextStore";
import { useRagStore } from "../stores/ragStore";
import type { MeetingSummary } from "../lib/types";

vi.mock("../lib/ipc", async (original) => ({
  ...await original<typeof import("../lib/ipc")>(),
  searchMeetings: vi.fn(),
  listMeetingHistoryIds: vi.fn(),
  deleteMeetingHistory: vi.fn(),
}));
vi.mock("../stores/toastStore", async (original) => ({
  ...await original<typeof import("../stores/toastStore")>(),
  showToast: vi.fn(),
}));
vi.mock("../components/ServiceStatusBar", () => ({ ServiceStatusBar: () => null }));
vi.mock("../sources/PersonalSourcesEditor", () => ({ PersonalSourcesEditor: () => null }));
vi.mock("./LauncherStealthButton", () => ({ LauncherStealthButton: () => null }));
vi.mock("../context/TestSearchDialog", () => ({ TestSearchDialog: () => null }));

function summary(id: string, title = id): MeetingSummary {
  return {
    id, title, start_time: "2026-11-27T00:00:00Z", end_time: null, duration_seconds: 20,
    segment_count: 1, has_summary: false, audio_mode: "online", ai_scenario: "team_meeting",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useMeetingStore.setState({
    recentMeetings: [summary("History entry")],
    activeMeeting: null,
    selectedMeetingId: null,
    loadRecentMeetings: vi.fn(async () => {}),
  });
  useContextStore.setState({
    resources: [],
    loadResources: vi.fn(async () => {}),
    refreshTokenBudget: vi.fn(async () => {}),
  });
  useRagStore.setState({ refreshIndexStatus: vi.fn(async () => {}) });
});

describe("meeting history in the launcher", () => {
  it("keeps the latest search results and ignores a pending response after clearing", async () => {
    const older = deferred<MeetingSummary[]>();
    const newer = deferred<MeetingSummary[]>();
    const afterClear = deferred<MeetingSummary[]>();
    vi.mocked(searchMeetings)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
      .mockReturnValueOnce(afterClear.promise);
    render(<LauncherView />);
    const search = screen.getByRole("textbox", { name: "Search meetings" });
    fireEvent.change(search, { target: { value: "older" } });
    fireEvent.change(search, { target: { value: "newer" } });
    await act(async () => { newer.resolve([summary("New query result")]); });
    await act(async () => { older.resolve([summary("Stale query result")]); });
    expect(screen.getByText("New query result")).toBeTruthy();
    expect(screen.queryByText("Stale query result")).toBeNull();

    fireEvent.change(search, { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await act(async () => { afterClear.resolve([summary("Cleared query result")]); });
    expect(screen.queryByText("Cleared query result")).toBeNull();
    expect(screen.getByText("History entry")).toBeTruthy();
  });

  it("confirms the full history snapshot and reports a partial deletion", async () => {
    const ids = Array.from({ length: 62 }, (_, i) => `meeting-${i}`);
    vi.mocked(listMeetingHistoryIds).mockResolvedValue(ids);
    vi.mocked(deleteMeetingHistory).mockResolvedValue({
      deleted_ids: ids.slice(1), failed: 1, cleanup_pending: 1,
    });
    render(<LauncherView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete meeting history" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete meeting history confirmation" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete All 62 Meetings" }));
    });
    expect(deleteMeetingHistory).toHaveBeenCalledWith(ids);
    expect(showToast).toHaveBeenCalledWith("Deleted 61 meetings. Couldn't delete 1.", "error");
    expect(showToast).toHaveBeenCalledWith("Recording cleanup is pending for 1 deleted meeting.", "warning");
    expect(showToast).not.toHaveBeenCalledWith("Meeting history deleted", "info");
  });
});
