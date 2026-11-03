// "Answer completeness" in the knowledge base settings: context expansion
// (neighbouring chunks or whole sections), splitting at headings, query
// rewriting and chapter summaries. The last two cost LLM calls and are off
// by default; their models come from the LLM task routing. Changes save
// immediately.

import { formatNumber, useT } from "../../i18n";
import type { RagConfigPatch } from "../../lib/rag/types";
import { useRagStore } from "../../stores/ragStore";

const SELECT =
  "w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
const LABEL = "mb-1.5 block text-xs font-medium text-foreground";
const HINT = "mt-1 text-meta leading-relaxed text-muted-foreground";

const NEIGHBORS = [0, 1, 2, 3];
const SECTION_TOKENS = [0, 1000, 2000, 4000, 8000];
const TOTAL_TOKENS = [8000, 16000, 32000, 64000];
const VARIANTS = [1, 2, 3, 4, 5];
const TIMEOUTS_MS = [2000, 3000, 5000, 8000, 15000];

/** The options plus the stored value when it is not one of them. */
function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

function Toggle({
  id,
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium text-foreground">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-primary"
        />
        {label}
      </label>
      <p className={`${HINT} pl-5`}>{hint}</p>
    </div>
  );
}

export function RetrievalSection() {
  const { t } = useT("rag");
  const config = useRagStore((s) => s.settings?.config);
  const updateConfig = useRagStore((s) => s.updateConfig);
  if (!config?.expansion || !config.rewrite || !config.summaries) return null;
  const save = (patch: RagConfigPatch) => void updateConfig(patch);
  const { expansion, rewrite, summaries } = config;
  const headings = config.splitting_strategy === "headings";
  const tokens = (count: number) => t("completeness.tokens", { count, formatted: formatNumber(count) });

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="text-sm font-semibold text-primary/80">{t("completeness.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("completeness.subtitle")}</p>

      <div className="mt-4 space-y-5">
        {/* Context expansion */}
        <div className="space-y-3">
          <Toggle
            id="rag-expansion"
            checked={expansion.enabled}
            onChange={(enabled) => save({ expansion: { enabled } })}
            label={t("completeness.expansion.label")}
            hint={t("completeness.expansion.hint")}
          />
          {expansion.enabled && (
            <div className="grid grid-cols-3 gap-3 pl-5">
              <div>
                <label htmlFor="rag-expansion-neighbors" className={LABEL}>
                  {t("completeness.expansion.neighbors")}
                </label>
                <select
                  id="rag-expansion-neighbors"
                  value={expansion.neighbors}
                  onChange={(e) => save({ expansion: { neighbors: Number(e.target.value) } })}
                  className={SELECT}
                >
                  {withCurrent(NEIGHBORS, expansion.neighbors).map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? t("completeness.expansion.neighborsNone") : t("completeness.expansion.neighborsOption", { count: n })}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rag-expansion-section" className={LABEL}>
                  {t("completeness.expansion.section")}
                </label>
                <select
                  id="rag-expansion-section"
                  value={expansion.section_max_tokens}
                  onChange={(e) => save({ expansion: { section_max_tokens: Number(e.target.value) } })}
                  className={SELECT}
                >
                  {withCurrent(SECTION_TOKENS, expansion.section_max_tokens).map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? t("completeness.expansion.sectionOff") : tokens(n)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rag-expansion-total" className={LABEL}>
                  {t("completeness.expansion.total")}
                </label>
                <select
                  id="rag-expansion-total"
                  value={expansion.max_total_tokens}
                  onChange={(e) => save({ expansion: { max_total_tokens: Number(e.target.value) } })}
                  className={SELECT}
                >
                  {withCurrent(TOTAL_TOKENS, expansion.max_total_tokens).map((n) => (
                    <option key={n} value={n}>
                      {tokens(n)}
                    </option>
                  ))}
                </select>
              </div>
              <p className={`${HINT} col-span-3 mt-0`}>{t("completeness.expansion.limitsHint")}</p>
            </div>
          )}
        </div>

        {/* Heading-aware splitting */}
        <Toggle
          id="rag-split-headings"
          checked={headings}
          onChange={(on) => save({ splitting_strategy: on ? "headings" : "recursive" })}
          label={t("completeness.headings.label")}
          hint={t("completeness.headings.hint")}
        />

        {/* Query rewriting */}
        <div className="space-y-3">
          <Toggle
            id="rag-rewrite"
            checked={rewrite.enabled}
            onChange={(enabled) => save({ rewrite: { enabled } })}
            label={t("completeness.rewrite.label")}
            hint={t("completeness.rewrite.hint")}
          />
          {rewrite.enabled && (
            <div className="grid grid-cols-2 gap-3 pl-5">
              <div>
                <label htmlFor="rag-rewrite-variants" className={LABEL}>
                  {t("completeness.rewrite.variants")}
                </label>
                <select
                  id="rag-rewrite-variants"
                  value={rewrite.variants}
                  onChange={(e) => save({ rewrite: { variants: Number(e.target.value) } })}
                  className={SELECT}
                >
                  {withCurrent(VARIANTS, rewrite.variants).map((n) => (
                    <option key={n} value={n}>
                      {t("completeness.rewrite.variantsOption", { count: n })}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rag-rewrite-timeout" className={LABEL}>
                  {t("completeness.rewrite.timeout")}
                </label>
                <select
                  id="rag-rewrite-timeout"
                  value={rewrite.timeout_ms}
                  onChange={(e) => save({ rewrite: { timeout_ms: Number(e.target.value) } })}
                  className={SELECT}
                >
                  {withCurrent(TIMEOUTS_MS, rewrite.timeout_ms).map((ms) => (
                    <option key={ms} value={ms}>
                      {t("completeness.rewrite.seconds", { count: ms / 1000 })}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Chapter summaries */}
        <div>
          <Toggle
            id="rag-summaries"
            checked={summaries.enabled}
            disabled={!headings && !summaries.enabled}
            onChange={(enabled) => save({ summaries: { enabled } })}
            label={t("completeness.summaries.label")}
            hint={t("completeness.summaries.hint")}
          />
          {!headings && <p className={`${HINT} pl-5 text-warning/90`}>{t("completeness.summaries.needsHeadings")}</p>}
        </div>
      </div>
    </div>
  );
}
