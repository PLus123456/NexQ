import { useT } from "../i18n";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useMeetingStore } from "../stores/meetingStore";
import { pauseAutoScrollForJump, useTranscriptStore } from "../stores/transcriptStore";
import { resolveBookmarkSegmentId, toElapsedMs } from "../lib/bookmarkTarget";
import { formatDurationLong } from "../lib/utils";
import { Bookmark, Trash2 } from "lucide-react";
import { useState } from "react";
import type { MeetingBookmark } from "../lib/types";

let activeJumpToken = 0;

function escapeAttrValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/** Scroll to a transcript line by segment ID and briefly highlight it */
function highlightSegment(segmentId: string): boolean {
  const el = document.querySelector(`[data-segment-id="${escapeAttrValue(segmentId)}"]`);
  if (!el) return false;
  pauseAutoScrollForJump();
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
  el.classList.add("ring-1", "ring-primary/40");
  setTimeout(() => el.classList.remove("ring-1", "ring-primary/40"), 1500);
  return true;
}

/**
 * Jump to a bookmarked line. Disables transcript auto-scroll first so opening
 * the drawer (or an in-flight bottom scroll) does not pull the viewport back
 * to the latest line. Falls back to the nearest line by in-meeting time when
 * a bookmark has no `segment_id`.
 */
function scrollToBookmark(bookmark: MeetingBookmark, openTranscript?: () => void) {
  const { segments, searchQuery, setSearchQuery } = useTranscriptStore.getState();
  const meetingStartTime = useMeetingStore.getState().meetingStartTime;
  const targetId = resolveBookmarkSegmentId(bookmark, segments, meetingStartTime);
  if (!targetId) return;

  const token = ++activeJumpToken;
  pauseAutoScrollForJump();
  if (highlightSegment(targetId)) return;

  const clearedSearch = searchQuery.trim().length > 0;
  if (clearedSearch) setSearchQuery("");
  if (!openTranscript && !clearedSearch) return;
  openTranscript?.();

  let tries = 0;
  const retry = () => {
    if (token !== activeJumpToken) return;
    if (highlightSegment(targetId) || ++tries >= 10) return;
    requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}

export function BookmarkPanel({ onOpenTranscript }: { onOpenTranscript?: () => void } = {}) {
  const { t } = useT("overlay");
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const removeBookmark = useBookmarkStore((s) => s.removeBookmark);
  const updateBookmarkNote = useBookmarkStore((s) => s.updateBookmarkNote);
  const meetingStartTime = useMeetingStore((s) => s.meetingStartTime);
  const sorted = [...bookmarks].sort(
    (a, b) => toElapsedMs(a.timestamp_ms, meetingStartTime) - toElapsedMs(b.timestamp_ms, meetingStartTime),
  );

  if (sorted.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground/40">
        <p className="text-xs">{t("bookmarks.panel.empty")}</p>
      </div>
    );
  }

  return (
    <div className="max-h-40 overflow-y-auto px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <Bookmark className="h-3 w-3 text-primary/60" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
          {t("bookmarks.panel.title", { total: sorted.length })}
        </span>
      </div>
      <div className="space-y-0.5">
        {sorted.map((b) => (
          <BookmarkRow
            key={b.id}
            bookmark={b}
            meetingStartTime={meetingStartTime}
            onUpdateNote={(note) => updateBookmarkNote(b.id, note)}
            onRemove={() => removeBookmark(b.id)}
            onOpenTranscript={onOpenTranscript}
          />
        ))}
      </div>
    </div>
  );
}

function BookmarkRow({
  bookmark,
  meetingStartTime,
  onUpdateNote,
  onRemove,
  onOpenTranscript,
}: {
  bookmark: MeetingBookmark;
  meetingStartTime: number | null;
  onUpdateNote: (note: string) => void;
  onRemove: () => void;
  onOpenTranscript?: () => void;
}) {
  const { t } = useT("overlay");
  const [editNote, setEditNote] = useState(bookmark.note ?? "");
  const [editing, setEditing] = useState(false);

  // Convert epoch or legacy offset timestamp to elapsed time since meeting start
  const elapsedMs = toElapsedMs(bookmark.timestamp_ms, meetingStartTime);

  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-secondary/20">
      <button
        onClick={() => scrollToBookmark(bookmark, onOpenTranscript)}
        className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 hover:bg-primary/20 transition-colors cursor-pointer"
        title={t("bookmarks.panel.jump")}
      >
        <span className="tabular-nums text-[10px] font-semibold text-primary">
          {formatDurationLong(elapsedMs)}
        </span>
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            onBlur={() => { onUpdateNote(editNote); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onUpdateNote(editNote); setEditing(false); }
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={500}
            placeholder={t("bookmarks.panel.notePlaceholder")}
            className="w-full bg-transparent text-xs text-foreground/80 placeholder:text-muted-foreground/30 outline-none"
          />
        ) : (
          <span
            onClick={() => setEditing(true)}
            className="block truncate text-xs text-foreground/60 hover:text-foreground/80 cursor-text"
          >
            {bookmark.note || <span className="italic text-muted-foreground/30">{t("bookmarks.panel.notePlaceholder")}</span>}
          </span>
        )}
      </div>
      <button onClick={onRemove} className="shrink-0 text-muted-foreground/30 hover:text-destructive cursor-pointer">
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
