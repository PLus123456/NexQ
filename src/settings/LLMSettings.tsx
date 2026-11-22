import { useState, useEffect, useCallback, useRef } from "react";
import type { ParseKeys } from "i18next";
import { useT } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import {
  getLLMProviders,
  listModels,
  setActiveModel,
  setLLMProvider,
  testLLMConnection,
  storeApiKey,
  getApiKey,
  hasApiKey,
  listOpenRouterModels,
} from "../lib/ipc";
import type { CustomLlmAuthType as CustomAuthType, LLMProviderType, ModelInfo, OpenRouterModel } from "../lib/types";
import { OpenRouterModelCatalog } from "./openrouter/OpenRouterModelCatalog";
import { ClaudeCliSettings, claudeTierLabel } from "./ClaudeCliSettings";
import { ThinkingSettings } from "./ThinkingSettings";
import { ProviderCard, type StatusTone } from "./ProviderCard";
import { requestOptionFields } from "../lib/llmRequestOptions";
import { useAgentStore } from "../stores/agentStore";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  Wifi,
  Server,
  Cloud,
  Settings2,
  Zap,
} from "lucide-react";

type ConnectionStatus = "idle" | "testing" | "success" | "error";

type ProviderDisplay = (
  | { label: string }
  | { labelKey: ParseKeys<"llm"> }
) & (
  | { description: string }
  | { descriptionKey: ParseKeys<"llm"> }
) & { requiresKey: boolean; isLocal: boolean };

// Brand/model names stay literal; descriptive text is translated at render time.
const PROVIDER_DISPLAY: Record<LLMProviderType, ProviderDisplay> = {
  ollama: { label: "Ollama", descriptionKey: "legacy.providers.ollama.description", requiresKey: false, isLocal: true }, // i18n-ignore: brand name
  lm_studio: { label: "LM Studio", descriptionKey: "legacy.providers.lmStudio.description", requiresKey: false, isLocal: true }, // i18n-ignore: brand name
  openai: { label: "OpenAI", descriptionKey: "legacy.providers.openai.description", requiresKey: true, isLocal: false }, // i18n-ignore: brand name
  anthropic: { label: "Anthropic", description: "Claude Sonnet, Opus, Haiku", requiresKey: true, isLocal: false }, // i18n-ignore: brand/model names
  groq: { label: "Groq", descriptionKey: "legacy.providers.groq.description", requiresKey: true, isLocal: false }, // i18n-ignore: brand name
  gemini: { label: "Google Gemini", description: "Gemini Pro, Flash", requiresKey: true, isLocal: false }, // i18n-ignore: brand/model names
  openrouter: { label: "OpenRouter", descriptionKey: "legacy.providers.openrouter.description", requiresKey: true, isLocal: false }, // i18n-ignore: brand name
  custom: { labelKey: "legacy.providers.custom.label", descriptionKey: "legacy.providers.custom.description", requiresKey: false, isLocal: false },
  // Not in ALL_PROVIDERS: it gets its own "Subscription (local CLI)" group.
  // isLocal is false here because that flag drives the local-server hints below.
  claude_cli: { labelKey: "templates.items.claude_cli.name", descriptionKey: "legacy.providers.claudeCli.description", requiresKey: false, isLocal: false },
};

const ALL_PROVIDERS: LLMProviderType[] = [
  "ollama", "lm_studio", "openai", "anthropic", "groq", "gemini", "openrouter", "custom",
];

// Filter out known embedding-only models
const EMBEDDING_ONLY_PATTERNS = [
  "all-minilm", "mxbai-embed", "nomic-embed", "bge-",
  "text-embedding", "snowflake-arctic-embed", "jina-embeddings",
];

function filterChatModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(
    (m) => !EMBEDDING_ONLY_PATTERNS.some((p) => m.id.toLowerCase().includes(p))
  );
}

// ── Provider status ──
// One word per card, always about the provider itself and never about whether
// it is the one in use. Local servers are probed once when the panel opens.
type LocalReach = "checking" | "up" | "down";
interface ProviderStatus {
  labelKey: `legacy.status.${"checking" | "ready" | "notRunning" | "noKey" | "notSetUp"}`;
  tone: StatusTone;
}

const LOCAL_PROVIDERS: LLMProviderType[] = ["ollama", "lm_studio"];
/** A local server that doesn't answer this fast is treated as not running. */
const REACH_TIMEOUT_MS = 3000;

function getProviderStatus(
  providerType: LLMProviderType,
  verifiedProviders: string[],
  keyExists: boolean,
  reach: LocalReach,
  customConfigured: boolean,
): ProviderStatus {
  const info = PROVIDER_DISPLAY[providerType];

  if (info.isLocal) {
    if (reach === "checking") return { labelKey: "legacy.status.checking", tone: "checking" };
    return reach === "up"
      ? { labelKey: "legacy.status.ready", tone: "ok" }
      : { labelKey: "legacy.status.notRunning", tone: "warn" };
  }
  if (info.requiresKey) {
    return verifiedProviders.includes(providerType) || keyExists
      ? { labelKey: "legacy.status.ready", tone: "ok" }
      : { labelKey: "legacy.status.noKey", tone: "warn" };
  }
  // Custom endpoint
  return verifiedProviders.includes(providerType) || customConfigured
    ? { labelKey: "legacy.status.ready", tone: "ok" }
    : { labelKey: "legacy.status.notSetUp", tone: "neutral" };
}

// ══════════════════════════════════════════════════════════════

export function LLMSettings() {
  const { t } = useT(["llm", "common"]);
  const providerLabel = (provider: LLMProviderType) => {
    const display = PROVIDER_DISPLAY[provider];
    if (!display) return provider;
    return "labelKey" in display ? t(display.labelKey) : display.label;
  };
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const setConfigModel = useConfigStore((s) => s.setLLMModel);
  const activateLLMProvider = useConfigStore((s) => s.activateLLMProvider);
  const verifiedCloudProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const setVerifiedCloudProviders = useConfigStore((s) => s.setVerifiedCloudProviders);
  const claudeCliConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const claudeStatus = useAgentStore((s) => s.status);

  const [selectedProvider, setSelectedProvider] = useState<LLMProviderType>(llmProvider);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [selectedModel, setSelectedModel] = useState(llmModel);
  const [apiKey, setApiKeyValue] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [keyStatusMap, setKeyStatusMap] = useState<Record<string, boolean>>({});
  // Whether the local servers answer: asked once when the panel opens, kept for its lifetime.
  const [localReach, setLocalReach] = useState<Record<string, LocalReach>>({
    ollama: "checking",
    lm_studio: "checking",
  });
  const reachChecked = useRef(false);

  // The active provider changed elsewhere (the footer, in this or the other
  // window): show that provider, so Settings never offers to "activate" the
  // one just replaced. A switch made here already has it selected.
  const selectedRef = useRef(selectedProvider);
  selectedRef.current = selectedProvider;
  useEffect(() => {
    if (llmProvider === selectedRef.current) return;
    handleProviderChange(llmProvider);
    setSelectedModel(useConfigStore.getState().llmModel);
  }, [llmProvider]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedRef.current === useConfigStore.getState().llmProvider) setSelectedModel(llmModel);
  }, [llmModel]);

  // Custom provider fields — hydrated from persisted config so they survive restarts
  const storedCustomBaseUrl = useConfigStore((s) => s.customLlmBaseUrl);
  const storedCustomAuthType = useConfigStore((s) => s.customLlmAuthType);
  const setCustomLlmConfig = useConfigStore((s) => s.setCustomLlmConfig);

  const [customBaseUrl, setCustomBaseUrl] = useState(storedCustomBaseUrl);
  const [customAuthType, setCustomAuthType] = useState<"none" | "bearer" | "api_key">(storedCustomAuthType);
  const [customAuthValue, setCustomAuthValue] = useState("");

  // Check which providers have stored API keys (for badge display)
  useEffect(() => {
    async function checkAllKeys() {
      const cloudProviders = ["openai", "anthropic", "groq", "gemini", "openrouter"];
      const status: Record<string, boolean> = {};
      for (const p of cloudProviders) {
        try { status[p] = await hasApiKey(p); } catch { status[p] = false; }
      }
      setKeyStatusMap(status);
    }
    checkAllKeys();
  }, []);

  // Cheap reachability probe of the local servers (the same call as Test
  // Connection, short timeout), once per panel.
  useEffect(() => {
    if (reachChecked.current) return;
    reachChecked.current = true;
    let alive = true;
    for (const p of LOCAL_PROVIDERS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), REACH_TIMEOUT_MS);
      });
      Promise.race([testLLMConnection(JSON.stringify({ provider_type: p })).catch(() => false), timeout])
        // A manual Test Connection that finished first wins: only fill in a still-unknown status.
        .then((ok) =>
          alive &&
          setLocalReach((prev) => (prev[p] === "checking" ? { ...prev, [p]: ok ? "up" : "down" } : prev)),
        )
        .finally(() => clearTimeout(timer));
    }
    return () => {
      alive = false;
      reachChecked.current = false;
    };
  }, []);

  // Load API key when provider changes
  useEffect(() => {
    const info = PROVIDER_DISPLAY[selectedProvider];
    if (info?.requiresKey) {
      getApiKey(selectedProvider)
        .then((key) => setApiKeyValue(key || ""))
        .catch(() => setApiKeyValue(""));
    } else {
      setApiKeyValue("");
    }
    setConnectionStatus("idle");
    setConnectionMessage("");
    setModels([]);
    setOpenRouterModels([]);
    setModelsError("");
  }, [selectedProvider]);

  // Custom provider: load persisted base URL / auth type + stored token when the
  // provider is selected, so the user's endpoint is restored after a restart.
  useEffect(() => {
    if (selectedProvider !== "custom") return;
    setCustomBaseUrl(useConfigStore.getState().customLlmBaseUrl);
    setCustomAuthType(useConfigStore.getState().customLlmAuthType);
    getApiKey("custom")
      .then((v) => setCustomAuthValue(v || ""))
      .catch(() => setCustomAuthValue(""));
  }, [selectedProvider]);

  // Persist base URL / auth type as the user edits them (token is saved on blur).
  useEffect(() => {
    if (selectedProvider !== "custom") return;
    setCustomLlmConfig(customBaseUrl, customAuthType);
  }, [selectedProvider, customBaseUrl, customAuthType, setCustomLlmConfig]);

  // Build the provider config JSON for backend calls
  // `custom` overrides a Custom field changed in this same event (its state isn't updated yet).
  const buildProviderConfig = useCallback((custom: { authType?: CustomAuthType; authValue?: string } = {}) => {
    const config: Record<string, unknown> = { provider_type: selectedProvider };
    const { llmThinking, llmExtraRequestJson } = useConfigStore.getState();
    Object.assign(
      config,
      requestOptionFields(selectedProvider, llmThinking[selectedProvider], llmExtraRequestJson[selectedProvider]),
    );
    if (apiKey) config.api_key = apiKey;
    if (selectedProvider === "custom") {
      const authType = custom.authType ?? customAuthType;
      if (customBaseUrl) config.base_url = customBaseUrl;
      if (authType !== "none") {
        config.auth_type = authType;
        config.auth_value = (custom.authValue ?? customAuthValue).trim();
      }
    }
    return JSON.stringify(config);
  }, [selectedProvider, apiKey, customBaseUrl, customAuthType, customAuthValue]);

  // Custom is the provider in use: a changed base URL, auth type or token
  // applies to it at once, not only after a restart or a provider switch.
  const applyCustomIfActive = (custom: { authType?: CustomAuthType; authValue?: string } = {}) => {
    if (selectedProvider !== "custom" || useConfigStore.getState().llmProvider !== "custom" || !customBaseUrl.trim()) return;
    setLLMProvider(buildProviderConfig(custom)).catch((e) =>
      showToast(t("legacy.custom.applyFailed", { detail: e instanceof Error ? e.message : String(e) }), "error"),
    );
  };

  // The token is saved without spaces around it (a pasted key often has some).
  const saveCustomToken = async () => {
    const token = customAuthValue.trim();
    if (token !== customAuthValue) setCustomAuthValue(token);
    await storeApiKey("custom", token).catch(() => {});
    applyCustomIfActive({ authValue: token });
  };

  const handleProviderChange = (provider: LLMProviderType) => {
    setSelectedProvider(provider);
    setSelectedModel("");
    setModels([]);
    setOpenRouterModels([]);
    setConnectionStatus("idle");
    setConnectionMessage("");
    setModelsError("");
  };

  const handleSaveApiKey = async () => {
    if (!apiKey) return;
    try {
      await storeApiKey(selectedProvider, apiKey);
      setKeyStatusMap((prev) => ({ ...prev, [selectedProvider]: true }));
    } catch {
      showToast(t("legacy.apiKey.saveFailed"), "error");
    }
  };

  // Test connection — on success, add to verifiedCloudProviders
  const handleTestConnection = async () => {
    setConnectionStatus("testing");
    setConnectionMessage("");
    try {
      if (apiKey) await storeApiKey(selectedProvider, apiKey).catch(() => {});
      const configJson = buildProviderConfig();
      const success = await testLLMConnection(configJson);
      if (LOCAL_PROVIDERS.includes(selectedProvider)) {
        setLocalReach((prev) => ({ ...prev, [selectedProvider]: success ? "up" : "down" }));
      }
      if (success) {
        setConnectionStatus("success");
        setConnectionMessage(t("legacy.connection.success"));
        // Mark as verified
        if (!verifiedCloudProviders.includes(selectedProvider)) {
          setVerifiedCloudProviders([...verifiedCloudProviders, selectedProvider]);
        }
        setKeyStatusMap((prev) => ({ ...prev, [selectedProvider]: true }));
      } else {
        setConnectionStatus("error");
        setConnectionMessage(t("legacy.connection.failed"));
      }
    } catch (err) {
      if (LOCAL_PROVIDERS.includes(selectedProvider)) {
        setLocalReach((prev) => ({ ...prev, [selectedProvider]: "down" }));
      }
      setConnectionStatus("error");
      setConnectionMessage(err instanceof Error ? err.message : t("legacy.connection.failed"));
    }
  };

  const handleLoadModels = async () => {
    setModelsLoading(true);
    setModelsError("");
    setModels([]);
    // Don't clear openRouterModels here — keep showing existing catalog during refresh
    try {
      if (apiKey) await storeApiKey(selectedProvider, apiKey).catch(() => {});

      if (selectedProvider === "openrouter") {
        // Browsing only: the key is already stored, so this never touches the active provider
        // Use enriched OpenRouter endpoint
        const orModels = await listOpenRouterModels(true);
        setOpenRouterModels(orModels);
        if (orModels.length === 0) {
          setModelsError(t("legacy.models.noText"));
        }
      } else {
        // Use generic model listing for other providers
        const configJson = buildProviderConfig();
        const modelList = await listModels(configJson);
        const chatModels = filterChatModels(modelList);
        setModels(chatModels);
        if (chatModels.length === 0) {
          setModelsError(
            modelList.length > 0
              ? t("legacy.models.noChat")
              : t("legacy.models.empty")
          );
        }
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : t("legacy.models.loadFailed"));
    } finally {
      setModelsLoading(false);
    }
  };

  const handleModelSelect = async (modelId: string) => {
    setSelectedModel(modelId);
    // Only the active provider's model is applied now; for a browsed provider
    // the selection is applied by "Set as Active Provider".
    if (selectedProvider !== llmProvider) return;
    setConfigModel(modelId, selectedProvider);
    try { await setActiveModel(selectedProvider, modelId); } catch {}
  };

  const info = PROVIDER_DISPLAY[selectedProvider];
  const requiresApiKey = info?.requiresKey ?? false;
  const isLocal = info?.isLocal ?? false;
  const isCustom = selectedProvider === "custom";
  const isClaudeCli = selectedProvider === "claude_cli";
  // Claude can be made active once the CLI is found and logged in (or while
  // its login state is unknown); it has no model of its own to pick here.
  const claudeUnusable =
    isClaudeCli && !!claudeStatus && (!claudeStatus.installed || claudeStatus.auth?.logged_in === false);

  // Same path as the footer. Without a pick, the model last used with the
  // provider; Claude takes its Fast model.
  const handleActivate = async () => {
    try {
      if (selectedProvider === "custom") {
        if (customAuthValue) await storeApiKey("custom", customAuthValue).catch(() => {});
        setCustomLlmConfig(customBaseUrl, customAuthType);
      } else if (apiKey) {
        await storeApiKey(selectedProvider, apiKey).catch(() => {});
      }
      await activateLLMProvider(selectedProvider, {
        model: selectedModel,
        providerConfig: buildProviderConfig(),
      });
    } catch (e) {
      showToast(t("legacy.inUse.failed", { detail: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  const inUseLabel = providerLabel(llmProvider);
  const selectedLabel = providerLabel(selectedProvider);

  return (
    <div className="space-y-6">
      {/* In-use provider + model banner */}
      <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-5 py-3.5">
        <Zap className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t("legacy.inUse.title", {
              provider: inUseLabel,
              detail:
                llmProvider === "claude_cli"
                  ? t("legacy.inUse.claudeTiers", {
                      fast: claudeTierLabel(claudeCliConfig.fast_model, claudeCliConfig.fast_effort, claudeModels),
                      deep: claudeTierLabel(claudeCliConfig.deep_model, claudeCliConfig.deep_effort, claudeModels),
                    })
                  : llmModel || t("legacy.inUse.noModel"),
            })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {llmProvider !== "claude_cli" && !llmModel ? t("legacy.inUse.setupHint") : t("legacy.inUse.hint")}
          </p>
        </div>
      </div>

      {/* Subscription (local CLI) providers */}
      <ClaudeCliSettings
        selected={isClaudeCli}
        active={llmProvider === "claude_cli"}
        inUseLabel={inUseLabel}
        onSelect={() => handleProviderChange("claude_cli")}
      />

      {/* Provider Selection */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("legacy.providers.title")}</h3>
        <div className="grid grid-cols-4 gap-2.5">
          {ALL_PROVIDERS.map((pType) => {
            const display = PROVIDER_DISPLAY[pType];
            const status = getProviderStatus(
              pType,
              verifiedCloudProviders,
              keyStatusMap[pType] ?? false,
              localReach[pType] ?? "checking",
              !!storedCustomBaseUrl.trim(),
            );
            return (
              <ProviderCard
                key={pType}
                name={providerLabel(pType)}
                icon={
                  display.isLocal ? (
                    <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : pType === "custom" ? (
                    <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Cloud className="h-3.5 w-3.5 text-muted-foreground" />
                  )
                }
                detail={"descriptionKey" in display ? t(display.descriptionKey) : display.description}
                status={{ label: t(status.labelKey), tone: status.tone }}
                inUse={llmProvider === pType}
                viewing={selectedProvider === pType}
                onClick={() => handleProviderChange(pType)}
              />
            );
          })}
        </div>
      </div>

      {/* Viewing a provider that isn't in use: say so, and offer the switch right here */}
      {!isClaudeCli && selectedProvider !== llmProvider && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {t("legacy.viewing.notice", { viewing: selectedLabel, inUse: inUseLabel })}
          </p>
          <button
            type="button"
            onClick={handleActivate}
            className="shrink-0 rounded-lg border border-primary/30 bg-background px-3.5 py-2 text-sm font-medium text-primary transition-all duration-150 hover:bg-primary/10 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t("legacy.viewing.use", { provider: selectedLabel })}
          </button>
        </div>
      )}

      {/* API Key Input (for cloud providers) */}
      {requiresApiKey && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("common:components.endpointFields.secret.label")}</h3>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKeyValue(e.target.value)}
                onBlur={handleSaveApiKey}
                placeholder={t("legacy.apiKey.placeholder", { provider: providerLabel(selectedProvider) })}
                maxLength={256}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                title={showApiKey ? t("legacy.apiKey.hide") : t("legacy.apiKey.show")}
                aria-label={showApiKey ? t("common:components.endpointFields.secret.hide") : t("common:components.endpointFields.secret.show")}
                aria-pressed={showApiKey}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("legacy.apiKey.storageHint")}
          </p>
        </div>
      )}

      {/* Custom Provider Config */}
      {isCustom && (
        <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="text-sm font-semibold text-primary/80">{t("legacy.custom.title")}</h3>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">{t("common:components.endpointFields.baseUrl.label")}</label>
            <input
              type="text"
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              onBlur={() => applyCustomIfActive()}
              placeholder="http://localhost:8080/v1"
              maxLength={512}
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-foreground">{t("legacy.custom.auth.label")}</label>
              <select
                value={customAuthType}
                onChange={(e) => {
                  const authType = e.target.value as CustomAuthType;
                  setCustomAuthType(authType);
                  applyCustomIfActive({ authType });
                }}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              >
                <option value="none">{t("common:components.endpointFields.auth.modes.none")}</option>
                <option value="bearer">{t("legacy.custom.auth.bearer")}</option>
                <option value="api_key">{t("legacy.custom.auth.apiKey")}</option>
              </select>
            </div>
            {customAuthType !== "none" && (
              <div className="flex-1">
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  {customAuthType === "bearer" ? t("legacy.custom.token.label") : t("common:components.endpointFields.secret.label")}
                </label>
                <input
                  type="password"
                  value={customAuthValue}
                  onChange={(e) => setCustomAuthValue(e.target.value)}
                  onBlur={() => { void saveCustomToken(); }}
                  placeholder={customAuthType === "bearer" ? t("legacy.custom.token.placeholder") : t("legacy.custom.apiKey.placeholder")}
                  maxLength={256}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Local Provider Status */}
      {isLocal && (
        <div className="flex items-center gap-3 rounded-xl border border-border/30 bg-accent/20 px-4 py-3">
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">
            {selectedProvider === "ollama"
              ? t("legacy.providers.ollama.hint")
              : t("legacy.providers.lmStudio.hint")}
          </span>
        </div>
      )}

      {/* Connection Test & Model Loading (Claude has its own above) */}
      {!isClaudeCli && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("routing.connection.label")}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === "testing" || (requiresApiKey && !apiKey) || (isCustom && !customBaseUrl)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer"
            >
              {connectionStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
              {t("legacy.connection.test")}
            </button>
            <button
              onClick={handleLoadModels}
              disabled={modelsLoading || (requiresApiKey && !apiKey) || (isCustom && !customBaseUrl)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer"
            >
              {modelsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t("legacy.models.load")}
            </button>
            {connectionStatus === "success" && (
              <div className="flex items-center gap-1 text-success">
                <CheckCircle className="h-3.5 w-3.5" />
                <span className="text-xs">{connectionMessage}</span>
              </div>
            )}
            {connectionStatus === "error" && (
              <div className="flex items-center gap-1 text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                <span className="text-xs truncate max-w-[200px]">{connectionMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Model Selection (Claude uses its Fast / Deep settings instead) */}
      {!isClaudeCli && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">{t("legacy.models.title")}</h3>
          {selectedProvider === "openrouter" && openRouterModels.length > 0 ? (
            <OpenRouterModelCatalog models={openRouterModels} />
          ) : models.length > 0 ? (
            <select
              value={selectedModel}
              onChange={(e) => handleModelSelect(e.target.value)}
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
            >
              <option value="">{t("legacy.models.placeholder")}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.context_window ? t("legacy.models.context", { size: Math.round(m.context_window / 1000) }) : ""}
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded-lg border border-border/30 bg-accent/20 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                {modelsError || (modelsLoading ? t("legacy.models.loading") : t("legacy.models.hint"))}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Thinking (how long the model reasons before answering) + advanced request JSON */}
      {!isClaudeCli && <ThinkingSettings key={selectedProvider} provider={selectedProvider} />}

      {/* Use button: only when this is not the provider in use (Claude: disabled while unusable) */}
      {selectedProvider !== llmProvider && (
        <button
          disabled={claudeUnusable}
          onClick={handleActivate}
          className="w-full rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium text-primary transition-all duration-150 hover:bg-primary/10 hover:-translate-y-px active:translate-y-px active:scale-[0.99] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t("legacy.inUse.activate", { provider: selectedLabel })}
        </button>
      )}
    </div>
  );
}
