import { useState, useEffect, useRef, useCallback } from "react";
import type { ParseKeys } from "i18next";
import { useRagStore } from "../stores/ragStore";
import { useLlmConfig } from "../stores/llmConnectionsStore";
import { effectiveRoute } from "../lib/llm/tasks";
import { cancelGeneration, testRagAnswer } from "../lib/ipc";
import { onStreamStart, onStreamToken, onStreamEnd, onStreamError } from "../lib/events";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { AnswerMarkdown } from "../components/AnswerMarkdown";
import { answerMd, STREAMING_ANSWER_SPACING } from "../launcher/meeting-details/AskMeetingTab";
import { stripThinkTags } from "../launcher/meeting-details/SummaryView";
import {
  X,
  Search,
  Loader2,
  FlaskConical,
  Clock,
  Hash,
  FileText,
  BarChart3,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Bot,
  MessageSquare,
  Zap,
  AlertCircle,
  ArrowDownUp,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useT } from "../i18n";

type RagKey = ParseKeys<"rag">;

interface TestSearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// The chip label is translated; the query goes to the search and the model as
// written, so it stays as is.
// Example questions typed into the search box: in the UI language, so they
// match documents written in it.
const QUERY_TEMPLATES: { labelKey: RagKey; queryKey: RagKey }[] = [
  { labelKey: "context.testSearch.templates.background", queryKey: "context.testSearch.templateQueries.background" },
  { labelKey: "context.testSearch.templates.experience", queryKey: "context.testSearch.templateQueries.experience" },
  { labelKey: "context.testSearch.templates.skills", queryKey: "context.testSearch.templateQueries.skills" },
  { labelKey: "context.testSearch.templates.strengths", queryKey: "context.testSearch.templateQueries.strengths" },
  { labelKey: "context.testSearch.templates.summary", queryKey: "context.testSearch.templateQueries.summary" },
];

/** The backend's search modes (src-tauri/src/rag/config.rs), shown translated. */
const SEARCH_MODE_KEYS = new Map<string, RagKey>([
  ["hybrid", "context.testSearch.searchModes.hybrid"],
  ["semantic", "context.testSearch.searchModes.semantic"],
  ["keyword", "context.testSearch.searchModes.keyword"],
]);

export function TestSearchDialog({ isOpen, onClose }: TestSearchDialogProps) {
  return isOpen ? <OpenTestSearchDialog onClose={onClose} /> : null;
}

function OpenTestSearchDialog({ onClose }: Pick<TestSearchDialogProps, "onClose">) {
  const { t } = useT(["rag", "common"]);
  const testSearchResults = useRagStore((s) => s.testSearchResults);
  const rerankReport = useRagStore((s) => s.testSearchRerank);
  const rewrite = useRagStore((s) => s.testSearchRewrite);
  const rerankConfig = useRagStore((s) => s.settings?.config.rerank);
  const settingsLoaded = useRagStore((s) => s.settings !== null);
  const loadSettings = useRagStore((s) => s.loadSettings);
  const isSearching = useRagStore((s) => s.isSearching);
  const searchLatencyMs = useRagStore((s) => s.searchLatencyMs);
  const testSearch = useRagStore((s) => s.testSearch);
  const resetTestSearch = useRagStore((s) => s.resetTestSearch);
  const ragConfig = useRagStore((s) => s.ragConfig);
  const indexStatus = useRagStore((s) => s.indexStatus);
  const error = useRagStore((s) => s.error);
  const { view: llmConfig } = useLlmConfig();
  const route = llmConfig ? effectiveRoute(llmConfig, "rag_answer") : null;
  const llmModel = route && !route.error ? route.model ?? route.connection_name : null;

  const [query, setQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedChunk, setExpandedChunk] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // AI response state
  const [aiResponse, setAiResponse] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiModel, setAiModel] = useState("");
  const [aiProvider, setAiProvider] = useState("");
  const [aiLatencyMs, setAiLatencyMs] = useState<number | null>(null);
  const [aiTotalTokens, setAiTotalTokens] = useState<number | null>(null);
  const activeTest = useRef<{ id: string; answerStarted: boolean } | null>(null);
  const listenersReady = useRef<Promise<UnlistenFn[]> | null>(null);

  const backdropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const aiResponseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    resetTestSearch();
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [resetTestSearch]);

  // The rerank chip needs the knowledge base settings (the launcher doesn't load them).
  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  const cancelTest = useCallback(() => {
    const test = activeTest.current;
    activeTest.current = null;
    resetTestSearch();
    if (test?.answerStarted) void cancelGeneration(test.id).catch(() => {});
  }, [resetTestSearch]);

  const close = useCallback(() => {
    cancelTest();
    onClose();
  }, [cancelTest, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  useEffect(() => {
    const isOurs = (id: string | null) => activeTest.current?.id === id;
    const subscriptions = [
      onStreamStart((event) => {
        if (event.mode !== "RagTest" || !isOurs(event.request_id)) return;
        setAiModel(event.model);
        setAiProvider(event.provider);
        requestAnimationFrame(() => {
          if (isOurs(event.request_id)) aiResponseRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        });
      }),
      onStreamToken((event) => {
        if (!isOurs(event.request_id)) return;
        setAiResponse((prev) => prev + event.token);
      }),
      onStreamEnd((event) => {
        if (!isOurs(event.request_id)) return;
        activeTest.current = null;
        setIsGenerating(false);
        setAiLatencyMs(event.latency_ms);
        setAiTotalTokens(event.total_tokens);
      }),
      onStreamError((event) => {
        if (!isOurs(event.request_id)) return;
        activeTest.current = null;
        setIsGenerating(false);
        setAiError(event.message);
      }),
    ];
    const ready = Promise.all(subscriptions);
    listenersReady.current = ready;
    void ready.catch(() => {}); // The submit path reports listener registration errors.

    return () => {
      listenersReady.current = null;
      cancelTest();
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, [cancelTest]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) close();
    },
    [close]
  );

  const handleFullTest = useCallback(async (q: string) => {
    const trimmed = q.trim();
    const ready = listenersReady.current;
    if (!trimmed || activeTest.current || !ready) return;
    const test = { id: crypto.randomUUID(), answerStarted: false };
    activeTest.current = test;
    setHasSearched(true);
    setAiResponse("");
    setAiError(null);
    setAiLatencyMs(null);
    setAiTotalTokens(null);
    setAiModel("");
    setAiProvider("");

    try {
      const foundChunks = await testSearch(trimmed);
      if (activeTest.current !== test) return;
      if (!foundChunks) {
        activeTest.current = null;
        return;
      }
      setIsGenerating(true);
      await ready;
      if (activeTest.current !== test) return;
      test.answerStarted = true;
      await testRagAnswer(trimmed, test.id);
    } catch (e) {
      if (activeTest.current !== test) return;
      activeTest.current = null;
      setIsGenerating(false);
      setAiError(e instanceof Error ? e.message : String(e));
    }
  }, [testSearch]);

  const handleSearch = useCallback(() => {
    handleFullTest(query);
  }, [query, handleFullTest]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSearch();
    },
    [handleSearch]
  );

  const handleTemplate = useCallback(
    (templateQuery: string) => {
      setQuery(templateQuery);
      handleFullTest(templateQuery);
    },
    [handleFullTest]
  );

  const handleCopyChunk = useCallback((chunkId: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(chunkId);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const handleCopyResponse = useCallback(() => {
    navigator.clipboard.writeText(stripThinkTags(aiResponse));
    setCopiedId("ai-response");
    setTimeout(() => setCopiedId(null), 1500);
  }, [aiResponse]);

  const totalResultTokens = testSearchResults.reduce(
    (sum, r) => sum + Math.ceil(r.text.split(/\s+/).length * 1.3),
    0
  );
  const isBusy = isSearching || isGenerating;
  const searchMode = ragConfig?.search_mode ?? "hybrid";
  const searchModeKey = SEARCH_MODE_KEYS.get(searchMode);
  const searchModeLabel = searchModeKey ? t(searchModeKey) : searchMode;
  const answerText = stripThinkTags(aiResponse);

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      {/* Most of the window, so long (Chinese) answers have room; a fixed
          height keeps it from jumping while the answer streams in. */}
      <div className="flex h-[min(900px,calc(100vh_-_3rem))] w-[min(1000px,calc(100vw_-_3rem))] flex-col rounded-2xl border border-border/50 bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/30 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <FlaskConical className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t("context.testSearch.title")}</h2>
              <p className="text-meta text-muted-foreground">
                {t("context.testSearch.subtitle")}
              </p>
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            title={t("context.testSearch.close.title")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Config summary bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/20 bg-accent/10 px-6 py-2 text-meta text-muted-foreground">
          <span className="flex items-center gap-1" title={t("context.testSearch.config.searchModel.title")}>
            <Sparkles className="h-3 w-3" />
            {ragConfig?.embedding_model ?? "nomic-embed-text"}
          </span>
          <span className="flex items-center gap-1">
            <Hash className="h-3 w-3" />
            {t("context.testSearch.config.topK", { k: ragConfig?.top_k ?? 5 })}
          </span>
          <span className="flex items-center gap-1">
            <BarChart3 className="h-3 w-3" />
            {searchModeLabel}
          </span>
          {rerankConfig?.enabled && (
            <span className="flex items-center gap-1" title={t("context.testSearch.rerank.chipTitle")}>
              <ArrowDownUp className="h-3 w-3" />
              {rerankConfig.model
                ? t("context.testSearch.rerank.chip", { model: rerankConfig.model })
                : t("context.testSearch.rerank.chipOn")}
            </span>
          )}
          <span className="flex items-center gap-1" title={t("context.testSearch.config.llmModel.title")}>
            <Bot className="h-3 w-3" />
            {llmModel || t("context.testSearch.config.llmModel.none")}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {t("context.testSearch.config.chunks", { count: indexStatus?.total_chunks ?? 0 })}
          </span>
        </div>

        {/* Quick templates */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/20 px-6 py-2.5">
          <span className="text-meta font-medium text-muted-foreground/60 mr-1">
            {t("context.testSearch.templates.prompt")}
          </span>
          {QUERY_TEMPLATES.map((template) => (
            <button
              key={template.labelKey}
              onClick={() => handleTemplate(t(template.queryKey))}
              disabled={isBusy}
              className="rounded-full border border-border/30 bg-background px-2.5 py-1 text-meta font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {t(template.labelKey)}
            </button>
          ))}
        </div>

        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border/20 px-6 py-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("context.testSearch.input.placeholder")}
            className="flex-1 rounded-lg border border-border/50 bg-background px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <button
            onClick={handleSearch}
            disabled={isBusy || !query.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            {isSearching
              ? t("context.testSearch.askButton.searching")
              : isGenerating
                ? t("context.testSearch.askButton.generating")
                : t("context.testSearch.askButton.label")}
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
          {/* Error state */}
          {(error || aiError) && hasSearched && !isBusy && (
            <div className="mx-6 mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                <p className="text-xs font-medium text-red-400">{t("common:status.error")}</p>
              </div>
              <p className="text-xs text-red-400/70">{aiError || error}</p>
            </div>
          )}

          {/* Empty state — not yet searched */}
          {testSearchResults.length === 0 && !isBusy && !hasSearched && !error && !aiError && (
            <div className="flex h-full flex-col items-center justify-center py-12 text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-xs text-muted-foreground/60">
                {t("context.testSearch.empty.hint")}
              </p>
            </div>
          )}

          {/* Loading — searching */}
          {isSearching && (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="h-4 w-4 animate-spin text-primary/60" />
              <span className="text-xs text-muted-foreground">{t("context.testSearch.searching")}</span>
            </div>
          )}

          {/* AI Response */}
          {(aiResponse || isGenerating) && !isSearching && (
            <div className="mx-6 mt-4" ref={aiResponseRef}>
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-primary" />
                    <span className="text-xs font-semibold text-foreground">{t("context.testSearch.answer.title")}</span>
                    {isGenerating && (
                      <Loader2 className="h-3 w-3 animate-spin text-primary/60" />
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-meta text-muted-foreground">
                    {aiModel && (
                      <span className="flex items-center gap-1">
                        <Bot className="h-3 w-3" />
                        {aiProvider}/{aiModel}
                      </span>
                    )}
                    {aiLatencyMs != null && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {aiLatencyMs}ms
                      </span>
                    )}
                    {aiTotalTokens != null && (
                      <span>{t("context.testSearch.answer.tokens", { count: aiTotalTokens })}</span>
                    )}
                    {aiResponse && (
                      <button
                        onClick={handleCopyResponse}
                        className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
                        title={t("context.testSearch.answer.copy.title")}
                      >
                        {copiedId === "ai-response" ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
                {answerText ? (
                  <div className={isGenerating ? `select-text text-sm ${STREAMING_ANSWER_SPACING}` : "select-text text-sm"}>
                    <AnswerMarkdown content={answerText} streaming={isGenerating} components={answerMd} />
                    {isGenerating && <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary/60 align-middle" />}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("context.testSearch.answer.thinking")}</p>
                )}
              </div>
            </div>
          )}

          {/* No results found after search */}
          {testSearchResults.length === 0 && !isBusy && hasSearched && !error && !aiError && !aiResponse && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Search className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {t("context.testSearch.noResults.title")}
              </p>
              <p className="text-xs text-muted-foreground/50">
                {t("context.testSearch.noResults.hint")}
              </p>
            </div>
          )}

          {/* Chunk results */}
          {testSearchResults.length > 0 && !isSearching && (
            <div className="px-6 py-4 space-y-3">
              {/* Stats bar */}
              <div className="flex items-center gap-4 rounded-lg bg-accent/20 px-3 py-2 text-meta text-muted-foreground">
                <span className="flex items-center gap-1 font-medium text-foreground">
                  <Search className="h-3 w-3" />
                  {t("context.testSearch.results.retrieved", { count: testSearchResults.length })}
                </span>
                {searchLatencyMs != null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {searchLatencyMs}ms
                  </span>
                )}
                <span>{t("context.testSearch.results.tokens", { count: Math.round(totalResultTokens) })}</span>
                {rerankReport && (
                  <span
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                      rerankReport.status === "applied" ? "bg-primary/10 text-primary" : "bg-amber-500/10 text-amber-500"
                    }`}
                  >
                    <ArrowDownUp className="h-3 w-3" />
                    {rerankReport.status === "applied"
                      ? t("context.testSearch.rerank.applied", { count: rerankReport.candidates, ms: rerankReport.latency_ms })
                      : t(`context.testSearch.rerank.${rerankReport.status}`)}
                  </span>
                )}
                <span className="ml-auto">
                  {searchModeLabel}
                </span>
              </div>
              {rewrite && (
                <p
                  className={`select-text break-words rounded-lg px-3 py-2 text-meta ${
                    rewrite.report.status === "applied"
                      ? "bg-accent/20 text-muted-foreground"
                      : "border border-amber-500/20 bg-amber-500/5 text-amber-600 dark:text-amber-400"
                  }`}
                  title={rewrite.report.error ?? undefined}
                >
                  {rewrite.report.status === "applied"
                    ? t("context.testSearch.rewrite.queries", { queries: rewrite.queries.join(" · ") })
                    : t(`context.testSearch.rewrite.${rewrite.report.status}`)}
                </p>
              )}
              {rerankReport && rerankReport.status !== "applied" && rerankReport.error && (
                <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-meta text-amber-600 dark:text-amber-400">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="select-text break-words">{rerankReport.error}</span>
                </p>
              )}

              {/* Chunk cards */}
              {testSearchResults.map((result, idx) => {
                const isExpanded = expandedChunk === result.chunk_id;
                const estimatedTokens = Math.ceil(result.text.split(/\s+/).length * 1.3);
                // Places gained (> 0) or lost (< 0) by reranking.
                const fusedRank = result.fused_rank ?? null;
                const moved = fusedRank === null ? 0 : fusedRank - (idx + 1);

                return (
                  <div
                    key={result.chunk_id}
                    className="rounded-xl border border-border/40 bg-secondary/20 transition-colors hover:bg-secondary/30"
                  >
                    <div
                      className="flex items-center gap-2 px-4 py-2.5 cursor-pointer"
                      onClick={() => setExpandedChunk(isExpanded ? null : result.chunk_id)}
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        {idx + 1}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-xs font-medium text-foreground truncate">
                          {result.source_file}
                        </span>
                        {result.heading && (
                          <span className="text-meta text-muted-foreground/70 truncate" title={result.heading}>
                            {result.heading}
                          </span>
                        )}
                      </span>
                      {result.source_type === "summary" ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-meta text-primary">
                          {t("context.testSearch.results.summary")}
                        </span>
                      ) : (
                        <span className="text-meta text-muted-foreground/60">
                          {result.chunk_range ? `#${result.chunk_range[0]}–${result.chunk_range[1]}` : `#${result.chunk_index}`}
                        </span>
                      )}
                      <span className="text-meta text-muted-foreground/60">
                        {t("context.testSearch.results.chunkTokens", { count: estimatedTokens })}
                      </span>
                      {fusedRank !== null && (
                        <span
                          className={`flex items-center gap-0.5 text-meta ${moved > 0 ? "text-emerald-500" : "text-muted-foreground/60"}`}
                          title={t("context.testSearch.rerank.wasTitle", { score: result.fused_score?.toFixed(4) ?? "" })}
                        >
                          {moved > 0 && <ArrowUp className="h-3 w-3" />}
                          {moved < 0 && <ArrowDown className="h-3 w-3" />}
                          {t("context.testSearch.rerank.was", { rank: fusedRank })}
                        </span>
                      )}
                      <span
                        title={fusedRank !== null ? t("context.testSearch.rerank.scoreTitle") : undefined}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${
                        result.score >= 0.7
                          ? "bg-emerald-500/10 text-emerald-500"
                          : result.score >= 0.4
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-red-500/10 text-red-400"
                      }`}>
                        {fusedRank !== null && <ArrowDownUp className="h-3 w-3" />}
                        {result.score.toFixed(3)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyChunk(result.chunk_id, result.text);
                        }}
                        className="rounded-lg p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                        title={t("context.testSearch.results.copyChunk.title")}
                      >
                        {copiedId === result.chunk_id ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
                      )}
                    </div>

                    <div className="border-t border-border/20 px-4 py-3">
                      <p className={`text-xs text-muted-foreground/80 leading-relaxed whitespace-pre-wrap ${
                        isExpanded ? "" : "line-clamp-3"
                      }`}>
                        {result.text}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
