// Task 16: Bookmark hotkey hook
// Listens for Ctrl+B keydown while recording and adds a bookmark at current offset.
// Returns an addBookmarkAtNow() function for manual invocation (toolbar button).

import { useEffect, useCallback } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { findNearestSegment } from "../lib/bookmarkTarget";
import { showBookmarkToast } from "../overlay/BookmarkToast";

export function useBookmarkHotkey(): () => void {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const meetingStartTime = useMeetingStore((s) => s.meetingStartTime);
  const addBookmark = useBookmarkStore((s) => s.addBookmark);

  const addBookmarkAtNow = useCallback(() => {
    if (!isRecording || !meetingStartTime) return;
    const now = Date.now();
    const offsetMs = Math.max(0, now - meetingStartTime);
    const segments = useTranscriptStore.getState().segments;
    const target = findNearestSegment(segments, offsetMs, meetingStartTime);
    const bookmark = addBookmark(now, undefined, target?.id);
    showBookmarkToast(bookmark.id, offsetMs);
  }, [isRecording, meetingStartTime, addBookmark]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey && !e.metaKey) {
        // Only fire when recording; don't fire in input/textarea elements
        const target = e.target as HTMLElement | null;
        const isInput = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (!isRecording || isInput) return;
        e.preventDefault();
        addBookmarkAtNow();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isRecording, addBookmarkAtNow]);

  return addBookmarkAtNow;
}
