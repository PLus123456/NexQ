import { create } from "zustand";
import type { LogEntry, LogEntryStatus, LogFilterKind, StreamUsage } from "../lib/types";
import { stripThinkTags } from "../lib/utils";

const MAX_ENTRIES = 100;

/**
 * Marks an entry that has received nothing for a long time (it can still recover). It is state kept in
 * `errorMessage`, so it stays English; CallLogEntry shows it in the UI language (`calllog:entry.stalled`).
 */
export const STALLED_MESSAGE = "No response yet"; // i18n-ignore: 存在 entry.errorMessage 里的状态值，界面上由 CallLogEntry 翻译显示

/** A stalled entry's placeholder error, cleared once anything arrives. */
function clearStall(e: LogEntry): Pick<LogEntry, "stalled" | "errorMessage"> {
  return e.stalled ? { stalled: false, errorMessage: null } : { stalled: e.stalled, errorMessage: e.errorMessage };
}

interface CallLogState {
  entries: LogEntry[];
  isOpen: boolean;
  activeFilter: LogFilterKind;
  expandedEntryId: string | null;

  // Lifecycle actions (called by useCallLogCapture)
  beginEntry: (entry: LogEntry) => void;
  appendToken: (id: string, token: string) => void;
  completeEntry: (id: string, totalTokens: number, latencyMs: number, usage?: StreamUsage | null) => void;
  /** The stream was stopped (by the user, or its meeting closed): not an error. */
  cancelEntry: (id: string, latencyMs: number) => void;
  failEntry: (id: string, message: string) => void;
  /** Nothing arrived for a long time: error-styled, but late tokens or the end revive it. */
  markStalled: (id: string) => void;

  // UI actions
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setFilter: (filter: LogFilterKind) => void;
  setExpandedEntry: (id: string | null) => void;
  clearAll: () => void;
}

export const useCallLogStore = create<CallLogState>((set, get) => ({
  entries: [],
  isOpen: false,
  activeFilter: "all",
  expandedEntryId: null,

  beginEntry: (entry) =>
    set((state) => ({
      entries: [entry, ...state.entries].slice(0, MAX_ENTRIES),
    })),

  appendToken: (id, token) =>
    set((state) => ({
      entries: state.entries.map((e) => {
        if (e.id !== id) return e;
        const raw = e.responseContent + token;
        return {
          ...e,
          ...clearStall(e),
          status: "streaming" as LogEntryStatus,
          responseContent: raw,
          responseContentClean: stripThinkTags(raw),
          firstTokenAt: e.firstTokenAt ?? Date.now(),
        };
      }),
    })),

  completeEntry: (id, totalTokens, latencyMs, usage = null) =>
    set((state) => ({
      entries: state.entries.map((e) => {
        if (e.id !== id) return e;
        return {
          ...e,
          ...clearStall(e),
          status: "complete" as LogEntryStatus,
          completedAt: Date.now(),
          totalTokens,
          latencyMs,
          usage,
          responseContentClean: stripThinkTags(e.responseContent),
        };
      }),
    })),

  cancelEntry: (id, latencyMs) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id !== id
          ? e
          : {
              ...e,
              ...clearStall(e),
              status: "cancelled" as LogEntryStatus,
              completedAt: Date.now(),
              latencyMs,
              responseContentClean: stripThinkTags(e.responseContent),
            }
      ),
    })),

  markStalled: (id) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id !== id || e.status !== "sending"
          ? e
          : { ...e, status: "error" as LogEntryStatus, stalled: true, errorMessage: STALLED_MESSAGE }
      ),
    })),

  failEntry: (id, message) =>
    set((state) => ({
      entries: state.entries.map((e) => {
        if (e.id !== id) return e;
        return {
          ...e,
          status: "error" as LogEntryStatus,
          stalled: false,
          completedAt: Date.now(),
          errorMessage: message,
        };
      }),
    })),

  setOpen: (open) => set({ isOpen: open }),
  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),
  setFilter: (filter) => set({ activeFilter: filter }),
  setExpandedEntry: (id) =>
    set((state) => ({
      expandedEntryId: state.expandedEntryId === id ? null : id,
    })),
  clearAll: () => set({ entries: [], expandedEntryId: null }),
}));
