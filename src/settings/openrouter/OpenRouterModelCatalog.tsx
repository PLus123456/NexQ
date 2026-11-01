import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { OpenRouterModel } from "../../lib/types";
import { useConfigStore } from "../../stores/configStore";
import { setActiveModel as ipcSetActiveModel } from "../../lib/ipc";
import { ModelCard } from "./ModelCard";
import { FilterBar, type SortOption } from "./FilterBar";
import { RecentlyUsedSection } from "./RecentlyUsedSection";
import { FavoritesSection } from "./FavoritesSection";
import { useT } from "../../i18n";

interface OpenRouterModelCatalogProps {
  models: OpenRouterModel[];
  /** The model shown as chosen; without it, the active / browsed OpenRouter model. */
  selectedId?: string;
  /** Picking a model calls this instead of switching the active model (LLM connections). */
  onSelect?: (id: string) => void;
}

const VISIBLE_BATCH = 50;

export function OpenRouterModelCatalog({ models, selectedId: chosenId, onSelect }: OpenRouterModelCatalogProps) {
  const { t } = useT("llm");
  const llmModel = useConfigStore((s) => s.llmModel);
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const setConfigModel = useConfigStore((s) => s.setLLMModel);
  const rememberModel = useConfigStore((s) => s.rememberModel);
  const browsedModel = useConfigStore((s) => s.lastModelByProvider.openrouter);
  // Active: the active model. Browsed: the model picked for OpenRouter.
  const selectedId = chosenId ?? (llmProvider === "openrouter" ? llmModel : browsedModel ?? "");
  const favorites = useConfigStore((s) => s.openrouterFavorites);
  const recentlyUsed = useConfigStore((s) => s.openrouterRecentlyUsed);
  const toggleFavorite = useConfigStore((s) => s.toggleOpenRouterFavorite);
  const addRecentlyUsed = useConfigStore((s) => s.addOpenRouterRecentlyUsed);
  const removeRecentlyUsed = useConfigStore((s) => s.removeOpenRouterRecentlyUsed);
  const clearRecentlyUsed = useConfigStore((s) => s.clearOpenRouterRecentlyUsed);

  // Filter/sort state (local, resets on leave)
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounce search input by 200ms
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(debounceRef.current);
  }, [search]);
  const [sort, setSort] = useState<SortOption>("newest");
  const [freeOnly, setFreeOnly] = useState(false);
  const [filterTools, setFilterTools] = useState(false);
  const [filterReasoning, setFilterReasoning] = useState(false);
  const [filterWebSearch, setFilterWebSearch] = useState(false);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH);

  // Model selection handler. While OpenRouter is only browsed, the choice is
  // remembered for it and applied by "Set as Active Provider".
  const handleSelect = useCallback(
    async (id: string) => {
      addRecentlyUsed(id);
      if (onSelect) {
        onSelect(id);
        return;
      }
      if (llmProvider !== "openrouter") {
        rememberModel("openrouter", id);
        return;
      }
      setConfigModel(id, "openrouter");
      try {
        await ipcSetActiveModel("openrouter", id);
      } catch (err) {
        console.error("[OpenRouterCatalog] Failed to set active model:", err);
      }
    },
    [llmProvider, setConfigModel, rememberModel, addRecentlyUsed, onSelect]
  );

  // Filter + sort pipeline (uses debounced search)
  const filtered = useMemo(() => {
    const lowerSearch = debouncedSearch.toLowerCase();

    let result = models.filter((m) => {
      if (freeOnly && !m.is_free) return false;
      if (filterTools && !m.supports_tools) return false;
      if (filterReasoning && !m.supports_reasoning) return false;
      if (filterWebSearch && !m.supports_web_search) return false;
      if (
        lowerSearch &&
        !m.name.toLowerCase().includes(lowerSearch) &&
        !m.description.toLowerCase().includes(lowerSearch) &&
        !m.provider_name.toLowerCase().includes(lowerSearch)
      )
        return false;
      return true;
    });

    result.sort((a, b) => {
      switch (sort) {
        case "newest":
          return b.created - a.created;
        case "price_asc":
          return a.pricing.prompt - b.pricing.prompt;
        case "price_desc":
          return b.pricing.prompt - a.pricing.prompt;
        case "context_desc":
          return (b.context_length ?? 0) - (a.context_length ?? 0);
        default:
          return 0;
      }
    });

    return result;
  }, [models, debouncedSearch, sort, freeOnly, filterTools, filterReasoning, filterWebSearch]);

  // Favorites that also pass current filters
  const filteredFavoriteIds = useMemo(
    () => favorites.filter((id) => filtered.some((m) => m.id === id)),
    [favorites, filtered]
  );

  // Virtual scroll: show more on scroll
  const visibleModels = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // Active filter summary
  const activeFilters: string[] = [];
  if (freeOnly) activeFilters.push(t("openrouter.activeFilters.free"));
  if (filterTools) activeFilters.push(t("openrouter.activeFilters.tools"));
  if (filterReasoning) activeFilters.push(t("openrouter.activeFilters.reasoning"));
  if (filterWebSearch) activeFilters.push(t("openrouter.activeFilters.webSearch"));

  const resetFilters = () => {
    setSearch("");
    setFreeOnly(false);
    setFilterTools(false);
    setFilterReasoning(false);
    setFilterWebSearch(false);
    setSort("newest");
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <FilterBar
        search={search}
        onSearchChange={(v) => { setSearch(v); setVisibleCount(VISIBLE_BATCH); }}
        sort={sort}
        onSortChange={(v) => { setSort(v); setVisibleCount(VISIBLE_BATCH); }}
        freeOnly={freeOnly}
        onFreeOnlyChange={(v) => { setFreeOnly(v); setVisibleCount(VISIBLE_BATCH); }}
        filterTools={filterTools}
        onFilterToolsChange={(v) => { setFilterTools(v); setVisibleCount(VISIBLE_BATCH); }}
        filterReasoning={filterReasoning}
        onFilterReasoningChange={(v) => { setFilterReasoning(v); setVisibleCount(VISIBLE_BATCH); }}
        filterWebSearch={filterWebSearch}
        onFilterWebSearchChange={(v) => { setFilterWebSearch(v); setVisibleCount(VISIBLE_BATCH); }}
      />

      {/* Recently Used */}
      <RecentlyUsedSection
        recentIds={recentlyUsed}
        models={models}
        onSelect={handleSelect}
        onRemove={removeRecentlyUsed}
        onClearAll={clearRecentlyUsed}
      />

      {/* Favorites */}
      <FavoritesSection
        favoriteIds={filteredFavoriteIds}
        models={filtered}
        selectedModelId={selectedId}
        onSelect={handleSelect}
        onToggleFavorite={toggleFavorite}
      />

      {/* All Models */}
      <div>
        <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground/40 mb-1 pl-0.5">
          {t("openrouter.allModels")}
        </h4>
        <p className="text-[11px] text-muted-foreground/30 mb-2 pl-0.5">
          {t("openrouter.count", { count: filtered.length })}
          {activeFilters.length > 0 && t("openrouter.filteredBy", { filters: activeFilters.join(t("openrouter.listSeparator")) })}
        </p>

        {filtered.length === 0 ? (
          <div className="rounded-lg border border-border/20 bg-accent/10 px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground/50">
              {t("openrouter.noMatches")}
            </p>
            <button
              onClick={resetFilters}
              className="mt-2 text-xs text-primary hover:underline cursor-pointer"
            >
              {t("openrouter.resetFilters")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[520px] overflow-y-auto pr-1 scrollbar-thin">
            {visibleModels.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                isSelected={selectedId === m.id}
                isFavorite={favorites.includes(m.id)}
                onSelect={handleSelect}
                onToggleFavorite={toggleFavorite}
              />
            ))}
            {hasMore && (
              <button
                onClick={() => setVisibleCount((c) => c + VISIBLE_BATCH)}
                className="py-2 text-xs text-muted-foreground/40 hover:text-muted-foreground/60 cursor-pointer"
              >
                {t("openrouter.showMore", { remaining: filtered.length - visibleCount })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
