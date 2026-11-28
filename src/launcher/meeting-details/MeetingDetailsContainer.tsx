import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Meeting, MeetingBookmark, RecordingInfo, TranslationResult } from "../../lib/types";
import { getMeeting, getRecordingInfo, getAllMeetingTranslations, translateSegments, startPastMeetingSession, closePastMeetingSession, renameSpeaker } from "../../lib/ipc";
import { withSpeakerName } from "../../lib/speakerLabels";
import { findNearestSegment, toElapsedMs } from "../../lib/bookmarkTarget";
import { showToast } from "../../stores/toastStore";
import { onTranscriptFinal, onRecordingReady, onTranslationResult, onTranslationError } from "../../lib/events";
import { useMeetingStore } from "../../stores/meetingStore";
import { useTranslationStore } from "../../stores/translationStore";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStats } from "../../hooks/useMeetingStats";
import { useTranscriptSearch } from "../../hooks/useTranscriptSearch";
import { useSummaryGeneration } from "../../hooks/useSummaryGeneration";
import { useActionItemsExtraction } from "../../hooks/useActionItemsExtraction";
import { useBookmarkSuggestions } from "../../hooks/useBookmarkSuggestions";
import { useMeetingChat, answeredExchanges } from "../../hooks/useMeetingChat";
import { useAudioKeyboardShortcuts } from "../../hooks/useAudioKeyboardShortcuts";
import { useT } from "../../i18n";
import { exportMeetingAsMarkdown } from "../../lib/export";
import { mergeConsecutiveSegments } from "../../lib/mergeSegments";
import { useDemoStore } from "../../demo/demoStore";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { useBookmarkStore } from "../../stores/bookmarkStore";
import { useActionItemStore } from "../../stores/actionItemStore";
import { useSpeakerStore } from "../../stores/speakerStore";
import { MeetingHeader } from "./MeetingHeader";
import { MeetingTabBar, type MeetingTab } from "./MeetingTabBar";
import { TranscriptView } from "./TranscriptView";
import { SummaryView } from "./SummaryView";
import { AIInteractionLog } from "./AIInteractionLog";
import { SpeakersTab } from "./SpeakersTab";
import { ActionItemsTab } from "./ActionItemsTab";
import { BookmarksTab } from "./BookmarksTab";
import { AskMeetingTab } from "./AskMeetingTab";
import { AudioPlayer } from "../../components/AudioPlayer";
import { Loader2 } from "lucide-react";

interface MeetingDetailsProps {
  meetingId: string;
  onBack: () => void;
}

export function MeetingDetails(props: MeetingDetailsProps) {
  return <MeetingDetailsContent key={props.meetingId} {...props} />;
}

function MeetingDetailsContent({ meetingId, onBack }: MeetingDetailsProps) {
  const { t } = useT("launcher");
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MeetingTab>("transcript");
  const [expandedInteraction, setExpandedInteraction] = useState<string | null>(null);
  const [scrollToSegmentIndex, setScrollToSegmentIndex] = useState<number | null>(null);
  const [recordingInfo, setRecordingInfo] = useState<RecordingInfo | null>(null);

  // Translation state for post-meeting view
  const [translationVersions, setTranslationVersions] = useState<Map<string, Map<string, TranslationResult>>>(new Map());
  const [translatingSegments, setTranslatingSegments] = useState<Set<string>>(new Set());
  const [translationsVisible, setTranslationsVisible] = useState(true);
  const [retranslating, setRetranslating] = useState(false);
  const translationGeneration = useRef(0);

  // Translation store selectors
  const displayMode = useTranslationStore((s) => s.displayMode);
  const setDisplayMode = useTranslationStore((s) => s.setDisplayMode);
  const currentTargetLang = useTranslationStore((s) => s.targetLang);
  const autoTranslateEnabled = useTranslationStore((s) => s.autoTranslateEnabled);
  const showPostMeetingTranslation = useConfigStore((s) => s.showPostMeetingTranslation);

  // Demo mode — build Meeting from Zustand stores instead of IPC
  const isDemoActive = useDemoStore((s) => s.isDemoActive);

  // Build a Meeting from demo stores (reads current state at call time)
  const buildDemoMeeting = useCallback((): Meeting | null => {
    const { recentMeetings } = useMeetingStore.getState();
    const summary = recentMeetings.find((m) => m.id === meetingId);
    if (!summary) return null;
    return {
      id: summary.id,
      title: summary.title,
      start_time: summary.start_time,
      end_time: summary.end_time ?? null,
      duration_seconds: summary.duration_seconds ?? null,
      transcript: useTranscriptStore.getState().segments,
      ai_interactions: [],
      summary: null,
      config_snapshot: null,
      audio_mode: summary.audio_mode,
      ai_scenario: summary.ai_scenario,
      speakers: useSpeakerStore.getState().getAllSpeakers(),
      bookmarks: useBookmarkStore.getState().bookmarks,
      action_items: useActionItemStore.getState().items,
    };
  }, [meetingId]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setMeeting(null);

    if (isDemoActive) {
      const demoMeeting = buildDemoMeeting();
      if (demoMeeting) {
        setMeeting(demoMeeting);
      } else {
        setError(t("container.error.demoNotFound"));
      }
      setLoading(false);
      return;
    }

    void getMeeting(meetingId).then((data) => {
      if (!disposed) setMeeting(data);
    }).catch((err) => {
      if (!disposed) setError(err instanceof Error ? err.message : t("container.error.loadFailed"));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
    // `t` is read when a load fails; switching the UI language must not reload the meeting.
  }, [meetingId, isDemoActive, buildDemoMeeting]);

  // In demo mode, keep meeting data in sync with stores as they update
  const demoSegments = useTranscriptStore((s) => isDemoActive ? s.segments : null);
  const demoBookmarks = useBookmarkStore((s) => isDemoActive ? s.bookmarks : null);
  const demoActionItems = useActionItemStore((s) => isDemoActive ? s.items : null);

  useEffect(() => {
    if (!isDemoActive) return;
    const updated = buildDemoMeeting();
    if (updated) setMeeting(updated);
  }, [isDemoActive, buildDemoMeeting, demoSegments, demoBookmarks, demoActionItems]);

  // Live transcript subscription
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const isActiveMeeting = activeMeetingId === meetingId;

  // Claude CLI: keep a warm session holding this meeting's transcript and
  // summary while the view is open; closed on leaving. The running meeting
  // uses its live session instead.
  const llmProvider = useConfigStore((s) => s.llmProvider);
  useEffect(() => {
    if (isDemoActive || isActiveMeeting || llmProvider !== "claude_cli") return;
    startPastMeetingSession(meetingId).catch((err) =>
      console.warn("[MeetingDetails] Claude session did not start:", err)
    );
    return () => {
      closePastMeetingSession(meetingId).catch(() => {});
    };
  }, [meetingId, isActiveMeeting, isDemoActive, llmProvider]);

  useEffect(() => {
    if (!isActiveMeeting) return;
    let disposed = false;
    const unlistenPromise = onTranscriptFinal((event) => {
      if (disposed || useMeetingStore.getState().activeMeeting?.id !== meetingId) return;
      setMeeting((prev) => {
        if (!prev) return prev;
        return { ...prev, transcript: [...prev.transcript, event.segment] };
      });
    }).catch((err) => console.warn("[MeetingDetails] Couldn't listen for transcripts:", err));
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten?.());
    };
  }, [isActiveMeeting, meetingId]);

  // Register before querying so a recording that finishes during load is picked up.
  useEffect(() => {
    setRecordingInfo(null);
    if (!meeting || isDemoActive) return;
    const recordingMeetingId = meeting.id;
    let disposed = false;
    let request = 0;
    const loadRecording = async () => {
      if (disposed) return;
      const id = ++request;
      try {
        const info = await getRecordingInfo(recordingMeetingId);
        if (!disposed && request === id) setRecordingInfo(info);
      } catch (err) {
        if (!disposed && request === id) {
          setRecordingInfo(null);
          console.warn("[MeetingDetails] Couldn't load recording:", err);
        }
      }
    };
    const subscription = onRecordingReady((data) => {
      if (data.meeting_id === recordingMeetingId) void loadRecording();
    }).catch((err) => console.warn("[MeetingDetails] Couldn't listen for recordings:", err));
    void subscription.then(loadRecording);
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten?.());
    };
  }, [meeting?.id, isDemoActive]);

  // Load saved languages once. A result delivered while loading takes precedence.
  useEffect(() => {
    if (isDemoActive) return;
    let disposed = false;
    void getAllMeetingTranslations(meetingId).then((results) => {
      if (disposed) return;
      setTranslationVersions((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (!result.segment_id || (result.meeting_id && result.meeting_id !== meetingId)) continue;
          const versions = next.get(result.segment_id);
          if (!versions?.has(result.target_lang)) {
            next.set(result.segment_id, new Map(versions).set(result.target_lang, result));
          }
        }
        return next;
      });
    }).catch((err) => {
      if (!disposed) console.error("[MeetingDetails] Failed to load translations:", err);
    });
    return () => { disposed = true; };
  }, [meetingId, isDemoActive]);

  const translations = useMemo(() => {
    const selected = new Map<string, TranslationResult>();
    for (const [segmentId, versions] of translationVersions) {
      const result = versions.get(currentTargetLang) ?? versions.values().next().value;
      if (result) selected.set(segmentId, result);
    }
    return selected;
  }, [translationVersions, currentTargetLang]);

  // Listen for new translation results (from on-demand translating)
  useEffect(() => {
    if (isDemoActive) return;
    const generation = ++translationGeneration.current;
    setTranslatingSegments(new Set());
    setRetranslating(false);
    const isCurrent = () => generation === translationGeneration.current;
    const unregisterError = (err: unknown) => console.warn("[MeetingDetails] Couldn't listen for translations:", err);
    const clearPending = (segmentId: string) => setTranslatingSegments((prev) => {
      const next = new Set(prev);
      next.delete(segmentId);
      return next;
    });
    const unlistenResult = onTranslationResult((result) => {
      const { segment_id: segmentId } = result;
      if (!isCurrent() || result.meeting_id !== meetingId || result.target_lang !== currentTargetLang || !segmentId) return;
      setTranslationVersions((prev) => {
        const next = new Map(prev);
        next.set(segmentId, new Map(prev.get(segmentId)).set(result.target_lang, result));
        return next;
      });
      clearPending(segmentId);
    }).catch(unregisterError);
    const unlistenError = onTranslationError((error) => {
      if (isCurrent() && error.meeting_id === meetingId && error.target_lang === currentTargetLang && error.segment_id) {
        clearPending(error.segment_id);
      }
    }).catch(unregisterError);
    return () => {
      ++translationGeneration.current;
      void unlistenResult.then((unlisten) => unlisten?.());
      void unlistenError.then((unlisten) => unlisten?.());
    };
  }, [meetingId, currentTargetLang, isDemoActive]);

  // Audio keyboard shortcuts (Space, Arrow keys, [ ])
  useAudioKeyboardShortcuts();

  // Hooks
  const stats = useMeetingStats(meeting);
  const search = useTranscriptSearch(meeting?.transcript ?? []);
  const summaryGeneration = useSummaryGeneration(meeting, (summary) => {
    setMeeting((prev) => (prev && prev.id === meeting?.id ? { ...prev, summary } : prev));
  });
  const actionExtraction = useActionItemsExtraction(meeting, (items) => {
    setMeeting((prev) => (prev && prev.id === meeting?.id ? { ...prev, action_items: items } : prev));
  });
  const bookmarkSuggestions = useBookmarkSuggestions(meeting, (newBookmark) => {
    setMeeting((prev) =>
      prev && prev.id === meeting?.id
        ? { ...prev, bookmarks: [...(prev.bookmarks ?? []), newBookmark] }
        : prev,
    );
  });
  // "Ask this meeting" is for finished meetings (not the running one, not demo).
  const showAsk = !isDemoActive && !isActiveMeeting;
  const meetingChat = useMeetingChat(meetingId, {
    enabled: showAsk,
    trackSession: showAsk && llmProvider === "claude_cli",
  });
  const chatExchanges = useMemo(() => answeredExchanges(meetingChat.items), [meetingChat.items]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        if (activeTab === "transcript") {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (activeTab === "summary") {
          e.preventDefault();
          if (!summaryGeneration.isGenerating && meeting && !meeting.summary) {
            summaryGeneration.generate();
          }
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeTab, summaryGeneration, meeting]);

  // On-demand translate a single segment
  const handleTranslateSegment = useCallback(async (segmentId: string, text: string) => {
    if (!meetingId || !currentTargetLang) return;
    const generation = translationGeneration.current;
    setTranslatingSegments((prev) => new Set(prev).add(segmentId));
    try {
      await translateSegments([segmentId], [text], meetingId, currentTargetLang);
    } catch (err) {
      console.error("[MeetingDetails] Translate segment failed:", err);
      if (generation !== translationGeneration.current) return;
      setTranslatingSegments((prev) => {
        const next = new Set(prev);
        next.delete(segmentId);
        return next;
      });
    }
  }, [meetingId, currentTargetLang]);

  // Retranslate a single mismatched segment
  const handleRetranslateSegment = useCallback(async (segmentId: string, text: string) => {
    await handleTranslateSegment(segmentId, text);
  }, [handleTranslateSegment]);

  // Retranslate all mismatched segments
  const handleRetranslateAll = useCallback(async () => {
    if (!meeting || !currentTargetLang) return;
    const mismatched = meeting.transcript
      .filter((s) => s.id && translations.has(s.id) && translations.get(s.id)!.target_lang !== currentTargetLang)
      .map((s) => ({ id: s.id!, text: s.text }));
    if (mismatched.length === 0) return;
    const generation = translationGeneration.current;
    setRetranslating(true);
    for (const seg of mismatched) {
      setTranslatingSegments((prev) => new Set(prev).add(seg.id));
    }
    try {
      await translateSegments(
        mismatched.map((s) => s.id),
        mismatched.map((s) => s.text),
        meeting.id,
        currentTargetLang,
      );
    } catch (err) {
      console.error("[MeetingDetails] Retranslate all failed:", err);
      if (generation !== translationGeneration.current) return;
      // Lines that never reported back (the batch failed up front) stop spinning.
      setTranslatingSegments((prev) => {
        const next = new Set(prev);
        for (const seg of mismatched) next.delete(seg.id);
        return next;
      });
    } finally {
      if (generation === translationGeneration.current) setRetranslating(false);
    }
  }, [meeting, translations, currentTargetLang]);

  // Translation toolbar stats — use merged segments to match what the user sees
  const mergedSegments = useMemo(
    () => meeting ? mergeConsecutiveSegments(meeting.transcript) : [],
    [meeting?.transcript]
  );
  const totalSegments = mergedSegments.length;
  const translatedCount = mergedSegments.filter((s) => s.id && translations.has(s.id)).length;
  const mismatchedCount = mergedSegments.filter(
    (s) => s.id && translations.has(s.id) && translations.get(s.id)!.target_lang !== currentTargetLang
  ).length;
  const showToolbar = showPostMeetingTranslation && (translations.size > 0 || autoTranslateEnabled);

  // Export
  const handleExport = useCallback(async () => {
    if (!meeting) return;
    await exportMeetingAsMarkdown(meeting);
  }, [meeting]);

  const handleTitleChanged = useCallback((title: string) => {
    setMeeting((prev) => (prev ? { ...prev, title } : prev));
  }, []);

  const handleBookmarksChanged = useCallback((bookmarks: MeetingBookmark[]) => {
    setMeeting((prev) => (prev ? { ...prev, bookmarks } : prev));
  }, []);

  // Name a remote speaker (`them:S1`): every line with that tag follows, and
  // the name is saved with the meeting (also used for its AI context).
  const handleRenameSpeaker = useCallback(async (speakerKey: string, name: string) => {
    try {
      if (!isDemoActive) await renameSpeaker(meetingId, speakerKey, name);
      setMeeting((prev) => (prev ? { ...prev, speakers: withSpeakerName(prev.speakers, speakerKey, name) } : prev));
    } catch (err) {
      console.error("[MeetingDetails] Failed to save the speaker name:", err);
      showToast(t("container.toast.speakerNameFailed"), "error");
    }
  }, [meetingId, isDemoActive, t]);

  const handleScrollHandled = useCallback(() => setScrollToSegmentIndex(null), []);

  const handleToggleTranslationVisibility = useCallback(() => setTranslationsVisible((v) => !v), []);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground">{t("container.loading")}</p>
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-xs text-red-400">{error || t("container.error.notFound")}</p>
        <button onClick={onBack} className="text-xs text-primary hover:underline cursor-pointer">{t("container.error.goBack")}</button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MeetingHeader
        meeting={meeting}
        stats={stats}
        onBack={onBack}
        onTitleChanged={handleTitleChanged}
      />

      <MeetingTabBar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        meeting={meeting}
        onGenerateSummary={() => {
          setActiveTab("summary");
          if (!summaryGeneration.isGenerating) {
            summaryGeneration.generate();
          }
        }}
        onExtractActions={() => {
          setActiveTab("actions");
          if (!actionExtraction.isExtracting) {
            actionExtraction.extract();
          }
        }}
        onSuggestBookmarks={() => {
          setActiveTab("bookmarks");
          if (!bookmarkSuggestions.isSuggesting) {
            bookmarkSuggestions.suggest();
          }
        }}
        isSummaryGenerating={summaryGeneration.isGenerating}
        isActionsExtracting={actionExtraction.isExtracting}
        isBookmarksSuggesting={bookmarkSuggestions.isSuggesting}
        showAsk={showAsk}
        aiLogCount={meeting.ai_interactions.length + chatExchanges.length}
      />

      <div className={`flex-1 min-h-0 ${activeTab === "transcript" || activeTab === "ask" ? "overflow-hidden flex flex-col" : "overflow-y-auto"}`} role="tabpanel">
        {/* Transcript stays mounted (hidden) so switching back is instant */}
        <div className={activeTab === "transcript" ? "flex flex-1 min-h-0 flex-col" : "hidden"}>
          <TranscriptView
            segments={meeting.transcript}
            mergedSegments={mergedSegments}
            isVisible={activeTab === "transcript"}
            search={search}
            meetingStartTime={new Date(meeting.start_time).getTime()}
            recordingOffsetMs={recordingInfo?.offset_ms ?? 0}
            speakers={meeting.speakers}
            searchInputRef={searchInputRef}
            bookmarks={meeting.bookmarks}
            meetingId={meeting.id}
            onBookmarksChanged={handleBookmarksChanged}
            onRenameSpeaker={handleRenameSpeaker}
            initialScrollToIndex={scrollToSegmentIndex}
            onScrollHandled={handleScrollHandled}
            translations={translations}
            translatingSegments={translatingSegments}
            translationDisplayMode={displayMode}
            currentTargetLang={currentTargetLang}
            showTranslations={translationsVisible}
            onTranslateSegment={handleTranslateSegment}
            onRetranslateSegment={handleRetranslateSegment}
            showToolbar={showToolbar}
            translatedCount={translatedCount}
            totalSegments={totalSegments}
            mismatchedCount={mismatchedCount}
            onDisplayModeChange={setDisplayMode}
            onRetranslateAll={handleRetranslateAll}
            onToggleTranslationVisibility={handleToggleTranslationVisibility}
            retranslating={retranslating}
          />
        </div>
        {activeTab === "summary" && (
          <SummaryView meeting={meeting} generation={summaryGeneration} onExport={handleExport} />
        )}
        {activeTab === "ask" && showAsk && (
          <AskMeetingTab
            chat={meetingChat}
            meetingId={meetingId}
            unavailableReason={
              meeting.transcript.length === 0 && !meeting.summary
                ? t("container.ask.noTranscript")
                : null
            }
          />
        )}
        {activeTab === "ai" && (
          <AIInteractionLog
            interactions={meeting.ai_interactions}
            chat={chatExchanges}
            expandedId={expandedInteraction}
            onToggle={(id) => setExpandedInteraction(expandedInteraction === id ? null : id)}
          />
        )}
        {activeTab === "speakers" && (
          <SpeakersTab
            meeting={meeting}
            onRename={handleRenameSpeaker}
            onSegmentClick={(idx) => {
              setScrollToSegmentIndex(idx);
              setActiveTab("transcript");
            }}
          />
        )}
        {activeTab === "actions" && (
          <ActionItemsTab
            meeting={meeting}
            extraction={actionExtraction}
            onItemsUpdated={(items) =>
              setMeeting((prev) => (prev ? { ...prev, action_items: items } : prev))
            }
          />
        )}
        {activeTab === "bookmarks" && (
          <BookmarksTab
            meeting={meeting}
            onBookmarkUpdated={(bookmarks) =>
              setMeeting((prev) => (prev ? { ...prev, bookmarks } : prev))
            }
            onNavigateToBookmark={(bookmark) => {
              const startMs = Date.parse(meeting.start_time);
              const segment = meeting.transcript.find((line) => line.id === bookmark.segment_id)
                ?? findNearestSegment(meeting.transcript, toElapsedMs(bookmark.timestamp_ms, startMs), startMs);
              const idx = segment ? meeting.transcript.indexOf(segment) : -1;
              setScrollToSegmentIndex(idx >= 0 ? idx : null);
              setActiveTab("transcript");
            }}
            suggestions={bookmarkSuggestions}
          />
        )}
      </div>

      {/* Audio Player — sticky bottom bar */}
      {recordingInfo && (
        <AudioPlayer
          meetingId={meeting.id}
          meetingStartMs={new Date(meeting.start_time).getTime()}
          recordingPath={recordingInfo.path}
          recordingSize={recordingInfo.size_bytes}
          recordingOffsetMs={recordingInfo.offset_ms}
          durationMs={recordingInfo.duration_ms}
          waveformData={recordingInfo.waveform_data ?? null}
          bookmarks={meeting.bookmarks}
          topicSections={meeting.topic_sections}
        />
      )}
    </div>
  );
}
