//! Endpoint address rules and auth headers for user-configured HTTP services
//! (LLM connections, remote STT, embeddings, rerank). NexQ Plus contract:
//! frozen once merged — add, never change.
//!
//! The URL rules are mirrored by `src/lib/endpoint.ts`; both sides run the
//! cases in `src/lib/endpointCases.json`, so the address the settings page
//! previews is the address the request goes to. The base URL is used as typed
//! (version prefix included): `/v1` is never added automatically.

use std::fmt;
use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use url::{Position, Url};

use crate::llm::api::LlmKind;

// ── Connections (filled by the LLM package) ─────────────────────────────────

/// An LLM connection resolved for direct HTTP use (the RAG package reuses a
/// connection for embeddings / rerank). `headers` carry the secret, already
/// read from the keychain: never log them unmasked (`Debug` masks them).
#[derive(Clone)]
pub struct ResolvedConnection {
    pub id: String,
    pub kind: LlmKind,
    /// As the user typed it, normalized (trimmed, no trailing `/`).
    pub base_url: String,
    /// Auth header plus custom headers.
    pub headers: Vec<(String, String)>,
    pub timeout: Option<Duration>,
}

impl fmt::Debug for ResolvedConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(name, _)| (name.as_str(), "***"))
            .collect();
        f.debug_struct("ResolvedConnection")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("base_url", &self.base_url)
            .field("headers", &headers)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// A connection as listed to other packages (no secrets).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub kind: LlmKind,
    pub base_url: String,
}

// ── Auth ────────────────────────────────────────────────────────────────────

/// How the secret is sent. JSON: `"none" | "bearer" | "header"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// No auth header.
    #[default]
    None,
    /// `Authorization: Bearer <secret>`.
    Bearer,
    /// `<header_name>: [<prefix> ]<secret>`, e.g. `api-key: <secret>`.
    Header,
}

/// Auth settings (the secret itself lives in the keychain).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    pub mode: AuthMode,
    /// Header name for `AuthMode::Header`.
    pub header_name: String,
    /// Optional value prefix for `AuthMode::Header` (`"Token"` → `Token <secret>`).
    pub prefix: String,
}

/// A custom request header. Values are plain settings, never secrets
/// (secrets go through the auth fields).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomHeader {
    pub name: String,
    pub value: String,
}

// ── Endpoint addresses ──────────────────────────────────────────────────────

/// Fixed paths appended to a base URL.
pub const CHAT_COMPLETIONS_PATH: &str = "/chat/completions";
pub const MODELS_PATH: &str = "/models";
pub const AUDIO_TRANSCRIPTIONS_PATH: &str = "/audio/transcriptions";
pub const EMBEDDINGS_PATH: &str = "/embeddings";
pub const RERANK_PATH: &str = "/rerank";

/// A note about a joined endpoint. JSON: `"already_full" | "no_version_prefix"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointWarning {
    /// The base URL already ends with the path, so nothing was appended.
    AlreadyFull,
    /// The base URL has no path. Most OpenAI-compatible services need a
    /// version prefix such as `/v1`, which is never added automatically.
    NoVersionPrefix,
}

impl EndpointWarning {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AlreadyFull => "already_full",
            Self::NoVersionPrefix => "no_version_prefix",
        }
    }
}

/// Why a base URL was rejected. JSON: `{"code": "missing_scheme", "suggestion": "…"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum EndpointError {
    /// Blank input.
    Empty,
    /// No `http://` / `https://`; `suggestion` is the input with a guessed scheme.
    MissingScheme { suggestion: String },
    /// Another scheme (`ftp`, `ws`, …), lowercased.
    UnsupportedScheme { scheme: String },
    /// Rejected by the URL parser; `detail` is its message (English, not shown
    /// by the settings page).
    InvalidUrl { detail: String },
}

impl EndpointError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::MissingScheme { .. } => "missing_scheme",
            Self::UnsupportedScheme { .. } => "unsupported_scheme",
            Self::InvalidUrl { .. } => "invalid_url",
        }
    }
}

impl fmt::Display for EndpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "Base URL is empty"),
            Self::MissingScheme { suggestion } => write!(
                f,
                "Base URL must start with http:// or https:// (try {suggestion})"
            ),
            Self::UnsupportedScheme { scheme } => write!(
                f,
                "Base URL must start with http:// or https://, not {scheme}://"
            ),
            Self::InvalidUrl { detail } => write!(f, "Invalid base URL: {detail}"),
        }
    }
}

impl std::error::Error for EndpointError {}

impl From<EndpointError> for String {
    fn from(err: EndpointError) -> Self {
        err.to_string()
    }
}

/// A base URL checked by [`normalize_base_url`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedBase {
    /// Parsed; fragment and empty query dropped, trailing `/` stripped (a
    /// host-only URL keeps the root `/`).
    pub url: Url,
    /// `scheme://[userinfo@]host[:port]<path>[?query]` without a trailing `/`
    /// (`http://192.168.1.10:8000` for a host-only URL).
    pub base: String,
    /// No path: the user typed only the host.
    pub path_empty: bool,
}

/// Trims and checks a base URL: `http://` / `https://` only, fragment and
/// empty query dropped, query kept, trailing `/` stripped. The path, version
/// prefix included, stays as typed.
pub fn normalize_base_url(input: &str) -> Result<NormalizedBase, EndpointError> {
    let input = trim_ws(input);
    if input.is_empty() {
        return Err(EndpointError::Empty);
    }
    // Checked as text first: `localhost:11434` parses as scheme "localhost".
    if !starts_with_ignore_case(input, "http://") && !starts_with_ignore_case(input, "https://") {
        return Err(match explicit_scheme(input) {
            Some(scheme) => EndpointError::UnsupportedScheme { scheme },
            None => EndpointError::MissingScheme {
                suggestion: format!("{}://{input}", guess_scheme(input)),
            },
        });
    }
    let mut url = Url::parse(input).map_err(|e| EndpointError::InvalidUrl {
        detail: e.to_string(),
    })?;
    if url.host_str().is_none_or(str::is_empty) {
        return Err(EndpointError::InvalidUrl {
            detail: "empty host".to_string(),
        });
    }
    url.set_fragment(None);
    if url.query() == Some("") {
        url.set_query(None);
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { path.as_str() });
    Ok(NormalizedBase {
        base: base_string(&url, &path),
        path_empty: path.is_empty(),
        url,
    })
}

/// The address a request goes to: `base_url` + `path` (e.g.
/// [`CHAT_COMPLETIONS_PATH`]), query kept. A base URL that already ends with
/// `path` is used as is; an empty `path` gives the base URL itself.
pub fn join_endpoint(base_url: &str, path: &str) -> Result<Url, EndpointError> {
    join(base_url, path).map(|(url, _)| url)
}

/// What the settings page shows under a base URL field. JSON:
/// `{"url": "…" | null, "warnings": […], "error": {"code": …} | null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EndpointPreview {
    pub url: Option<String>,
    pub warnings: Vec<EndpointWarning>,
    pub error: Option<EndpointError>,
}

/// [`join_endpoint`] plus its warnings, as a plain value.
pub fn preview_endpoint(base_url: &str, path: &str) -> EndpointPreview {
    match join(base_url, path) {
        Ok((url, warnings)) => EndpointPreview {
            url: Some(url.into()),
            warnings,
            error: None,
        },
        Err(err) => EndpointPreview {
            url: None,
            warnings: Vec::new(),
            error: Some(err),
        },
    }
}

/// For a full endpoint URL pasted into a base URL field: the base before the
/// first of `paths` it ends with, and that path
/// (`…/llm/chat/completions` → `…/llm`). `None` if none matches or `input`
/// is invalid.
pub fn strip_endpoint_path<'a>(input: &str, paths: &[&'a str]) -> Option<(String, &'a str)> {
    let NormalizedBase { url, .. } = normalize_base_url(input).ok()?;
    let current = url.path().trim_end_matches('/');
    paths.iter().find_map(|&path| {
        let rest = strip_segments(current, path)?;
        Some((base_string(&url, rest.trim_end_matches('/')), path))
    })
}

/// The normalized base URL with `prefix` (normally `/v1`) appended to its
/// path, for the "Add /v1" button. Invalid input comes back unchanged.
pub fn add_version_prefix(base_url: &str, prefix: &str) -> String {
    let Ok(NormalizedBase { mut url, base, .. }) = normalize_base_url(base_url) else {
        return base_url.to_string();
    };
    let prefix = prefix.trim_matches('/');
    if prefix.is_empty() {
        return base;
    }
    let path = format!("{}/{prefix}", url.path().trim_end_matches('/'));
    url.set_path(&path);
    base_string(&url, url.path().trim_end_matches('/'))
}

fn join(base_url: &str, path: &str) -> Result<(Url, Vec<EndpointWarning>), EndpointError> {
    let NormalizedBase {
        mut url,
        path_empty,
        ..
    } = normalize_base_url(base_url)?;
    let suffix = path.trim_start_matches('/');
    if !suffix.is_empty() {
        let current = url.path().trim_end_matches('/').to_string();
        if strip_segments(&current, suffix).is_some() {
            return Ok((url, vec![EndpointWarning::AlreadyFull]));
        }
        url.set_path(&format!("{current}/{suffix}"));
    }
    let warnings = if path_empty {
        vec![EndpointWarning::NoVersionPrefix]
    } else {
        Vec::new()
    };
    Ok((url, warnings))
}

/// `path` without a trailing `/<suffix>` (whole segments, case-sensitive).
fn strip_segments<'p>(path: &'p str, suffix: &str) -> Option<&'p str> {
    let suffix = suffix.trim_start_matches('/');
    if suffix.is_empty() {
        return None;
    }
    path.strip_suffix(suffix)?.strip_suffix('/')
}

/// `scheme://[userinfo@]host[:port]` + `path` + `?query`.
fn base_string(url: &Url, path: &str) -> String {
    let mut base = format!("{}{path}", &url[..Position::BeforePath]);
    if let Some(query) = url.query() {
        base.push('?');
        base.push_str(query);
    }
    base
}

/// Trims what JavaScript's `trim()` trims, plus U+0085, so that both sides
/// see the same input.
fn trim_ws(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// The scheme before `://`, lowercased, if the text there is one (in
/// `host/?next=http://x` it isn't).
fn explicit_scheme(input: &str) -> Option<String> {
    let (scheme, _) = input.split_once("://")?;
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then(|| scheme.to_ascii_lowercase())
}

/// `http` for local-looking hosts (localhost, `*.local`, `*.localhost`,
/// private IPv4, IPv6 literals) or an explicit port other than 443, else
/// `https`.
fn guess_scheme(input: &str) -> &'static str {
    let authority = input.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, rest)| rest);
    if host_port.starts_with('[') {
        return "http";
    }
    let (host, port) = host_port.rsplit_once(':').unwrap_or((host_port, ""));
    let host = host.to_ascii_lowercase();
    let local = host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".localhost")
        || is_private_ipv4(&host);
    if local || (!port.is_empty() && port != "443") {
        "http"
    } else {
        "https"
    }
}

/// Dotted-quad loopback or private IPv4: 127/8, 10/8, 172.16/12, 192.168/16.
fn is_private_ipv4(host: &str) -> bool {
    let octets: Option<Vec<u8>> = host.split('.').map(octet).collect();
    matches!(
        octets.as_deref(),
        Some([127, _, _, _] | [10, _, _, _] | [192, 168, _, _] | [172, 16..=31, _, _])
    )
}

/// One to three decimal digits, at most 255.
fn octet(part: &str) -> Option<u8> {
    if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

// ── Headers ─────────────────────────────────────────────────────────────────

/// Why the auth or custom headers can't be built. Carries the header name,
/// never the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    /// `AuthMode::Header` with a blank header name.
    NameRequired,
    /// Not an RFC 7230 token.
    InvalidName(String),
    /// The value contains a line break or another control character.
    InvalidValue(String),
}

impl HeaderError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NameRequired => "header_name_required",
            Self::InvalidName(_) => "invalid_header_name",
            Self::InvalidValue(_) => "invalid_header_value",
        }
    }
}

impl fmt::Display for HeaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NameRequired => write!(f, "A header name is required for header authentication"),
            Self::InvalidName(name) => write!(f, "Invalid header name \"{name}\""),
            Self::InvalidValue(name) => write!(
                f,
                "The value of header \"{name}\" contains a line break or control character"
            ),
        }
    }
}

impl std::error::Error for HeaderError {}

impl From<HeaderError> for String {
    fn from(err: HeaderError) -> Self {
        err.to_string()
    }
}

/// An RFC 7230 token: letters, digits and ``!#$%&'*+-.^_`|~``. Not trimmed.
pub fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// Header names whose values are secrets: marked sensitive when sent, and
/// to be masked in logs.
pub fn is_sensitive_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "cookie"
        || ["auth", "key", "token", "secret", "password"]
            .iter()
            .any(|word| name.contains(word))
}

/// The auth header for `auth` with `secret` (trimmed). No secret means no
/// header and no error (keys are optional for self-hosted services); a
/// header-mode name is checked either way.
pub fn auth_headers(
    auth: &AuthConfig,
    secret: Option<&str>,
) -> Result<Vec<(String, String)>, HeaderError> {
    let (name, prefix) = match auth.mode {
        AuthMode::None => return Ok(Vec::new()),
        AuthMode::Bearer => ("Authorization", "Bearer"),
        AuthMode::Header => (
            header_name(&auth.header_name)?.ok_or(HeaderError::NameRequired)?,
            trim_ws(&auth.prefix),
        ),
    };
    let secret = secret.map(trim_ws).unwrap_or_default();
    if secret.is_empty() {
        return Ok(Vec::new());
    }
    let value = if prefix.is_empty() {
        secret.to_string()
    } else {
        format!("{prefix} {secret}")
    };
    Ok(vec![header(name, value)?])
}

/// The auth header, then the custom headers in order (names and values
/// trimmed, blank names skipped).
pub fn request_headers(
    auth: &AuthConfig,
    secret: Option<&str>,
    custom: &[CustomHeader],
) -> Result<Vec<(String, String)>, HeaderError> {
    let mut headers = auth_headers(auth, secret)?;
    headers.extend(custom_headers(custom)?);
    Ok(headers)
}

/// Adds checked headers (from [`request_headers`] or
/// [`ResolvedConnection::headers`]) to `req`, marking secret-looking names
/// sensitive. Pairs that don't convert are skipped.
pub fn apply_headers(
    req: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    append_headers(req, headers, false)
}

/// [`request_headers`] + [`apply_headers`]. The auth header is marked
/// sensitive whatever its name.
pub fn apply_auth(
    req: reqwest::RequestBuilder,
    auth: &AuthConfig,
    secret: Option<&str>,
    custom: &[CustomHeader],
) -> Result<reqwest::RequestBuilder, HeaderError> {
    let auth = auth_headers(auth, secret)?;
    let custom = custom_headers(custom)?;
    let req = append_headers(req, &auth, true);
    Ok(append_headers(req, &custom, false))
}

fn custom_headers(custom: &[CustomHeader]) -> Result<Vec<(String, String)>, HeaderError> {
    let mut headers = Vec::with_capacity(custom.len());
    for entry in custom {
        if let Some(name) = header_name(&entry.name)? {
            headers.push(header(name, trim_ws(&entry.value).to_string())?);
        }
    }
    Ok(headers)
}

/// The trimmed name; `None` when blank.
fn header_name(raw: &str) -> Result<Option<&str>, HeaderError> {
    let name = trim_ws(raw);
    if name.is_empty() {
        Ok(None)
    } else if is_valid_header_name(name) {
        Ok(Some(name))
    } else {
        Err(HeaderError::InvalidName(name.to_string()))
    }
}

/// Rejects the control characters `HeaderValue` rejects (all but tab): CR
/// or LF would also split the header.
fn header(name: &str, value: String) -> Result<(String, String), HeaderError> {
    if value.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f) {
        return Err(HeaderError::InvalidValue(name.to_string()));
    }
    Ok((name.to_string(), value))
}

fn append_headers(
    mut req: reqwest::RequestBuilder,
    headers: &[(String, String)],
    secret: bool,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        let (Ok(name), Ok(mut value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) else {
            continue;
        };
        if secret || is_sensitive_header(name.as_str()) {
            value.set_sensitive(true);
        }
        req = req.header(name, value);
    }
    req
}

// ── Redaction ───────────────────────────────────────────────────────────────

/// Query parameters [`redact_url`] masks (names compared case-insensitively).
const SECRET_QUERY_PARAMS: &[&str] = &[
    "key",
    "api_key",
    "apikey",
    "api-key",
    "token",
    "access_token",
    "auth",
    "sig",
    "signature",
    "secret",
    "password",
];

/// `url` for error messages and logs: a userinfo password and the values of
/// secret query parameters (`key`, `token`, `sig`, …) become `***`, and so
/// does a username without a password (`https://TOKEN@host`, a token put in
/// the username slot). Input that doesn't parse, or has nothing to mask,
/// comes back unchanged.
pub fn redact_url(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_string();
    };
    let mut masked = false;
    if parsed
        .password()
        .is_some_and(|password| !password.is_empty())
    {
        masked |= parsed.set_password(Some("***")).is_ok();
    } else if !parsed.username().is_empty() {
        masked |= parsed.set_username("***").is_ok();
    }
    if let Some(query) = parsed.query().and_then(mask_query) {
        parsed.set_query(Some(&query));
        masked = true;
    }
    if masked {
        parsed.into()
    } else {
        url.to_string()
    }
}

/// `query` with secret parameter values replaced; `None` if it has none.
/// Other parameters keep their original encoding.
fn mask_query(query: &str) -> Option<String> {
    let mut masked = false;
    let pairs: Vec<String> = query
        .split('&')
        .map(|pair| {
            let raw_name = pair.split_once('=').map_or(pair, |(name, _)| name);
            let secret = url::form_urlencoded::parse(raw_name.as_bytes())
                .next()
                .is_some_and(|(name, _)| {
                    SECRET_QUERY_PARAMS.contains(&name.to_ascii_lowercase().as_str())
                });
            if secret {
                masked = true;
                format!("{raw_name}=***")
            } else {
                pair.to_string()
            }
        })
        .collect();
    masked.then(|| pairs.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Run by `src/lib/endpoint.test.ts` too.
    const CASES: &str = include_str!("../../../src/lib/endpointCases.json");

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Cases {
        version: u32,
        #[serde(rename = "description")]
        _description: String,
        join: Vec<JoinCase>,
        normalize: Vec<NormalizeCase>,
        strip: Vec<StripCase>,
        add_version_prefix: Vec<PrefixCase>,
        header_names: Vec<HeaderNameCase>,
        headers: Vec<HeadersCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct JoinCase {
        name: String,
        base: String,
        path: String,
        url: Option<String>,
        #[serde(default)]
        warnings: Vec<String>,
        error: Option<String>,
        suggestion: Option<String>,
        scheme: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct NormalizeCase {
        name: String,
        input: String,
        base: Option<String>,
        path_empty: Option<bool>,
        error: Option<String>,
        suggestion: Option<String>,
        scheme: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StripCase {
        name: String,
        input: String,
        paths: Vec<String>,
        result: Option<StripResult>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StripResult {
        base: String,
        path: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PrefixCase {
        name: String,
        base: String,
        prefix: Option<String>,
        result: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct HeaderNameCase {
        header: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct HeadersCase {
        name: String,
        auth: AuthConfig,
        secret: Option<String>,
        #[serde(default)]
        custom: Vec<CustomHeader>,
        headers: Option<Vec<(String, String)>>,
        error: Option<String>,
        error_header: Option<String>,
    }

    fn cases() -> Cases {
        let cases: Cases = serde_json::from_str(CASES).expect("src/lib/endpointCases.json");
        assert_eq!(cases.version, 1);
        cases
    }

    fn assert_endpoint_error(
        case: &str,
        err: &EndpointError,
        code: &str,
        suggestion: Option<&str>,
        scheme: Option<&str>,
    ) {
        assert_eq!(err.code(), code, "{case}: {err}");
        match err {
            EndpointError::MissingScheme { suggestion: got } => {
                assert_eq!(Some(got.as_str()), suggestion, "{case}: suggestion")
            }
            EndpointError::UnsupportedScheme { scheme: got } => {
                assert_eq!(Some(got.as_str()), scheme, "{case}: scheme")
            }
            _ => {}
        }
    }

    #[test]
    fn shared_join_cases() {
        for case in cases().join {
            let name = case.name.as_str();
            let joined = join_endpoint(&case.base, &case.path);
            let preview = preview_endpoint(&case.base, &case.path);
            match (&case.url, &case.error) {
                (Some(url), None) => {
                    let joined = joined.unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(joined.as_str(), url, "{name}");
                    assert_eq!(
                        preview.url.as_deref(),
                        Some(url.as_str()),
                        "{name}: preview"
                    );
                    let warnings: Vec<&str> =
                        preview.warnings.iter().map(EndpointWarning::code).collect();
                    assert_eq!(warnings, case.warnings, "{name}: warnings");
                    assert_eq!(preview.error, None, "{name}: preview");
                }
                (None, Some(code)) => {
                    let err = joined.expect_err(name);
                    let (suggestion, scheme) = (case.suggestion.as_deref(), case.scheme.as_deref());
                    assert_endpoint_error(name, &err, code, suggestion, scheme);
                    assert!(case.warnings.is_empty(), "{name}: errors have no warnings");
                    assert_eq!(preview.error.as_ref(), Some(&err), "{name}: preview");
                    assert_eq!(preview.url, None, "{name}: preview");
                    assert!(preview.warnings.is_empty(), "{name}: preview");
                }
                _ => panic!("{name}: give either url or error"),
            }
        }
    }

    #[test]
    fn shared_normalize_cases() {
        for case in cases().normalize {
            let name = case.name.as_str();
            let normalized = normalize_base_url(&case.input);
            match (&case.base, &case.error) {
                (Some(base), None) => {
                    let normalized = normalized.unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(&normalized.base, base, "{name}");
                    assert_eq!(
                        Some(normalized.path_empty),
                        case.path_empty,
                        "{name}: path_empty"
                    );
                }
                (None, Some(code)) => {
                    let err = normalized.expect_err(name);
                    let (suggestion, scheme) = (case.suggestion.as_deref(), case.scheme.as_deref());
                    assert_endpoint_error(name, &err, code, suggestion, scheme);
                }
                _ => panic!("{name}: give either base or error"),
            }
        }
    }

    #[test]
    fn shared_strip_cases() {
        for case in cases().strip {
            let paths: Vec<&str> = case.paths.iter().map(String::as_str).collect();
            let expected = case
                .result
                .as_ref()
                .map(|r| (r.base.clone(), r.path.as_str()));
            assert_eq!(
                strip_endpoint_path(&case.input, &paths),
                expected,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn shared_version_prefix_cases() {
        for case in cases().add_version_prefix {
            let prefix = case.prefix.as_deref().unwrap_or("/v1");
            assert_eq!(
                add_version_prefix(&case.base, prefix),
                case.result,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn shared_header_name_cases() {
        for case in cases().header_names {
            assert_eq!(
                is_valid_header_name(&case.header),
                case.valid,
                "{:?}",
                case.header
            );
        }
    }

    #[test]
    fn shared_header_cases() {
        for case in cases().headers {
            let name = case.name.as_str();
            let headers = request_headers(&case.auth, case.secret.as_deref(), &case.custom);
            match (&case.headers, &case.error) {
                (Some(expected), None) => assert_eq!(headers.as_ref(), Ok(expected), "{name}"),
                (None, Some(code)) => {
                    let err = headers.expect_err(name);
                    assert_eq!(err.code(), code, "{name}");
                    let header = match &err {
                        HeaderError::NameRequired => None,
                        HeaderError::InvalidName(h) | HeaderError::InvalidValue(h) => {
                            Some(h.as_str())
                        }
                    };
                    assert_eq!(header, case.error_header.as_deref(), "{name}: header");
                }
                _ => panic!("{name}: give either headers or error"),
            }
        }
    }

    #[test]
    fn errors_serialize_with_a_code_tag() {
        let to_json = |err: EndpointError| serde_json::to_value(err).unwrap();
        assert_eq!(to_json(EndpointError::Empty), json!({ "code": "empty" }));
        assert_eq!(
            to_json(EndpointError::MissingScheme {
                suggestion: "https://h.example".into()
            }),
            json!({ "code": "missing_scheme", "suggestion": "https://h.example" })
        );
        assert_eq!(
            to_json(EndpointError::UnsupportedScheme {
                scheme: "ftp".into()
            }),
            json!({ "code": "unsupported_scheme", "scheme": "ftp" })
        );
        assert_eq!(
            to_json(EndpointError::InvalidUrl {
                detail: "empty host".into()
            }),
            json!({ "code": "invalid_url", "detail": "empty host" })
        );
    }

    #[test]
    fn preview_serializes_for_the_settings_page() {
        let ok = preview_endpoint("http://192.168.1.10:8000", AUDIO_TRANSCRIPTIONS_PATH);
        assert_eq!(
            serde_json::to_value(ok).unwrap(),
            json!({
                "url": "http://192.168.1.10:8000/audio/transcriptions",
                "warnings": ["no_version_prefix"],
                "error": null,
            })
        );
        let err = preview_endpoint("localhost:11434", CHAT_COMPLETIONS_PATH);
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            json!({
                "url": null,
                "warnings": [],
                "error": { "code": "missing_scheme", "suggestion": "http://localhost:11434" },
            })
        );
    }

    #[test]
    fn error_messages() {
        assert_eq!(
            normalize_base_url("api.example.com/v1")
                .unwrap_err()
                .to_string(),
            "Base URL must start with http:// or https:// (try https://api.example.com/v1)"
        );
        assert_eq!(String::from(EndpointError::Empty), "Base URL is empty");
        assert!(normalize_base_url("http://")
            .unwrap_err()
            .to_string()
            .starts_with("Invalid base URL: "));
        assert_eq!(
            String::from(HeaderError::InvalidName("bad name".into())),
            "Invalid header name \"bad name\""
        );
    }

    #[test]
    fn normalized_url_matches_the_base_string() {
        let base = normalize_base_url(" https://h.example/v1/?a=1#x ").unwrap();
        assert_eq!(base.url.as_str(), "https://h.example/v1?a=1");
        assert_eq!(base.base, "https://h.example/v1?a=1");
        assert!(!base.path_empty);

        let host_only = normalize_base_url("http://h.example:8000").unwrap();
        assert_eq!(host_only.url.as_str(), "http://h.example:8000/");
        assert_eq!(host_only.base, "http://h.example:8000");
        assert!(host_only.path_empty);
    }

    #[test]
    fn strip_returns_the_matching_path() {
        let paths = [MODELS_PATH, CHAT_COMPLETIONS_PATH];
        let stripped = strip_endpoint_path("https://gw.example.com/llm/chat/completions", &paths);
        assert_eq!(
            stripped,
            Some((
                "https://gw.example.com/llm".to_string(),
                CHAT_COMPLETIONS_PATH
            ))
        );
    }

    #[test]
    fn apply_auth_marks_the_secret_sensitive() {
        let auth = AuthConfig {
            mode: AuthMode::Header,
            header_name: "X-Custom".into(),
            prefix: String::new(),
        };
        let custom = [
            CustomHeader {
                name: "X-Org".into(),
                value: "acme".into(),
            },
            CustomHeader {
                name: "X-Session-Token".into(),
                value: "t".into(),
            },
        ];
        let req = reqwest::Client::new().get("https://h.example/v1/models");
        let req = apply_auth(req, &auth, Some("sk-test"), &custom)
            .unwrap()
            .build()
            .unwrap();
        let headers = req.headers();
        assert_eq!(headers["x-custom"], "sk-test");
        assert!(
            headers["x-custom"].is_sensitive(),
            "the auth header, whatever its name"
        );
        assert_eq!(headers["x-org"], "acme");
        assert!(!headers["x-org"].is_sensitive());
        assert!(headers["x-session-token"].is_sensitive());
    }

    #[test]
    fn apply_headers_marks_by_name_and_skips_bad_pairs() {
        let pairs: Vec<(String, String)> = [
            ("Authorization", "Bearer sk-test"),
            ("x-goog-api-key", "AIza"),
            ("bad name", "x"),
            ("X-Bad-Value", "a\nb"),
            ("X-Trace", "1"),
        ]
        .iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
        let req = reqwest::Client::new().get("https://h.example/");
        let req = apply_headers(req, &pairs).build().unwrap();
        let headers = req.headers();
        assert_eq!(headers.len(), 3);
        assert!(headers["authorization"].is_sensitive());
        assert!(headers["x-goog-api-key"].is_sensitive());
        assert!(!headers["x-trace"].is_sensitive());
    }

    #[test]
    fn apply_auth_rejects_an_incomplete_header_config() {
        let auth = AuthConfig {
            mode: AuthMode::Header,
            ..Default::default()
        };
        let req = reqwest::Client::new().get("https://h.example/");
        let err = apply_auth(req, &auth, Some("sk-test"), &[]).unwrap_err();
        assert_eq!(err, HeaderError::NameRequired);
        assert_eq!(err.code(), "header_name_required");
    }

    #[test]
    fn sensitive_header_names() {
        for name in [
            "Authorization",
            "Proxy-Authorization",
            "Cookie",
            "api-key",
            "X-API-Key",
            "x-goog-api-key",
            "X-Access-Token",
            "x-client-secret",
            "X-Auth",
        ] {
            assert!(is_sensitive_header(name), "{name}");
        }
        for name in ["Content-Type", "X-Org", "User-Agent", "Accept"] {
            assert!(!is_sensitive_header(name), "{name}");
        }
    }

    #[test]
    fn redact_url_masks_passwords_and_secret_parameters() {
        assert_eq!(
            redact_url(
                "https://user:hunter2@h.example/v1?api-version=2024-10-21&key=abc&Token=xyz"
            ),
            "https://user:***@h.example/v1?api-version=2024-10-21&key=***&Token=***"
        );
        assert_eq!(
            redact_url("https://generativelanguage.googleapis.com/v1beta/models?key=AIza123"),
            "https://generativelanguage.googleapis.com/v1beta/models?key=***"
        );
        assert_eq!(
            redact_url("https://h.example/v1?api%5Fkey=abc&sig&q=a%20b"),
            "https://h.example/v1?api%5Fkey=***&sig=***&q=a%20b"
        );
        assert_eq!(
            redact_url("https://h.example/v1?signature=s#frag"),
            "https://h.example/v1?signature=***#frag"
        );
        assert_eq!(
            redact_url("https://sk-live-123@h.example/v1"),
            "https://***@h.example/v1"
        );
        assert_eq!(
            redact_url("https://sk-live-123:@h.example/v1?key=abc"),
            "https://***@h.example/v1?key=***"
        );
    }

    #[test]
    fn redact_url_leaves_other_urls_alone() {
        for url in [
            "HTTPS://H.EXAMPLE/v1?model=gpt-4o",
            "https://h.example/v1?keyword=x&monkey=1",
            "not a url",
            "",
        ] {
            assert_eq!(redact_url(url), url);
        }
    }
}
