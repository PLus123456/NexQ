// Shared form section for a user-configured HTTP endpoint (remote STT,
// embeddings, LLM connections): Base URL with the live request URL and its
// warnings, auth mode, API key and custom request headers. NexQ Plus
// contract: frozen once merged — add props, never change them.
//
// Fully controlled, and the secret never enters `value`: the component shows
// `secretStatus` and reports what the user types through `onSecretChange`.
// URL and header rules come from src/lib/endpoint.ts (the same rules as the
// Rust side), so the preview is the address the request goes to.

import { Fragment, useEffect, useId, useState } from "react";
import type React from "react";
import { CircleAlert, Eye, EyeOff, Info, Plus, X } from "lucide-react";
import { useT } from "../i18n";
import {
  addVersionPrefix,
  joinEndpoint,
  NO_AUTH,
  requestHeaders,
  stripEndpointPath,
  type AuthConfig,
  type AuthMode,
  type CustomHeader,
  type EndpointError,
  type HeaderErrorCode,
} from "../lib/endpoint";
import { cn } from "../lib/utils";

export interface EndpointFieldsValue {
  baseUrl: string;
  auth: AuthConfig;
  headers: CustomHeader[];
}

/** What the caller knows about the stored secret. */
export interface SecretStatus {
  saved: boolean;
  /** Last characters of the saved secret, e.g. "ab12". */
  hint?: string | null;
}

export interface EndpointFieldsProps {
  value: EndpointFieldsValue;
  onChange: (next: EndpointFieldsValue) => void;
  /** Fixed path previewed under the Base URL field, e.g. ENDPOINT_PATHS.chatCompletions. */
  path: string;
  /** More previewed addresses, e.g. [{ label: "Models", path: ENDPOINT_PATHS.models }]. */
  extraPaths?: { label: string; path: string }[];
  /** Show the "most OpenAI-compatible services need a version prefix" hint and the "Add /v1" button when the path is empty. Default true. */
  versionHint?: boolean;
  baseUrlPlaceholder?: string;
  /** Auth modes offered (default all three). */
  authModes?: AuthMode[];
  /** The component never stores the secret: it shows `secretStatus` and reports input through `onSecretChange` (null = clear). Omit both to hide the key input. */
  secretStatus?: SecretStatus;
  onSecretChange?: (secret: string | null) => void;
  /** Show the custom request headers editor. Default true. */
  showHeaders?: boolean;
  disabled?: boolean;
  /** Prefix for element ids (several instances on one page). */
  idPrefix?: string;
}

const ALL_AUTH_MODES: AuthMode[] = ["none", "bearer", "header"];

const LABEL = "mb-1.5 block text-xs font-medium text-foreground";
const INPUT =
  "w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_INVALID = "border-destructive/60 focus:border-destructive/60 focus:ring-destructive/20";
const SMALL_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/50 bg-secondary/30 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
const URL_TEXT = "select-text break-all font-mono text-foreground/80";

/** Text inputs that hold addresses, names and keys: no spell check or autocorrect. */
const PLAIN_TEXT = { spellCheck: false, autoCapitalize: "off", autoCorrect: "off", autoComplete: "off" } as const;

/** A fixed path as shown in notices: always with its leading `/`. */
const displayPath = (path: string) => `/${path.replace(/^\/+/, "")}`;

export function EndpointFields({
  value,
  onChange,
  path,
  extraPaths = [],
  versionHint = true,
  baseUrlPlaceholder,
  authModes = ALL_AUTH_MODES,
  secretStatus,
  onSecretChange,
  showHeaders = true,
  disabled = false,
  idPrefix,
}: EndpointFieldsProps): JSX.Element {
  const autoId = useId();
  const id = idPrefix ?? `endpoint${autoId}`;
  // Tolerate values stored before a field existed.
  const baseUrl = value.baseUrl ?? "";
  const auth = value.auth ?? NO_AUTH;
  const headers = value.headers ?? [];
  const emit = (patch: Partial<EndpointFieldsValue>) => onChange({ ...value, baseUrl, auth, headers, ...patch });
  const showSecret = (secretStatus !== undefined || onSecretChange !== undefined) && auth.mode !== "none";

  return (
    <div className="space-y-4">
      <BaseUrlField
        id={id}
        baseUrl={baseUrl}
        path={path}
        extraPaths={extraPaths}
        versionHint={versionHint}
        placeholder={baseUrlPlaceholder}
        disabled={disabled}
        onChange={(next) => emit({ baseUrl: next })}
      />
      <AuthFields id={id} auth={auth} modes={authModes} disabled={disabled} onChange={(next) => emit({ auth: next })} />
      {showSecret && (
        <SecretField id={id} status={secretStatus} onSecretChange={onSecretChange} disabled={disabled} />
      )}
      {showHeaders && (
        <HeaderRows id={id} headers={headers} disabled={disabled} onChange={(next) => emit({ headers: next })} />
      )}
    </div>
  );
}

// ── Base URL ────────────────────────────────────────────────────────────────

function BaseUrlField({
  id,
  baseUrl,
  path,
  extraPaths,
  versionHint,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  baseUrl: string;
  path: string;
  extraPaths: { label: string; path: string }[];
  versionHint: boolean;
  placeholder?: string;
  disabled: boolean;
  onChange: (baseUrl: string) => void;
}) {
  const { t } = useT("common");
  /** The path removed from a pasted full URL, until the next edit. */
  const [trimmedPath, setTrimmedPath] = useState<string | null>(null);

  const joined = joinEndpoint(baseUrl, path);
  // A blank field is just not filled in yet.
  const error = !joined.ok && joined.error.code !== "empty" ? joined.error : null;
  const inputId = `${id}-base-url`;
  const errorId = `${id}-base-url-error`;

  const edit = (next: string) => {
    setTrimmedPath(null);
    onChange(next);
  };

  // A pasted full URL (…/llm/chat/completions) is cut back to its base (…/llm).
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted) return;
    const input = e.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const next = input.value.slice(0, start) + pasted + input.value.slice(end);
    const stripped = stripEndpointPath(next, [path, ...extraPaths.map((extra) => extra.path)]);
    if (!stripped) return;
    e.preventDefault();
    onChange(stripped.base);
    setTrimmedPath(stripped.path);
  };

  return (
    <div>
      <label htmlFor={inputId} className={LABEL}>
        {t("components.endpointFields.baseUrl.label")}
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="url"
        {...PLAIN_TEXT}
        value={baseUrl}
        onChange={(e) => edit(e.target.value)}
        onPaste={handlePaste}
        placeholder={placeholder ?? t("components.endpointFields.baseUrl.placeholder")}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(INPUT, error && INPUT_INVALID)}
      />

      {error && <BaseUrlError id={errorId} error={error} disabled={disabled} onUse={edit} />}

      {joined.ok && (
        <div className="mt-2 space-y-1.5">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">{t("components.endpointFields.preview.label")}</dt>
            <dd className={URL_TEXT}>{joined.url}</dd>
            {extraPaths.map((extra, index) => {
              const extraJoined = joinEndpoint(baseUrl, extra.path);
              if (!extraJoined.ok) return null;
              return (
                <Fragment key={index}>
                  <dt className="text-muted-foreground">{extra.label}</dt>
                  <dd className={URL_TEXT}>{extraJoined.url}</dd>
                </Fragment>
              );
            })}
          </dl>

          {trimmedPath && (
            <Notice>{t("components.endpointFields.notices.trimmed", { path: displayPath(trimmedPath) })}</Notice>
          )}
          {joined.warnings.includes("already_full") && (
            <Notice>
              {t("components.endpointFields.notices.alreadyFull", { path: displayPath(path) })}
            </Notice>
          )}
          {versionHint && joined.warnings.includes("no_version_prefix") && (
            <Notice>
              {t("components.endpointFields.notices.versionHint")}
              <button
                type="button"
                onClick={() => edit(addVersionPrefix(baseUrl))}
                disabled={disabled}
                className={SMALL_BUTTON}
              >
                {t("components.endpointFields.notices.addVersionPrefix")}
              </button>
            </Notice>
          )}
        </div>
      )}
    </div>
  );
}

function BaseUrlError({
  id,
  error,
  disabled,
  onUse,
}: {
  id: string;
  error: EndpointError;
  disabled: boolean;
  onUse: (baseUrl: string) => void;
}) {
  const { t } = useT("common");
  const suggestion = error.code === "missing_scheme" ? error.suggestion : undefined;
  let message: string;
  if (error.code === "missing_scheme") message = t("components.endpointFields.errors.missingScheme");
  else if (error.code === "unsupported_scheme")
    message = t("components.endpointFields.errors.unsupportedScheme", { scheme: error.scheme ?? "" });
  else message = t("components.endpointFields.errors.invalidUrl");

  return (
    <div id={id} className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
      <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{message}</span>
      {suggestion && (
        <button type="button" onClick={() => onUse(suggestion)} disabled={disabled} className={SMALL_BUTTON}>
          {t("components.endpointFields.errors.useSuggestion", { suggestion })}
        </button>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Info className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden />
      {children}
    </div>
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────

function AuthFields({
  id,
  auth,
  modes,
  disabled,
  onChange,
}: {
  id: string;
  auth: AuthConfig;
  modes: AuthMode[];
  disabled: boolean;
  onChange: (auth: AuthConfig) => void;
}) {
  const { t } = useT("common");
  // The header that would be sent, with a stand-in for the key.
  const preview = requestHeaders(auth, t("components.endpointFields.auth.keyPlaceholder"));
  const nameError = !preview.ok && preview.error !== "invalid_header_value" ? preview.error : null;
  const sent = preview.ok ? preview.headers[0] : undefined;
  const showModes = modes.length > 1;
  if (!showModes && auth.mode === "none") return null;

  const labelId = `${id}-auth-label`;
  const nameErrorId = `${id}-header-name-error`;

  return (
    <div>
      <span id={labelId} className={LABEL}>
        {t("components.endpointFields.auth.label")}
      </span>
      {showModes && (
        <div
          role="group"
          aria-labelledby={labelId}
          className="inline-flex rounded-lg border border-border/50 bg-secondary/30 p-0.5"
        >
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={auth.mode === mode}
              disabled={disabled}
              onClick={() => onChange({ ...auth, mode })}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
                auth.mode === mode
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              {t(`components.endpointFields.auth.modes.${mode}`)}
            </button>
          ))}
        </div>
      )}

      {auth.mode === "header" && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-header-name`} className={LABEL}>
              {t("components.endpointFields.auth.headerName.label")}
            </label>
            <input
              id={`${id}-header-name`}
              type="text"
              {...PLAIN_TEXT}
              value={auth.header_name}
              onChange={(e) => onChange({ ...auth, header_name: e.target.value })}
              placeholder={t("components.endpointFields.auth.headerName.placeholder")}
              disabled={disabled}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? nameErrorId : undefined}
              className={cn(INPUT, nameError && INPUT_INVALID)}
            />
          </div>
          <div>
            <label htmlFor={`${id}-header-prefix`} className={LABEL}>
              {t("components.endpointFields.auth.prefix.label")}
            </label>
            <input
              id={`${id}-header-prefix`}
              type="text"
              {...PLAIN_TEXT}
              value={auth.prefix}
              onChange={(e) => onChange({ ...auth, prefix: e.target.value })}
              placeholder={t("components.endpointFields.auth.prefix.placeholder")}
              disabled={disabled}
              className={INPUT}
            />
          </div>
        </div>
      )}

      {nameError && (
        <p id={nameErrorId} className="mt-1.5 text-xs text-destructive">
          {t(
            nameError === "header_name_required"
              ? "components.endpointFields.auth.errors.nameRequired"
              : "components.endpointFields.auth.errors.invalidName",
          )}
        </p>
      )}
      {sent && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("components.endpointFields.auth.sentAs")}{" "}
          <code className={URL_TEXT}>
            {sent[0]}: {sent[1]}
          </code>
        </p>
      )}
    </div>
  );
}

// ── API key ─────────────────────────────────────────────────────────────────

function SecretField({
  id,
  status,
  onSecretChange,
  disabled,
}: {
  id: string;
  status?: SecretStatus;
  onSecretChange?: (secret: string | null) => void;
  disabled: boolean;
}) {
  const { t } = useT("common");
  // What the user is typing; handed over on blur / Enter, then dropped.
  const [draft, setDraft] = useState("");
  const [visible, setVisible] = useState(false);
  const inputId = `${id}-secret`;
  const hintId = `${id}-secret-hint`;

  const commit = () => {
    const secret = draft.trim();
    setDraft("");
    setVisible(false);
    if (secret) onSecretChange?.(secret);
  };

  const placeholder = status?.saved
    ? status.hint
      ? t("components.endpointFields.secret.savedWithHint", { hint: status.hint })
      : t("components.endpointFields.secret.saved")
    : t("components.endpointFields.secret.placeholder");

  return (
    <div>
      <label htmlFor={inputId} className={LABEL}>
        {t("components.endpointFields.secret.label")}
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            id={inputId}
            type={visible ? "text" : "password"}
            {...PLAIN_TEXT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            placeholder={placeholder}
            disabled={disabled || !onSecretChange}
            aria-describedby={hintId}
            className={cn(INPUT, "pr-9")}
          />
          <button
            type="button"
            // Keep focus in the input: a blur would hand the draft over.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setVisible((v) => !v)}
            disabled={disabled || !draft}
            aria-label={t(visible ? "components.endpointFields.secret.hide" : "components.endpointFields.secret.show")}
            aria-pressed={visible}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40"
          >
            {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        {status?.saved && onSecretChange && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft("");
              onSecretChange(null);
            }}
            disabled={disabled}
            className={SMALL_BUTTON}
          >
            {t("actions.clear")}
          </button>
        )}
      </div>
      <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
        {t("components.endpointFields.secret.hint")}
      </p>
    </div>
  );
}

// ── Custom headers ──────────────────────────────────────────────────────────

/** The problem with one row, by the same rules as the request (blank names are skipped). */
function rowError(header: CustomHeader): HeaderErrorCode | null {
  const result = requestHeaders(NO_AUTH, null, [header]);
  return result.ok ? null : result.error;
}

function HeaderRows({
  id,
  headers,
  disabled,
  onChange,
}: {
  id: string;
  headers: CustomHeader[];
  disabled: boolean;
  onChange: (headers: CustomHeader[]) => void;
}) {
  const { t } = useT("common");
  /** Row whose name input gets focus once it renders (after "Add header"). */
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const labelId = `${id}-headers-label`;
  const nameId = (index: number) => `${id}-header-${index}-name`;

  useEffect(() => {
    if (focusRow === null || focusRow >= headers.length) return;
    document.getElementById(`${id}-header-${focusRow}-name`)?.focus();
    setFocusRow(null);
  }, [focusRow, headers.length, id]);

  const update = (index: number, patch: Partial<CustomHeader>) =>
    onChange(headers.map((header, i) => (i === index ? { ...header, ...patch } : header)));

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="text-xs font-medium text-foreground">
          {t("components.endpointFields.headers.label")}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange([...headers, { name: "", value: "" }]);
            setFocusRow(headers.length);
          }}
          disabled={disabled}
          className={SMALL_BUTTON}
        >
          <Plus className="h-3 w-3" aria-hidden />
          {t("components.endpointFields.headers.add")}
        </button>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("components.endpointFields.headers.hint")}</p>

      {headers.length > 0 && (
        <div role="group" aria-labelledby={labelId} className="mt-2 space-y-2">
          {headers.map((header, index) => {
            const error = rowError(header);
            const errorId = `${id}-header-${index}-error`;
            const name = header.name.trim();
            return (
              <div key={index}>
                <div className="flex items-center gap-2">
                  <input
                    id={nameId(index)}
                    type="text"
                    {...PLAIN_TEXT}
                    value={header.name}
                    onChange={(e) => update(index, { name: e.target.value })}
                    placeholder={t("components.endpointFields.headers.namePlaceholder")}
                    aria-label={t("components.endpointFields.headers.namePlaceholder")}
                    disabled={disabled}
                    aria-invalid={error === "invalid_header_name" ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className={cn(INPUT, "min-w-0 flex-[2]", error === "invalid_header_name" && INPUT_INVALID)}
                  />
                  <input
                    id={`${id}-header-${index}-value`}
                    type="text"
                    {...PLAIN_TEXT}
                    value={header.value}
                    onChange={(e) => update(index, { value: e.target.value })}
                    placeholder={t("components.endpointFields.headers.valuePlaceholder")}
                    aria-label={t("components.endpointFields.headers.valuePlaceholder")}
                    disabled={disabled}
                    aria-invalid={error === "invalid_header_value" ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className={cn(INPUT, "min-w-0 flex-[3]", error === "invalid_header_value" && INPUT_INVALID)}
                  />
                  <button
                    type="button"
                    onClick={() => onChange(headers.filter((_, i) => i !== index))}
                    disabled={disabled}
                    aria-label={
                      name
                        ? t("components.endpointFields.headers.removeNamed", { name })
                        : t("components.endpointFields.headers.remove")
                    }
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                {error && (
                  <p id={errorId} className="mt-1 text-xs text-destructive">
                    {t(
                      error === "invalid_header_value"
                        ? "components.endpointFields.headers.invalidValue"
                        : "components.endpointFields.headers.invalidName",
                    )}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
