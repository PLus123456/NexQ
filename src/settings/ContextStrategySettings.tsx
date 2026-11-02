import { useState, useEffect, useCallback } from "react";
import { useConfigStore } from "../stores/configStore";
import { useRagStore } from "../stores/ragStore";
import { useRagEvents } from "../hooks/useRagEvents";
import type { ContextStrategy } from "../lib/types";
import type { RagConfigPatch, RagFullConfig } from "../lib/rag/types";
import {
  createGeminiContextCache,
  deleteGeminiContextCache,
  getGeminiCacheStatus,
  type GeminiCacheInfo,
} from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import { formatDate, formatNumber, Trans, useT } from "../i18n";
import { EmbeddingSection } from "./rag/EmbeddingSection";
import { IndexSection } from "./rag/IndexSection";
import { RerankSection } from "./rag/RerankSection";
import {
  Database,
  Cloud,
  Trash2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Loader2,
  CheckCircle2,
  HelpCircle,
  X,
  FlameKindling,
} from "lucide-react";

// ─── Preset Definitions ───────────────────────────────────────────────────────
// Search and chunk settings only: a preset never changes the embedding model
// (that would need a paid rebuild).
type PresetFields = Pick<RagFullConfig, "search_mode" | "top_k" | "chunk_size" | "chunk_overlap" | "semantic_weight">;

const PRESETS: { id: "fastest" | "faster" | "default" | "accurate" | "mostAccurate"; config: PresetFields }[] = [
  { id: "fastest", config: { search_mode: "keyword", top_k: 3, chunk_size: 256, chunk_overlap: 16, semantic_weight: 0.3 } },
  { id: "faster", config: { search_mode: "hybrid", top_k: 3, chunk_size: 512, chunk_overlap: 64, semantic_weight: 0.7 } },
  { id: "default", config: { search_mode: "hybrid", top_k: 5, chunk_size: 512, chunk_overlap: 64, semantic_weight: 0.7 } },
  { id: "accurate", config: { search_mode: "hybrid", top_k: 10, chunk_size: 256, chunk_overlap: 64, semantic_weight: 0.7 } },
  { id: "mostAccurate", config: { search_mode: "hybrid", top_k: 15, chunk_size: 256, chunk_overlap: 128, semantic_weight: 0.7 } },
];

const PRESET_KEYS = Object.keys(PRESETS[0].config) as (keyof PresetFields)[];

function getActivePresetId(config: PresetFields): string | null {
  for (const p of PRESETS) {
    if (PRESET_KEYS.every((k) => config[k] === p.config[k])) return p.id;
  }
  return null;
}

type HelpId = "topK" | "searchMode" | "chunkSize" | "chunkOverlap" | "minCosine" | "semanticWeight";

// ─── Sub-components ───────────────────────────────────────────────────────────

function HelpButton({
  id,
  activeId,
  onToggle,
}: {
  id: HelpId;
  activeId: HelpId | null;
  onToggle: (id: HelpId | null) => void;
}) {
  const { t } = useT("rag");
  const isOpen = activeId === id;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(isOpen ? null : id); }}
      className={`inline-flex items-center justify-center rounded-full border transition-colors ${
        isOpen
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/30 text-muted-foreground/60 hover:border-border/60 hover:text-muted-foreground"
      } h-[18px] w-[18px]`}
      title={t("help.show")}
      aria-label={t("help.show")}
      aria-expanded={isOpen}
    >
      {isOpen ? <X className="h-2.5 w-2.5" /> : <HelpCircle className="h-2.5 w-2.5" />}
    </button>
  );
}

function HelpPanel({ id }: { id: HelpId }) {
  const { t } = useT("rag");
  return (
    <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 space-y-1">
      <p className="text-xs font-semibold text-primary/80">{t(`help.${id}.title`)}</p>
      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{t(`help.${id}.body`)}</p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function ContextStrategySettings() {
  const { t } = useT(["rag", "common"]);
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const setContextStrategy = useConfigStore((s) => s.setContextStrategy);

  const settings = useRagStore((s) => s.settings);
  const loadSettings = useRagStore((s) => s.loadSettings);
  const updateConfig = useRagStore((s) => s.updateConfig);
  const refreshIndexStatus = useRagStore((s) => s.refreshIndexStatus);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openHelp, setOpenHelp] = useState<HelpId | null>(null);
  // Slider values while dragging (saved on release).
  const [dragging, setDragging] = useState<Partial<RagFullConfig>>({});

  useRagEvents();

  useEffect(() => {
    void loadSettings();
    void refreshIndexStatus();
  }, [loadSettings, refreshIndexStatus]);

  const config = settings?.config;

  const handleStrategyChange = (strategy: ContextStrategy) => {
    setContextStrategy(strategy);
    void updateConfig({ enabled: strategy === "local_rag", include_transcript: false });
  };

  const save = useCallback((patch: RagConfigPatch) => void updateConfig(patch), [updateConfig]);

  const slide = <K extends keyof RagFullConfig>(key: K, value: RagFullConfig[K]) =>
    setDragging((prev) => ({ ...prev, [key]: value }));

  const release = <K extends keyof RagFullConfig>(key: K) => {
    const value = dragging[key];
    if (value === undefined) return;
    setDragging((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    save({ [key]: value } as RagConfigPatch);
  };

  const toggleHelp = useCallback((id: HelpId | null) => {
    setOpenHelp((prev) => (prev === id ? null : id));
  }, []);

  const value = <K extends keyof RagFullConfig>(key: K): RagFullConfig[K] | undefined =>
    (dragging[key] as RagFullConfig[K] | undefined) ?? config?.[key];

  const activePresetId = config ? getActivePresetId(config) : null;
  const minCosine = dragging.retrieval?.min_cosine ?? config?.retrieval.min_cosine ?? 0;

  return (
    <div className="space-y-6">
      {/* ── Strategy Selector ── */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => handleStrategyChange("local_rag")}
          className={`relative flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-150 ${
            contextStrategy === "local_rag"
              ? "border-primary bg-primary/5 ring-1 ring-primary/20"
              : "border-border/50 hover:border-border hover:bg-accent/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">{t("strategy.localRag.title")}</span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            {t("strategy.localRag.description")}
          </p>
        </button>

        <button
          onClick={() => handleStrategyChange("gemini_cache")}
          className={`relative flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-150 ${
            contextStrategy === "gemini_cache"
              ? "border-orange-400/60 bg-orange-400/5 ring-1 ring-orange-400/20"
              : "border-border/50 hover:border-border hover:bg-accent/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-orange-400" />
            <span className="text-sm font-medium text-foreground">{t("strategy.geminiCache.title")}</span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            {t("strategy.geminiCache.description")}
          </p>
        </button>
      </div>

      {contextStrategy === "local_rag" && config && (
        <>
          {/* ── Quick Presets ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-primary/80">{t("presets.title")}</h3>
              <p className="text-meta text-muted-foreground/60">{t("presets.subtitle")}</p>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PRESETS.map((preset) => {
                const isActive = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() => save(preset.config)}
                    title={t(`presets.items.${preset.id}.description`)}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-all ${
                      isActive
                        ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                        : "border-border/30 bg-background hover:border-border/60 hover:bg-accent/40"
                    }`}
                  >
                    <span className={`text-xs font-semibold ${isActive ? "text-primary" : "text-foreground"}`}>
                      {t(`presets.items.${preset.id}.label`)}
                    </span>
                    <span className={`rounded-full px-1.5 py-0.5 text-meta font-medium ${
                      isActive ? "bg-primary/20 text-primary" : "bg-muted/50 text-muted-foreground"
                    }`}>
                      {t("presets.topK", { count: preset.config.top_k })}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2.5 text-meta text-muted-foreground/70 leading-relaxed">{t("presets.note")}</p>
          </div>

          {/* ── Embedding service ── */}
          <EmbeddingSection />

          {/* ── Reranking ── */}
          <RerankSection />

          {/* ── Search Settings ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-5">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("search.title")}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label htmlFor="rag-top-k" className="text-xs font-medium text-foreground">
                    {t("search.topK.label")}
                  </label>
                  <HelpButton id="topK" activeId={openHelp} onToggle={toggleHelp} />
                </div>
                <select
                  id="rag-top-k"
                  value={config.top_k}
                  onChange={(e) => save({ top_k: Number(e.target.value) })}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  {[3, 5, 7, 10, 15, 20].map((v) => (
                    <option key={v} value={v}>{t("search.topK.option", { count: v })}</option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label htmlFor="rag-search-mode" className="text-xs font-medium text-foreground">
                    {t("search.mode.label")}
                  </label>
                  <HelpButton id="searchMode" activeId={openHelp} onToggle={toggleHelp} />
                </div>
                <select
                  id="rag-search-mode"
                  value={config.search_mode}
                  onChange={(e) => save({ search_mode: e.target.value })}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  <option value="hybrid">{t("search.mode.hybrid")}</option>
                  <option value="semantic">{t("search.mode.semantic")}</option>
                  <option value="keyword">{t("search.mode.keyword")}</option>
                </select>
              </div>
            </div>
            {(openHelp === "topK" || openHelp === "searchMode") && <div className="mt-3"><HelpPanel id={openHelp} /></div>}
          </div>

          {/* ── Index Status ── */}
          <IndexSection />

          {/* ── Advanced Settings ── */}
          <div className="rounded-xl border border-border/30 bg-card/50">
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between px-5 py-3.5 text-sm font-semibold text-primary/80 transition-colors hover:bg-accent/20"
            >
              <span>{t("advanced.title")}</span>
              {advancedOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />
              }
            </button>

            {advancedOpen && (
              <div className="border-t border-border/20 px-5 py-4 space-y-5">
                {/* Chunk Size */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="rag-chunk-size" className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      {t("advanced.chunkSize.label")}
                      <HelpButton id="chunkSize" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">
                      {t("advanced.tokens", { count: value("chunk_size") ?? 512 })}
                    </span>
                  </div>
                  {openHelp === "chunkSize" && <HelpPanel id="chunkSize" />}
                  <input
                    id="rag-chunk-size"
                    type="range" min={128} max={2048} step={64}
                    value={value("chunk_size") ?? 512}
                    onChange={(e) => slide("chunk_size", Number(e.target.value))}
                    onMouseUp={() => release("chunk_size")} onTouchEnd={() => release("chunk_size")} onKeyUp={() => release("chunk_size")}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>{t("advanced.chunkSize.min")}</span><span>{t("advanced.chunkSize.max")}</span>
                  </div>
                </div>

                {/* Chunk Overlap */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="rag-chunk-overlap" className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      {t("advanced.chunkOverlap.label")}
                      <HelpButton id="chunkOverlap" activeId={openHelp} onToggle={toggleHelp} />
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">
                      {t("advanced.tokens", { count: value("chunk_overlap") ?? 64 })}
                    </span>
                  </div>
                  {openHelp === "chunkOverlap" && <HelpPanel id="chunkOverlap" />}
                  <input
                    id="rag-chunk-overlap"
                    type="range" min={0} max={512} step={16}
                    value={value("chunk_overlap") ?? 64}
                    onChange={(e) => slide("chunk_overlap", Number(e.target.value))}
                    onMouseUp={() => release("chunk_overlap")} onTouchEnd={() => release("chunk_overlap")} onKeyUp={() => release("chunk_overlap")}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>{t("advanced.chunkOverlap.min")}</span><span>{t("advanced.chunkOverlap.max")}</span>
                  </div>
                  <p className="mt-1.5 text-meta text-muted-foreground/70">{t("advanced.rebuildHint")}</p>
                </div>

                {/* Minimum similarity (vector hits) */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="rag-min-cosine" className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      {t("advanced.minCosine.label")}
                      <HelpButton id="minCosine" activeId={openHelp} onToggle={toggleHelp} />
                      {config.search_mode === "keyword" && (
                        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-meta text-muted-foreground/60">
                          {t("advanced.vectorOnly")}
                        </span>
                      )}
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">
                      {minCosine > 0 ? formatNumber(minCosine, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : t("common:labels.off")}
                    </span>
                  </div>
                  {openHelp === "minCosine" && <HelpPanel id="minCosine" />}
                  <input
                    id="rag-min-cosine"
                    type="range" min={0} max={0.9} step={0.05}
                    value={minCosine}
                    onChange={(e) => setDragging((prev) => ({ ...prev, retrieval: { ...config.retrieval, min_cosine: Number(e.target.value) } }))}
                    onMouseUp={() => release("retrieval")} onTouchEnd={() => release("retrieval")} onKeyUp={() => release("retrieval")}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>{t("advanced.minCosine.min")}</span><span>{t("advanced.minCosine.max")}</span>
                  </div>
                </div>

                {/* Semantic Weight */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="rag-semantic-weight" className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      {t("advanced.semanticWeight.label")}
                      <HelpButton id="semanticWeight" activeId={openHelp} onToggle={toggleHelp} />
                      {config.search_mode !== "hybrid" && (
                        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-meta text-muted-foreground/60">
                          {t("advanced.hybridOnly")}
                        </span>
                      )}
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">
                      {t("advanced.semanticWeight.value", {
                        semantic: Math.round((value("semantic_weight") ?? 0.7) * 100),
                        keyword: Math.round((1 - (value("semantic_weight") ?? 0.7)) * 100),
                      })}
                    </span>
                  </div>
                  {openHelp === "semanticWeight" && <HelpPanel id="semanticWeight" />}
                  <input
                    id="rag-semantic-weight"
                    type="range" min={0} max={1} step={0.05}
                    value={value("semantic_weight") ?? 0.7}
                    onChange={(e) => slide("semantic_weight", Number(e.target.value))}
                    onMouseUp={() => release("semantic_weight")} onTouchEnd={() => release("semantic_weight")} onKeyUp={() => release("semantic_weight")}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>{t("advanced.semanticWeight.min")}</span><span>{t("advanced.semanticWeight.max")}</span>
                  </div>
                </div>

                {/* Background indexing */}
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={config.indexing.auto_index}
                      onChange={(e) => save({ indexing: { auto_index: e.target.checked } })}
                      className="accent-primary"
                    />
                    {t("advanced.autoIndex")}
                  </label>
                  <div>
                    <label htmlFor="rag-meeting-mode" className="mb-1.5 block text-xs font-medium text-foreground">
                      {t("advanced.meetingMode.label")}
                    </label>
                    <select
                      id="rag-meeting-mode"
                      value={config.indexing.meeting_mode}
                      onChange={(e) => save({ indexing: { meeting_mode: e.target.value as RagFullConfig["indexing"]["meeting_mode"] } })}
                      className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                    >
                      <option value="pause_local">{t("advanced.meetingMode.pause_local")}</option>
                      <option value="slow">{t("advanced.meetingMode.slow")}</option>
                      <option value="normal">{t("advanced.meetingMode.normal")}</option>
                    </select>
                  </div>
                </div>

                {/* Reset */}
                <button
                  onClick={() =>
                    save({
                      ...PRESETS[2].config,
                      retrieval: { min_cosine: 0 },
                      indexing: { auto_index: true, meeting_mode: "pause_local" },
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("common:actions.resetDefaults")}
                </button>
              </div>
            )}
          </div>

          {/* ── How it works during meetings ── */}
          <div className="rounded-xl border border-border/20 bg-accent/10 px-4 py-3">
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              <Trans
                t={t}
                i18nKey="meetingNote"
                values={{ topK: config.top_k }}
                components={{ strong: <span className="font-semibold text-foreground/70" /> }}
              />
            </p>
          </div>
        </>
      )}

      <GeminiCachePanel />
    </div>
  );
}

// ─── Gemini Context Cache Panel ───────────────────────────────────────────────
function GeminiCachePanel() {
  const { t } = useT(["rag", "common"]);
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const [cache, setCache] = useState<GeminiCacheInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("gemini-2.0-flash-001");
  const [ttl, setTtl] = useState(3600);

  useEffect(() => {
    if (contextStrategy !== "gemini_cache") return;
    getGeminiCacheStatus().then(setCache).catch(() => {});
  }, [contextStrategy]);

  if (contextStrategy !== "gemini_cache") return null;

  async function handleCreate() {
    setLoading(true);
    try {
      const info = await createGeminiContextCache(model, ttl);
      setCache(info);
      showToast(t("gemini.toasts.created", { tokens: formatNumber(info.total_token_count) }), "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteGeminiContextCache();
      setCache(null);
      showToast(t("gemini.toasts.cleared"), "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  const expireLabel = cache ? formatDate(cache.expire_time, { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <FlameKindling className="h-4 w-4 text-orange-400" />
        <h3 className="text-sm font-semibold text-foreground">{t("gemini.title")}</h3>
        {cache && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
            <CheckCircle2 className="h-3 w-3" /> {t("gemini.active", { time: expireLabel })}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        <Trans t={t} i18nKey="gemini.description" components={{ strong: <span className="text-foreground/80 font-medium" /> }} />
      </p>

      {!cache ? (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor="gemini-cache-model" className="mb-1 block text-xs text-muted-foreground">{t("gemini.model")}</label>
              <select
                id="gemini-cache-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value="gemini-2.0-flash-001">gemini-2.0-flash-001</option>
                <option value="gemini-1.5-flash-001">gemini-1.5-flash-001</option>
                <option value="gemini-1.5-pro-001">gemini-1.5-pro-001</option>
              </select>
            </div>
            <div className="w-28">
              <label htmlFor="gemini-cache-ttl" className="mb-1 block text-xs text-muted-foreground">{t("gemini.ttl")}</label>
              <select
                id="gemini-cache-ttl"
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value={1800}>{t("gemini.ttlOptions.min30")}</option>
                <option value={3600}>{t("gemini.ttlOptions.hour1")}</option>
                <option value={7200}>{t("gemini.ttlOptions.hours2")}</option>
                <option value={86400}>{t("gemini.ttlOptions.hours24")}</option>
              </select>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
            {t("gemini.create")}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-border/30 bg-background/50 px-4 py-3">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p><span className="text-foreground/70 font-medium">{t("gemini.modelLabel")}</span> {cache.model.replace("models/", "")}</p>
            <p><span className="text-foreground/70 font-medium">{t("gemini.tokensCached")}</span> {formatNumber(cache.total_token_count)}</p>
          </div>
          <button
            onClick={handleDelete}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            {t("common:actions.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
