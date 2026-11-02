import { useState, useEffect, useRef, useCallback } from "react";
import type { ParseKeys } from "i18next";
import { useRagStore } from "../stores/ragStore";
import { useConfigStore } from "../stores/configStore";
import { testRagAnswer } from "../lib/ipc";
import { onStreamStart, onStreamToken, onStreamEnd, onStreamError } from "../lib/events";
import type { UnlistenFn } from "@tauri-apps/api/event";
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
  const { t } = useT(["rag", "common"]);
  const testSearchResults = useRagStore((s) => s.testSearchResults);
  const rerankReport = useRagStore((s) => s.testSearchRerank);
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
  const llmModel = useConfigStore((s) => s.llmModel);
  const llmProvider = useConfigStore((s) => s.llmProvider);

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
  const aiStartTime = useRef<number>(0);
  // request_id of the test answer being streamed — ignore every other stream
  const requestIdRef = useRef<string | null>(null);

  const backdropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const aiResponseRef = useRef<HTMLDivElement>(null);

  // Reset all state when the dialog opens so stale results never persist
  useEffect(() => {
    if (isOpen) {
      resetTestSearch();
      setHasSearched(false);
      setAiResponse("");
      setAiError(null);
      setAiLatencyMs(null);
      setAiTotalTokens(null);
      setAiModel("");
      setAiProvider("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, resetTestSearch]);

  // The rerank chip needs the knowledge base settings (the launcher doesn't load them).
  useEffect(() => {
    if (isOpen && !settingsLoaded) void loadSettings();
  }, [isOpen, settingsLoaded, loadSettings]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Subscribe to LLM stream events when generating
  useEffect(() => {
    if (!isGenerating) return;

    let unlistenStart: UnlistenFn | null = null;
    let unlistenToken: UnlistenFn | null = null;
    let unlistenEnd: UnlistenFn | null = null;
    let unlistenError: UnlistenFn | null = null;
    let mounted = true;

    const setup = async () => {
      const isOurs = (id: string | null) =>
        mounted && requestIdRef.current !== null && id === requestIdRef.current;

      unlistenStart = await onStreamStart((event) => {
        if (!isOurs(event.request_id)) return;
        setAiModel(event.model);
        setAiProvider(event.provider);
        // Scroll to AI response box so user sees the answer, not the chunk list
        setTimeout(() => {
          aiResponseRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 50);
      });
      unlistenToken = await onStreamToken((event) => {
        if (!isOurs(event.request_id)) return;
        setAiResponse((prev) => prev + event.token);
      });
      unlistenEnd = await onStreamEnd((event) => {
        if (!isOurs(event.request_id)) return;
        setIsGenerating(false);
        setAiLatencyMs(event.latency_ms);
        setAiTotalTokens(event.total_tokens);
      });
      unlistenError = await onStreamError((event) => {
        if (!isOurs(event.request_id)) return;
        setIsGenerating(false);
        setAiError(event.message);
      });
    };

    setup();

    return () => {
      mounted = false;
      if (unlistenStart) unlistenStart();
      if (unlistenToken) unlistenToken();
      if (unlistenEnd) unlistenEnd();
      if (unlistenError) unlistenError();
    };
  }, [isGenerating]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose]
  );

  const handleFullTest = useCallback(async (q: string) => {
    if (!q.trim()) return;
    const trimmed = q.trim();
    setHasSearched(true);
    setAiResponse("");
    setAiError(null);
    setAiLatencyMs(null);
    setAiTotalTokens(null);
    setAiModel("");
    setAiProvider("");

    // Step 1: RAG search for chunks
    await testSearch(trimmed);

    // Step 2: Call LLM with RAG context (uses streaming events)
    // Pass the frontend's LLM settings so the backend uses the correct provider/model
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    setIsGenerating(true);
    aiStartTime.current = performance.now();
    try {
      await testRagAnswer(trimmed, llmProvider, llmModel, requestId);
    } catch (e) {
      setIsGenerating(false);
      setAiError(e instanceof Error ? e.message : String(e));
    }
  }, [testSearch]);

  const handleSearch = useCallback(() => {
    handleFullTest(query);
  }, [query, handleFullTest]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSearch();
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
    navigator.clipboard.writeText(aiResponse);
    setCopiedId("ai-response");
    setTimeout(() => setCopiedId(null), 1500);
  }, [aiResponse]);

  if (!isOpen) return null;

  const totalResultTokens = testSearchResults.reduce(
    (sum, r) => sum + Math.ceil(r.text.split(/\s+/).length * 1.3),
    0
  );
  const isBusy = isSearching || isGenerating;
  const searchMode = ragConfig?.search_mode ?? "hybrid";
  const searchModeKey = SEARCH_MODE_KEYS.get(searchMode);
  const searchModeLabel = searchModeKey ? t(searchModeKey) : searchMode;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-[680px] max-h-[85vh] flex flex-col rounded-2xl border border-border/50 bg-card shadow-2xl">
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
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            title={t("context.testSearch.close.title")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Config summary bar */}
        <div className="flex items-center gap-4 border-b border-border/20 bg-accent/10 px-6 py-2 text-meta text-muted-foreground">
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
        <div className="flex items-center gap-1.5 border-b border-border/20 px-6 py-2.5">
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
            <div className="flex flex-col items-center justify-center py-12 text-center">
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
                <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">
                  {aiResponse || t("context.testSearch.answer.thinking")}
                  {isGenerating && <span className="animate-pulse">|</span>}
                </p>
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
                      <span className="text-xs font-medium text-foreground truncate flex-1">
                        {result.source_file}
                      </span>
                      <span className="text-meta text-muted-foreground/60">
                        #{result.chunk_index}
                      </span>
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
