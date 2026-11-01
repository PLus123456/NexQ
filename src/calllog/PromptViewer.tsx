import { useState, useCallback, useMemo } from "react";
import type { TFunction } from "i18next";
import { Trans, formatNumber, useT } from "../i18n";
import { showToast } from "../stores/toastStore";
import { formatActualUsage } from "./stats";
import type { LogEntry } from "../lib/types";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  FileText,
  MessageSquare,
  HelpCircle,
  Sparkles,
  BookOpen,
  Search,
  Database,
} from "lucide-react";

// -- Types -------------------------------------------------------------------

interface PromptSection {
  title: string;
  content: string;
  type: "context" | "transcript" | "question" | "instruction";
  badge?: { label: string; color: string; icon: typeof FileText };
}

type ViewMode = "structured" | "raw";

/** `t` of `useT("calllog")`, handed to the plain functions that build the badges. */
type CallLogT = TFunction<"calllog">;

// -- Main component ----------------------------------------------------------

interface PromptViewerProps {
  entry: LogEntry;
}

export function PromptViewer({ entry }: PromptViewerProps) {
  const { t } = useT("calllog");
  const [viewMode, setViewMode] = useState<ViewMode>("structured");

  return (
    <div className="flex flex-col h-full">
      {/* View mode toggle */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/20">
        <button
          onClick={() => setViewMode("structured")}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            viewMode === "structured"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          {t("prompt.view.structured")}
        </button>
        <button
          onClick={() => setViewMode("raw")}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            viewMode === "raw"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          {t("prompt.view.raw")}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {viewMode === "structured" ? (
          <StructuredView entry={entry} />
        ) : (
          <RawView entry={entry} />
        )}
      </div>
    </div>
  );
}

// -- Token Budget ------------------------------------------------------------

/** Rough token count of text (~4 characters per token). */
const estimateTokens = (text: string) => Math.ceil((text || "").length / 4);

function TokenBudget({ entry }: { entry: LogEntry }) {
  const { t } = useT("calllog");
  const actual = entry.usage ? (
    <div data-testid="token-actual">
      <span className="font-medium">{t("prompt.tokens.actual")}</span>{" "}
      <span className="tabular-nums text-foreground/70">{formatActualUsage(entry.usage)}</span>
    </div>
  ) : null;

  const scope = entry.scopeLabel ? (
    <div data-testid="token-scope">
      <span className="font-medium">{t("prompt.tokens.scope")}</span> <span className="text-foreground/70">{entry.scopeLabel}</span>
    </div>
  ) : null;

  // A session keeps its system prompt: it was sent once, when the session started.
  if (entry.sessionKey) {
    return (
      <div
        className="space-y-0.5 px-3 py-1.5 border-b border-border/20 text-meta text-muted-foreground/60"
        data-testid="token-budget"
      >
        <div>
          <Trans
            t={t}
            i18nKey="prompt.tokens.sessionPrompt"
            components={{ strong: <span className="font-medium" /> }}
          />{" "}
          <span className="tabular-nums">≈ {formatNumber(estimateTokens(entry.actualSystemPrompt))}</span>
        </div>
        <div>
          <span className="font-medium">{t("prompt.tokens.sentThisRequest")}</span>{" "}
          <span className="tabular-nums">≈ {formatNumber(estimateTokens(entry.actualUserPrompt))}</span>
        </div>
        {scope}
        {actual}
      </div>
    );
  }

  const system = estimateTokens(entry.actualSystemPrompt);
  const userTotal = estimateTokens(entry.actualUserPrompt);
  const rag = entry.ragChunks?.reduce((sum, c) => sum + estimateTokens(c.text), 0) ?? 0;
  const total = system + userTotal;

  const items = [
    { label: t("prompt.tokens.system"), tokens: system, color: "text-muted-foreground" },
    { label: t("prompt.tokens.transcript"), tokens: Math.max(0, userTotal - rag), color: "text-success" },
    { label: t("prompt.tokens.rag"), tokens: rag, color: "text-info" },
  ].filter((i) => i.tokens > 0);

  return (
    <div className="space-y-0.5 px-3 py-1.5 border-b border-border/20 text-meta text-muted-foreground/60" data-testid="token-budget">
      <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
        <span className="font-medium">{t("prompt.tokens.label")}</span>
        {items.map((item, i) => (
          <span key={item.label}>
            {i > 0 && <span className="mx-0.5">&middot;</span>}{/* i18n-ignore: 分隔符号 */}
            <span className={item.color}>{item.label}</span>{" "}
            <span className="tabular-nums">{formatNumber(item.tokens)}</span>
          </span>
        ))}
        <span className="mx-0.5">&rarr;</span>{/* i18n-ignore: 箭头符号 */}
        <span className="font-semibold tabular-nums">~{formatNumber(total)}</span>
        <span>{t("prompt.tokens.estimate")}</span>
      </div>
      {scope}
      {actual}
    </div>
  );
}

// -- RAG Chunks Section ------------------------------------------------------

function RagChunksSection({ entry }: { entry: LogEntry }) {
  const { t } = useT("calllog");
  const [expanded, setExpanded] = useState(false);
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set());

  if (!entry.includeRag) return null;

  const chunks = entry.ragChunks ?? [];
  const filtered = entry.ragChunksFiltered ?? 0;
  const query = entry.ragQuery;
  const hasChunks = chunks.length > 0;

  const toggleChunk = (idx: number) => {
    setExpandedChunks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const allText = chunks.map((c) =>
    `[${c.source}, chunk ${c.chunk_index}] (score: ${c.normalized_score.toFixed(2)})\n${c.text}` // i18n-ignore: 复制到剪贴板的日志数据格式，不随界面语言变化
  ).join("\n---\n");

  return (
    <div className="border-b border-border/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/20 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-meta font-medium bg-info/10 text-info border-info/20">
          <Database className="h-2.5 w-2.5" />
          {hasChunks ? t("prompt.badge.chunks", { count: chunks.length }) : t("prompt.rag.noRelevantBadge")}
        </span>
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          {t("prompt.rag.title")}
        </span>
        <SectionCopyButton text={allText} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {query && (
            <div className="flex items-start gap-1.5 rounded-md bg-secondary/20 px-2.5 py-1.5 mb-2">
              <Search className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/50" />
              <p className="text-meta text-muted-foreground/60 break-words">
                <span className="font-medium">{t("prompt.rag.query")}</span> {query.length > 200 ? query.slice(0, 200) + "..." : query}
              </p>
            </div>
          )}

          {hasChunks ? (
            <>
              {chunks.map((chunk, idx) => (
                <button
                  key={idx}
                  onClick={() => toggleChunk(idx)}
                  className="flex w-full items-start gap-2 rounded-md bg-secondary/20 px-2.5 py-1.5 text-left hover:bg-secondary/30 transition-colors"
                >
                  {expandedChunks.has(idx) ? (
                    <ChevronDown className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/60" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/60" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-meta font-semibold text-info/80">#{idx + 1}</span>
                      <span className="text-meta text-muted-foreground truncate">
                        {t("prompt.rag.chunkRef", { source: chunk.source, index: chunk.chunk_index })}
                      </span>
                      <span className="text-meta font-mono tabular-nums text-info/70">{chunk.normalized_score.toFixed(2)}</span>
                    </div>
                    {expandedChunks.has(idx) ? (
                      <p className="mt-1 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                        {chunk.text}
                      </p>
                    ) : (
                      <p className="text-meta text-muted-foreground/50 truncate">
                        {chunk.text.slice(0, 80)}...
                      </p>
                    )}
                  </div>
                </button>
              ))}
              {filtered > 0 && (
                <p className="text-meta text-muted-foreground/50 px-2.5 py-1">
                  {t("prompt.rag.filtered", { count: filtered })}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-md bg-secondary/20 px-2.5 py-2 text-meta text-muted-foreground/50">
              {t("prompt.rag.noneFound")}
              {filtered > 0 && <span> {t("prompt.rag.noneFoundDetail", { count: filtered })}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -- Structured View ---------------------------------------------------------

function StructuredView({ entry }: { entry: LogEntry }) {
  const { t } = useT("calllog");
  const sections = useMemo(
    () => parseUserPromptSections(entry.actualUserPrompt, t),
    [entry.actualUserPrompt, t]
  );

  // Filter out RAG sections — we render them via RagChunksSection instead
  const nonRagSections = sections.filter(
    (s) => s.type !== "context" || (!s.title.includes("Relevant Context") && !s.title.includes("RAG") && !s.title.includes("Reference")) // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
  );

  return (
    <div className="flex flex-col gap-0.5">
      <TokenBudget entry={entry} />

      {entry.actualSystemPrompt && (
        <CollapsibleSection
          title={t("prompt.section.systemPrompt")}
          content={entry.actualSystemPrompt}
          defaultExpanded={false}
          badge={{ label: t("prompt.badge.system"), color: "gray", icon: Sparkles }}
        />
      )}

      {nonRagSections.map((section, i) => (
        <CollapsibleSection
          key={i}
          title={section.title || t("prompt.section.userMessage")}
          content={section.content}
          defaultExpanded={true}
          badge={section.badge}
        />
      ))}

      <RagChunksSection entry={entry} />

      {(entry.responseContentClean || entry.status === "streaming") && (
        <CollapsibleSection
          title={
            entry.status === "streaming" ? t("prompt.section.responseStreaming") : t("prompt.section.response")
          }
          content={entry.responseContentClean}
          defaultExpanded={true}
          badge={{ label: t("prompt.badge.response"), color: "emerald", icon: MessageSquare }}
          isResponse
        />
      )}
    </div>
  );
}

// -- Collapsible Section -----------------------------------------------------

function CollapsibleSection({
  title,
  content,
  defaultExpanded,
  badge,
  isResponse,
}: {
  title: string;
  content: string;
  defaultExpanded: boolean;
  badge?: PromptSection["badge"];
  isResponse?: boolean;
}) {
  const { t } = useT("calllog");
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!content && !isResponse) return null;

  const badgeColors: Record<string, string> = {
    amber: "bg-warning/10 text-warning border-warning/20",
    blue: "bg-info/10 text-info border-info/20",
    green: "bg-success/10 text-success border-success/20",
    rose: "bg-destructive/10 text-destructive border-destructive/20",
    gray: "bg-secondary/60 text-muted-foreground/70 border-border/20",
    emerald: "bg-success/10 text-success border-success/20",
  };

  const badgeClass = badge ? badgeColors[badge.color] || badgeColors.gray : "";
  const Icon = badge?.icon || FileText;

  return (
    <div className="border-b border-border/20">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/20 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}

        {badge && (
          <span
            className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-meta font-medium ${badgeClass}`}
          >
            <Icon className="h-2.5 w-2.5" />
            {badge.label}
          </span>
        )}

        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          {title}
        </span>

        <SectionCopyButton text={content} />
      </button>

      {/* Content */}
      {expanded ? (
        <div className="px-3 pb-3">
          <div
            className={`max-h-60 overflow-y-auto rounded-md bg-secondary/20 p-2.5 ${
              isResponse
                ? "text-sm leading-relaxed text-foreground/90"
                : "font-mono text-xs leading-relaxed text-foreground/80"
            } whitespace-pre-wrap break-words`}
          >
            {content || (
              <span className="italic text-muted-foreground/60">
                {t("prompt.empty")}
              </span>
            )}
          </div>
        </div>
      ) : content ? (
        /* Collapsed preview: 3-line fade */
        <div className="relative px-3 pb-2">
          <p className="line-clamp-3 font-mono text-xs text-muted-foreground/50 break-words">
            {content}
          </p>
          <div className="absolute bottom-0 left-3 right-3 h-6 bg-gradient-to-t from-card to-transparent pointer-events-none" />
        </div>
      ) : null}
    </div>
  );
}

// -- Raw View ----------------------------------------------------------------

function RawView({ entry }: { entry: LogEntry }) {
  const { t } = useT("calllog");
  return (
    <div className="flex flex-col gap-3 p-3">
      {/* System message */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("prompt.raw.systemMessage")}
          </span>
          <SectionCopyButton text={entry.actualSystemPrompt} />
        </div>
        <pre className="max-h-60 overflow-y-auto rounded-md bg-secondary/20 p-2.5 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
          {entry.actualSystemPrompt || t("prompt.empty")}
        </pre>
      </div>

      {/* User message */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("prompt.raw.userMessage")}
          </span>
          <SectionCopyButton text={entry.actualUserPrompt} />
        </div>
        <pre className="max-h-80 overflow-y-auto rounded-md bg-secondary/20 p-2.5 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
          {entry.actualUserPrompt || t("prompt.empty")}
        </pre>
      </div>

      {/* Response */}
      {entry.responseContentClean && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t("prompt.raw.response")}
              {entry.status === "streaming" && (
                <span className="ml-1.5 animate-pulse text-primary/60">
                  {t("prompt.raw.streaming")}
                </span>
              )}
            </span>
            <SectionCopyButton text={entry.responseContentClean} />
          </div>
          <pre className="max-h-60 overflow-y-auto rounded-md bg-secondary/20 p-2.5 font-mono text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
            {entry.responseContentClean}
          </pre>
        </div>
      )}
    </div>
  );
}

// -- Prompt section parser ---------------------------------------------------

function parseUserPromptSections(text: string, t: CallLogT): PromptSection[] {
  if (!text) return [];

  const sections: PromptSection[] = [];
  const lines = text.split("\n");
  let currentHeader: string | null = null;
  let contentLines: string[] = [];

  const flushSection = () => {
    const content = contentLines.join("\n").trim();
    if (currentHeader) {
      sections.push(buildSection(currentHeader, content, t));
    } else if (content) {
      // Text before any ## header → mode instruction
      sections.push({
        title: "",
        content,
        type: "instruction",
        badge: { label: t("prompt.badge.instruction"), color: "gray", icon: BookOpen },
      });
    }
    contentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushSection();
      currentHeader = line.substring(3).trim();
    } else {
      contentLines.push(line);
    }
  }
  flushSection();

  // If last section content has trailing instruction text (plain sentence without markup)
  // separate it as a mode instruction
  if (sections.length > 0) {
    const last = sections[sections.length - 1];
    if (last.type !== "instruction" && last.content) {
      const contentLines2 = last.content.split("\n");
      // Check if last non-empty line is a plain instruction (no leading markdown)
      const trailingInstr: string[] = [];
      while (contentLines2.length > 0) {
        const line = contentLines2[contentLines2.length - 1].trim();
        if (!line) {
          contentLines2.pop();
          continue;
        }
        // A trailing instruction is typically a short sentence, no markdown
        if (
          !line.startsWith("[") &&
          !line.startsWith("-") &&
          !line.startsWith("#") &&
          !line.startsWith("|") &&
          line.length < 200 &&
          /^[A-Z]/.test(line)
        ) {
          trailingInstr.unshift(contentLines2.pop()!);
        } else {
          break;
        }
      }
      if (trailingInstr.length > 0 && contentLines2.length > 0) {
        last.content = contentLines2.join("\n").trim();
        sections.push({
          title: "",
          content: trailingInstr.join("\n").trim(),
          type: "instruction",
          badge: { label: t("prompt.badge.modeInstruction"), color: "gray", icon: BookOpen },
        });
      }
    }
  }

  return sections;
}

// The `includes()` checks match the English section headers of the prompt sent to the AI; only the badges are UI text.
function buildSection(title: string, content: string, t: CallLogT): PromptSection {
  if (title.includes("Reference") || title.includes("Custom")) { // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
    return {
      title,
      content,
      type: "context",
      badge: { label: t("prompt.badge.context"), color: "amber", icon: FileText },
    };
  }
  if (title.includes("Relevant Context") || title.includes("RAG")) { // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
    const chunkCount = (content.match(/^### /gm) || []).length;
    return {
      title,
      content,
      type: "context",
      badge: {
        label: chunkCount > 0 ? t("prompt.badge.chunks", { count: chunkCount }) : t("prompt.badge.documentContext"),
        color: "blue",
        icon: FileText,
      },
    };
  }
  if (title.includes("Transcript")) { // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
    const segCount = content
      .split("\n")
      .filter((l) => l.trim().startsWith("[")).length;
    return {
      title,
      content,
      type: "transcript",
      badge: {
        label: segCount > 0 ? t("prompt.badge.segments", { count: segCount }) : t("prompt.badge.transcript"),
        color: "green",
        icon: MessageSquare,
      },
    };
  }
  if (title.includes("User's Question")) { // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
    return {
      title,
      content,
      type: "question",
      badge: { label: t("prompt.badge.question"), color: "rose", icon: HelpCircle },
    };
  }
  if (title.includes("Detected Question")) { // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
    const confMatch = title.match(/(\d+)%/);
    return {
      title,
      content,
      type: "question",
      badge: {
        label: confMatch ? t("prompt.badge.confidence", { percent: confMatch[1] }) : t("prompt.badge.detected"),
        color: "rose",
        icon: HelpCircle,
      },
    };
  }
  if (title.includes("Shorten")) { // i18n-ignore: 匹配发给 AI 的提示词里的英文小节标题
    return {
      title,
      content,
      type: "question",
      badge: { label: t("prompt.badge.toShorten"), color: "amber", icon: FileText },
    };
  }
  return {
    title,
    content,
    type: "instruction",
    badge: { label: title || t("prompt.badge.section"), color: "gray", icon: BookOpen },
  };
}

// -- Copy button -------------------------------------------------------------

function SectionCopyButton({ text }: { text: string }) {
  const { t } = useT("calllog");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => showToast(t("prompt.copy.failed"), "error"));
    },
    [text, t]
  );

  if (!text) return null;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleCopy}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleCopy(e as unknown as React.MouseEvent); }} // i18n-ignore: 键盘按键名
      className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
      aria-label={t("prompt.copy.label")}
    >
      {copied ? (
        <Check className="h-3 w-3 text-success" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </span>
  );
}
