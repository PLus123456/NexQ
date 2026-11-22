import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { textColor } from "../lib/themeColors";
import { createPortal } from "react-dom";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import {
  ArrowDown,
  Sparkles,
  Pin,
  PinOff,
  Copy,
  Check,
  Globe,
  History,
  Type,
} from "lucide-react";
import { AnswerMarkdown } from "../components/AnswerMarkdown";
import type { ParseKeys } from "i18next";
import { Trans, useT } from "../i18n";
import { getModeLabel } from "../lib/utils";
import type { AIResponse, StreamSource } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { ColorPickerButton } from "../components/ColorPickerButton";
import { ResponseProgress } from "./ResponseProgress";
import { ResponseHistoryList } from "./ResponseHistoryList";
import { formatDuration } from "./responseFormat";
import { SourceChips } from "../sources/SourceChips";
import { SourceActivityLines, SourceNotices } from "../sources/SourceActivityLines";
import { clampPopoverPosition, isInsideColorPickerPortal, type PopoverRect } from "./popoverUtils";

/** "current", "resp-<id>" (a history answer) or "pinned-<id>". */
type TabId = "current" | `resp-${string}` | `pinned-${string}`;

/** Answers shown as tabs next to "Current"; the rest are in History. */
const PREVIOUS_TABS = 4;
const BOTTOM_THRESHOLD_PX = 24;
const TYPESET_WIDTH = 244;
const TYPESET_EST_HEIGHT = 158;

const ALIGN_KEYS: Record<"left" | "center" | "right", { label: ParseKeys<"overlay">; title: ParseKeys<"overlay"> }> = {
  left: { label: "response.typeset.align.left.label", title: "response.typeset.align.left.title" },
  center: { label: "response.typeset.align.center.label", title: "response.typeset.align.center.title" },
  right: { label: "response.typeset.align.right.label", title: "response.typeset.align.right.title" },
};

// Streaming markdown, smart auto-follow, compact bottom tabs/actions bar, typeset popover
export function AIResponsePanel() {
  const { t } = useT("overlay");
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const phase = useStreamStore((s) => s.phase);
  const currentContent = useStreamStore((s) => s.currentContent);
  const currentMode = useStreamStore((s) => s.currentMode);
  const currentId = useStreamStore((s) => s.currentId);
  const error = useStreamStore((s) => s.error);
  const currentSources = useStreamStore((s) => s.currentSources);
  const currentActivity = useStreamStore((s) => s.currentActivity);
  const currentNotices = useStreamStore((s) => s.currentNotices);
  const responseHistory = useStreamStore((s) => s.responseHistory);
  const pinnedResponses = useStreamStore((s) => s.pinnedResponses);
  const pinResponse = useStreamStore((s) => s.pinResponse);
  const unpinResponse = useStreamStore((s) => s.unpinResponse);
  const meetingStart = useMeetingStore((s) => s.meetingStartTime);

  const aiResponseFontSize = useConfigStore((s) => s.aiResponseFontSize ?? 12);
  const aiResponseTextColor = useConfigStore((s) => s.aiResponseTextColor ?? "#d4d4d8");
  const answerColor = textColor(aiResponseTextColor, "#d4d4d8");
  const aiResponseLineHeight = useConfigStore((s) => s.aiResponseLineHeight ?? 1.6);
  const aiResponseHPad = useConfigStore((s) => s.aiResponseHPad ?? 0);
  const aiResponseAlign = useConfigStore((s) => s.aiResponseAlign ?? "left");
  const setAiResponseFontSize = useConfigStore((s) => s.setAiResponseFontSize);
  const setAiResponseTextColor = useConfigStore((s) => s.setAiResponseTextColor);
  const setAiResponseLineHeight = useConfigStore((s) => s.setAiResponseLineHeight);
  const setAiResponseHPad = useConfigStore((s) => s.setAiResponseHPad);
  const setAiResponseAlign = useConfigStore((s) => s.setAiResponseAlign);

  const proseStyle = {
    fontSize: `${aiResponseFontSize}px`,
    color: answerColor,
    lineHeight: aiResponseLineHeight,
    paddingLeft: `${aiResponseHPad}px`,
    paddingRight: `${aiResponseHPad}px`,
    textAlign: aiResponseAlign as React.CSSProperties["textAlign"],
  };

  const [activeTab, setActiveTab] = useState<TabId>("current");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [typesetOpen, setTypesetOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  autoFollowRef.current = autoFollow;

  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const typesetButtonRef = useRef<HTMLButtonElement>(null);
  const typesetPopRef = useRef<HTMLDivElement>(null);
  const [typesetPos, setTypesetPos] = useState<PopoverRect>({ top: 0, left: 8, maxHeight: 240 });

  // A request in flight: clicked (sending) or streaming.
  const inFlight = isStreaming || phase !== "idle";

  // Auto-scroll to bottom during streaming while autoFollow is enabled.
  useEffect(() => {
    if (isStreaming && autoFollow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentContent, isStreaming, autoFollow]);

  // Switch to "current" tab and resume auto-follow when a new request starts.
  useEffect(() => {
    if (inFlight || currentId) {
      setActiveTab("current");
      setHistoryOpen(false);
      setAutoFollow(true);
    }
  }, [inFlight, currentId]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= BOTTOM_THRESHOLD_PX) {
      if (!autoFollowRef.current) setAutoFollow(true);
    } else if (el.scrollHeight > el.clientHeight + BOTTOM_THRESHOLD_PX) {
      if (autoFollowRef.current) setAutoFollow(false);
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaY < 0 && el.scrollHeight > el.clientHeight + BOTTOM_THRESHOLD_PX) {
      if (autoFollowRef.current) setAutoFollow(false);
    }
  }, []);

  const scrollToLatest = useCallback(() => {
    setAutoFollow(true);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Typeset popover positioning & dismissal.
  useLayoutEffect(() => {
    if (!typesetOpen || !typesetButtonRef.current) return;
    const anchor = typesetButtonRef.current.getBoundingClientRect();
    setTypesetPos(clampPopoverPosition(anchor, TYPESET_WIDTH, TYPESET_EST_HEIGHT, "above", "right"));
  }, [typesetOpen]);

  useEffect(() => {
    if (!typesetOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        typesetPopRef.current?.contains(target) ||
        typesetButtonRef.current?.contains(target) ||
        isInsideColorPickerPortal(target)
      ) {
        return;
      }
      setTypesetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setTypesetOpen(false);
        typesetButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [typesetOpen]);

  const handleCopy = useCallback(async (content: string, id: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard access may fail in some contexts
    }
  }, []);

  const pinnedIds = useMemo(() => new Set(pinnedResponses.map((r) => r.id)), [pinnedResponses]);

  const handlePin = useCallback(
    (id: string) => {
      if (pinnedIds.has(id)) {
        unpinResponse(id);
      } else {
        pinResponse(id);
      }
    },
    [pinnedIds, pinResponse, unpinResponse],
  );

  // Tabs: Current, the previous answers (never the current one again), pinned.
  const previousResponses = useMemo(
    () => responseHistory.filter((r) => r.id !== currentId).slice(0, PREVIOUS_TABS),
    [responseHistory, currentId],
  );
  const currentResponse = currentId ? responseHistory.find((r) => r.id === currentId) ?? null : null;
  const hasTabs = previousResponses.length > 0 || pinnedResponses.length > 0;

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    historyButtonRef.current?.focus();
  }, []);

  // The answer a history / pinned tab shows (by id, so new answers never shift it).
  let displayResponse: AIResponse | null = null;
  if (activeTab !== "current") {
    const id = activeTab.replace(/^(resp|pinned)-/, "");
    displayResponse =
      responseHistory.find((r) => r.id === id) ?? pinnedResponses.find((r) => r.id === id) ?? null;
  }
  const displayContent = displayResponse?.content || null;
  const selectedId = activeTab === "current" ? currentId : displayResponse?.id ?? null;
  // An answer opened from History that has no tab of its own.
  const openedFromHistory =
    activeTab.startsWith("resp-") && !previousResponses.some((r) => `resp-${r.id}` === activeTab);

  // Content and response backing the bottom bar's Copy & Pin buttons.
  const activeCopyContent = activeTab === "current" ? (currentContent || null) : displayContent;
  const activeCopyKey = activeTab === "current" ? "current" : displayResponse?.id ?? "";
  const activePinTarget = activeTab === "current" ? (!inFlight ? currentResponse : null) : displayResponse;
  const hasVisibleContent =
    (activeTab === "current" && Boolean(currentContent)) ||
    (activeTab !== "current" && Boolean(displayContent));

  return (
    <div data-testid="ai-response-panel" className="flex flex-1 min-h-0 flex-col">
      {/* Thin top progress bar while a request is in flight */}
      {activeTab === "current" && inFlight && <ResponseProgress />}

      {/* Main scrollable answer viewport */}
      <div data-testid="answer-viewport" className="relative flex-1 min-h-0">
        {historyOpen && (
          <ResponseHistoryList
            responses={responseHistory}
            pinnedIds={pinnedIds}
            selectedId={selectedId}
            meetingStart={meetingStart}
            onSelect={(id) => {
              setActiveTab(id === currentId ? "current" : `resp-${id}`);
              setAutoFollow(true);
              closeHistory();
            }}
            onClose={closeHistory}
          />
        )}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          className="absolute inset-0 overflow-y-auto px-3 py-2"
          role="tabpanel"
          aria-label={t("response.content.ariaLabel")}
        >
          {/* Error state on current tab */}
          {activeTab === "current" && error && (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <p className="text-xs text-destructive/80">{error}</p>
            </div>
          )}

          {/* Request in flight: activity, notices, and streaming words immediately visible */}
          {activeTab === "current" && !error && inFlight && (
            <div className="space-y-2" aria-atomic="false">
              <SourceActivityLines lines={currentActivity.map((a) => a.label)} />
              <SourceNotices notices={currentNotices} />
              {currentContent && (
                <div className="min-w-0">
                  <AnswerMarkdown content={currentContent} streaming style={proseStyle} />
                  <span className="inline-block h-3 w-0.5 animate-pulse bg-primary/60 ml-0.5 align-middle" />
                </div>
              )}
            </div>
          )}

          {/* Finished current content */}
          {activeTab === "current" && !error && !inFlight && currentContent && (
            <div className="space-y-2">
              {currentMode && <AnswerMeta response={currentResponse} mode={currentMode} />}
              <SourceNotices notices={currentResponse?.source_notices ?? []} />
              <AnswerMarkdown style={proseStyle} content={currentContent} />
              <SourcesList sources={currentSources} />
              <SourceChips chips={currentResponse?.source_chips ?? []} />
            </div>
          )}

          {/* History / pinned tab content */}
          {activeTab !== "current" && displayContent && displayResponse && (
            <div className="space-y-2">
              <AnswerMeta response={displayResponse} mode={displayResponse.mode} />
              <SourceNotices notices={displayResponse.source_notices ?? []} />
              <AnswerMarkdown style={proseStyle} content={displayContent} />
              <SourcesList sources={displayResponse.sources} />
              <SourceChips chips={displayResponse.source_chips ?? []} />
            </div>
          )}

          {/* Empty state */}
          {activeTab === "current" && !error && !inFlight && !currentContent && (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <Sparkles className="h-5 w-5 text-primary/30" />
              <p className="text-xs text-muted-foreground/50">
                <Trans
                  t={t}
                  i18nKey="response.empty.hint"
                  components={{
                    kbd: (
                      <kbd className="mx-0.5 rounded border border-border/30 bg-secondary/30 px-1.5 py-0.5 font-mono text-meta text-foreground/70" />
                    ),
                  }}
                />
              </p>
            </div>
          )}
        </div>

        {/* Floating "Back to latest" button when user scrolled up */}
        {!autoFollow && hasVisibleContent && !historyOpen && (
          <button
            type="button"
            onClick={scrollToLatest}
            className="fade-in-up absolute bottom-2 right-3 z-10 flex items-center gap-1 rounded-full border border-primary/25 bg-popover/95 px-2.5 py-1 text-meta font-medium text-primary shadow-lg backdrop-blur-md transition-colors hover:bg-primary/15 cursor-pointer"
          >
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            <span>{t("response.scrollToLatest")}</span>
          </button>
        )}
      </div>

      {/* Single bottom row: tabs (Current / previous / pinned) + History + Copy / Pin + Typeset */}
      <div
        data-testid="answer-footer-bar"
        className="flex shrink-0 items-center gap-1 border-t border-border/15 px-2 py-0.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {hasTabs && (
            <div className="flex items-center gap-1" role="tablist" aria-label={t("response.tabs.ariaLabel")}>
              <TabButton
                label={t("response.tabs.current")}
                active={activeTab === "current"}
                onClick={() => {
                  setActiveTab("current");
                  setAutoFollow(true);
                }}
              />
              {previousResponses.map((resp) => (
                <TabButton
                  key={resp.id}
                  label={getModeLabel(resp.mode)}
                  active={activeTab === `resp-${resp.id}`}
                  onClick={() => {
                    setActiveTab(`resp-${resp.id}`);
                    setAutoFollow(true);
                  }}
                  secondary
                />
              ))}
              {pinnedResponses.map((resp) => (
                <TabButton
                  key={resp.id}
                  label={getModeLabel(resp.mode)}
                  active={activeTab === `pinned-${resp.id}`}
                  onClick={() => {
                    setActiveTab(`pinned-${resp.id}`);
                    setAutoFollow(true);
                  }}
                  pinned
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {responseHistory.length > 0 && (
            <button
              ref={historyButtonRef}
              type="button"
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
              aria-expanded={historyOpen}
              aria-haspopup="dialog"
              aria-label={t("response.history.ariaLabel", { count: responseHistory.length })}
              title={t("response.history.ariaLabel", { count: responseHistory.length })}
              className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-meta font-medium transition-colors duration-150 cursor-pointer ${
                historyOpen || openedFromHistory
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/65 hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <History className="h-3 w-3" aria-hidden="true" />
              <span className="tabular-nums">{responseHistory.length}</span>
            </button>
          )}

          {activeCopyContent && (
            <ActionButton
              icon={copiedId === activeCopyKey ? Check : Copy}
              title={t("response.actions.copy")}
              onClick={() => handleCopy(activeCopyContent, activeCopyKey)}
              active={copiedId === activeCopyKey}
            />
          )}

          {activePinTarget && (
            <ActionButton
              icon={pinnedIds.has(activePinTarget.id) ? PinOff : Pin}
              title={pinnedIds.has(activePinTarget.id) ? t("response.actions.unpin") : t("response.actions.pin")}
              onClick={() => handlePin(activePinTarget.id)}
              active={pinnedIds.has(activePinTarget.id)}
            />
          )}

          <button
            ref={typesetButtonRef}
            type="button"
            onClick={() => setTypesetOpen((v) => !v)}
            aria-expanded={typesetOpen}
            aria-haspopup="dialog"
            aria-label={t("response.typeset.buttonTitle")}
            title={t("response.typeset.buttonTitle")}
            className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-meta font-medium transition-colors duration-150 cursor-pointer ${
              typesetOpen
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground/65 hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Type className="h-3 w-3" aria-hidden="true" />
            <span>{t("response.typeset.button")}</span>
          </button>
        </div>
      </div>

      {/* Floating typeset popover */}
      {typesetOpen &&
        createPortal(
          <div
            ref={typesetPopRef}
            role="dialog"
            aria-label={t("response.typeset.dialogLabel")}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ top: typesetPos.top, left: typesetPos.left, width: TYPESET_WIDTH }}
            className="scope-pop-enter fixed z-50 flex flex-col gap-2 rounded-xl border border-border/30 bg-popover/95 p-2.5 shadow-2xl backdrop-blur-md"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/55">
              {t("response.typeset.dialogLabel")}
            </p>

            {/* Font size + Color */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground/80">{t("response.typeset.fontSize")}</span>
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-0.5 rounded-md border border-border/25 px-0.5">
                  <button
                    type="button"
                    onClick={() => setAiResponseFontSize(Math.max(8, aiResponseFontSize - 1))}
                    className="h-5 w-5 flex items-center justify-center rounded text-[10px] text-muted-foreground/75 hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer"
                    title={t("response.typeset.smaller")}
                    aria-label={t("response.typeset.smaller")}
                  >
                    A
                  </button>
                  <span className="w-6 text-center text-meta tabular-nums text-foreground/85">{aiResponseFontSize}</span>
                  <button
                    type="button"
                    onClick={() => setAiResponseFontSize(Math.min(32, aiResponseFontSize + 1))}
                    className="h-5 w-5 flex items-center justify-center rounded text-xs font-medium text-muted-foreground/75 hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer"
                    title={t("response.typeset.larger")}
                    aria-label={t("response.typeset.larger")}
                  >
                    A
                  </button>
                </div>
                <ColorPickerButton
                  value={aiResponseTextColor}
                  onChange={setAiResponseTextColor}
                  label={t("response.typeset.colorLabel")}
                />
              </div>
            </div>

            {/* Line height */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground/80">{t("response.typeset.lineHeight.label")}</span>
              <div className="flex items-center gap-0.5 rounded-md border border-border/25 px-0.5">
                <button
                  type="button"
                  onClick={() => setAiResponseLineHeight(Math.max(1.0, parseFloat((aiResponseLineHeight - 0.1).toFixed(1))))}
                  className="h-5 w-5 flex items-center justify-center rounded text-xs text-muted-foreground/75 hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer"
                  title={t("response.typeset.lineHeight.decrease")}
                  aria-label={t("response.typeset.lineHeight.decrease")}
                >
                  −
                </button>
                <span className="w-7 text-center text-meta tabular-nums text-foreground/85">
                  {aiResponseLineHeight.toFixed(1)}
                </span>
                <button
                  type="button"
                  onClick={() => setAiResponseLineHeight(Math.min(3.0, parseFloat((aiResponseLineHeight + 0.1).toFixed(1))))}
                  className="h-5 w-5 flex items-center justify-center rounded text-xs text-muted-foreground/75 hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer"
                  title={t("response.typeset.lineHeight.increase")}
                  aria-label={t("response.typeset.lineHeight.increase")}
                >
                  +
                </button>
              </div>
            </div>

            {/* Horizontal padding */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground/80">{t("response.typeset.margin.label")}</span>
              <div className="flex items-center gap-0.5 rounded-md border border-border/25 px-0.5">
                <button
                  type="button"
                  onClick={() => setAiResponseHPad(Math.max(0, aiResponseHPad - 4))}
                  className="h-5 w-5 flex items-center justify-center rounded text-xs text-muted-foreground/75 hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer"
                  title={t("response.typeset.margin.decrease")}
                  aria-label={t("response.typeset.margin.decrease")}
                >
                  −
                </button>
                <span className="w-7 text-center text-meta tabular-nums text-foreground/85">{aiResponseHPad}</span>
                <button
                  type="button"
                  onClick={() => setAiResponseHPad(Math.min(80, aiResponseHPad + 4))}
                  className="h-5 w-5 flex items-center justify-center rounded text-xs text-muted-foreground/75 hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer"
                  title={t("response.typeset.margin.increase")}
                  aria-label={t("response.typeset.margin.increase")}
                >
                  +
                </button>
              </div>
            </div>

            {/* Alignment */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground/80">{t("response.typeset.align.label")}</span>
              <div className="flex items-center overflow-hidden rounded-md border border-border/25">
                {(["left", "center", "right"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAiResponseAlign(a)}
                    aria-pressed={aiResponseAlign === a}
                    className={`px-2 py-0.5 text-meta font-medium transition-colors cursor-pointer ${
                      aiResponseAlign === a
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground"
                    }`}
                    title={t(ALIGN_KEYS[a].title)}
                  >
                    {t(ALIGN_KEYS[a].label)}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// --- Sub-components ---

function SourcesList({ sources }: { sources?: StreamSource[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/10 pt-2">
      <Globe className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
      {sources.map((source, idx) => (
        <a
          key={`${source.url}-${idx}`}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.url}
          className="max-w-[14rem] truncate rounded-full bg-accent/30 px-2 py-0.5 text-meta text-muted-foreground/70 hover:bg-accent/50 hover:text-foreground/80 transition-colors"
        >
          {source.title}
        </a>
      ))}
    </div>
  );
}

/** Compact single-line answer metadata: mode pill, prepared mark, scope & timing. */
function AnswerMeta({
  response,
  mode,
}: {
  response: AIResponse | null;
  mode: AIResponse["mode"];
}) {
  const { t } = useT("overlay");
  const total = response ? response.total_ms || response.latency_ms : null;
  const timing = [
    total ? formatDuration(total) : null,
    response?.first_token_ms != null
      ? t("response.timing.firstWords", { duration: formatDuration(response.first_token_ms) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] leading-none font-medium text-primary/80">
        {getModeLabel(mode)}
      </span>
      {response?.prepared && (
        <span className="shrink-0 text-meta text-info">{t("prediction.prepared")}</span>
      )}
      {(timing || response?.scope_label) && (
        <span className="min-w-0 truncate text-meta tabular-nums text-muted-foreground/45">
          {[response?.scope_label, timing].filter(Boolean).join(" · ")}
        </span>
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  secondary,
  pinned,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  secondary?: boolean;
  pinned?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-meta font-medium transition-colors duration-150 cursor-pointer ${
        active
          ? "bg-primary/20 text-primary"
          : secondary
            ? "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground"
            : pinned
              ? "text-warning/70 hover:bg-warning/10 hover:text-warning"
              : "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground"
      }`}
    >
      {pinned && <Pin className="mr-0.5 inline-block h-2.5 w-2.5" aria-hidden="true" />}
      {label}
    </button>
  );
}

function ActionButton({
  icon: Icon,
  title,
  onClick,
  active,
}: {
  icon: typeof Copy;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md p-1 transition-colors duration-150 cursor-pointer ${
        active
          ? "text-success"
          : "text-muted-foreground/65 hover:text-foreground hover:bg-accent/50"
      }`}
      aria-label={title}
      title={title}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
