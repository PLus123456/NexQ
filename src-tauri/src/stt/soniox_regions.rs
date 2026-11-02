// NexQ Plus: which Soniox region a session talks to.
//
// A key belongs to one region (its Soniox project's), so each region has its
// own keychain slot (`soniox_us`…); the old `soniox` slot counts as the key of
// `SonioxConfig::legacy_region`. A session's candidates are the regions it may use
// that have a key: `region` alone (`fixed`), the enabled ones fastest first
// (`auto`, from the latency test) or in the user's order (`ordered`); a
// region that was full a moment ago goes last for five minutes. When a
// connection fails, `RegionRouter` decides from the Soniox error whether the
// next region could help (full, down, model missing, key refused…), whether
// nothing will (an organization-wide limit or budget) or whether to just
// reconnect. Also here: the latency test (no key, cached ~10 min) and finding
// which region a pasted key belongs to.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::stt::plus_config::{
    soniox_key_slot, soniox_region, soniox_region_rest_base, soniox_region_ws_url, SonioxConfig, SonioxRegionMode,
    SONIOX_REGIONS,
};
use crate::stt::soniox_protocol::{RetryClass, SonioxError};

/// A region that was full stays at the end of the candidates this long.
pub const FULL_COOLDOWN: Duration = Duration::from_secs(5 * 60);
/// Latency measurements are reused this long.
pub const LATENCY_TTL: Duration = Duration::from_secs(10 * 60);
/// At meeting start, `auto` waits this long for a stale latency test.
pub const SESSION_LATENCY_BUDGET: Duration = Duration::from_millis(1200);
const LATENCY_TRIES: usize = 3;
const LATENCY_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const DETECT_TIMEOUT: Duration = Duration::from_secs(8);

// ── Keys ────────────────────────────────────────────────────────────────────

/// The Soniox keys a session can use.
#[derive(Clone, Default)]
pub struct RegionKeys {
    /// Keys from the regions' own slots.
    pub per_region: HashMap<String, String>,
    /// The old `soniox` slot, used for `legacy_region`.
    pub legacy: Option<String>,
    pub legacy_region: String,
}

impl std::fmt::Debug for RegionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut regions: Vec<&String> = self.per_region.keys().collect();
        regions.sort();
        f.debug_struct("RegionKeys")
            .field("per_region", &regions)
            .field("legacy", &self.legacy.is_some())
            .field("legacy_region", &self.legacy_region)
            .finish()
    }
}

impl RegionKeys {
    /// The key for `region`: its own slot, else the old slot when it is `legacy_region`'s.
    pub fn key_for(&self, region: &str) -> Option<&str> {
        let own = self.per_region.get(region).map(String::as_str).filter(|k| !k.trim().is_empty());
        own.or_else(|| {
            (region == self.legacy_region).then_some(self.legacy.as_deref()).flatten().filter(|k| !k.trim().is_empty())
        })
    }

    /// The slots a session must read for `cfg`: the regions it may use.
    pub fn slots_needed(cfg: &SonioxConfig) -> Vec<(&'static str, String)> {
        let regions = if cfg.uses_custom_endpoint() { vec![cfg.fixed_region()] } else { cfg.allowed_regions() };
        regions.into_iter().map(|r| (r, soniox_key_slot(r))).collect()
    }
}

/// Which regions have a key (never the keys): `soniox_key_status`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyStatus {
    pub regions: BTreeMap<String, bool>,
    pub legacy: bool,
    pub legacy_region: String,
    /// `cfg` can connect: a key for a region it may use.
    pub any_enabled: bool,
}

/// Key status for `cfg`; `has_key(slot)` reads the keychain.
pub fn key_status(cfg: &SonioxConfig, has_key: impl Fn(&str) -> bool) -> KeyStatus {
    let regions: BTreeMap<String, bool> =
        SONIOX_REGIONS.iter().map(|r| (r.to_string(), has_key(&soniox_key_slot(r)))).collect();
    let legacy = has_key(crate::stt::plus_config::SONIOX_KEY_SLOT);
    let legacy_region = cfg.legacy_region();
    let has = |region: &str| regions.get(region).copied().unwrap_or(false) || (legacy && region == legacy_region);
    let any_enabled = if cfg.uses_custom_endpoint() {
        has(cfg.fixed_region())
    } else {
        cfg.allowed_regions().iter().any(|r| has(r))
    };
    KeyStatus { regions, legacy, legacy_region: legacy_region.to_string(), any_enabled }
}

// ── Candidates ──────────────────────────────────────────────────────────────

/// Where a connection goes. `region` is `us` / `eu` / `jp` / `in`, or `custom` for a gateway.
#[derive(Clone, PartialEq)]
pub struct Target {
    pub region: String,
    pub ws_url: String,
    pub key: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target").field("region", &self.region).field("ws_url", &self.ws_url).finish()
    }
}

/// Latest latency measurement of each region.
#[derive(Debug, Clone, Default)]
pub struct LatencyTable {
    pub entries: HashMap<String, LatencyEntry>,
}

#[derive(Debug, Clone)]
pub struct LatencyEntry {
    /// None = no answer (timed out / unreachable).
    pub ms: Option<u64>,
    pub error: Option<String>,
    pub measured_at: Instant,
}

impl LatencyTable {
    /// The region's latency when measured within `LATENCY_TTL`.
    pub fn fresh_ms(&self, region: &str, now: Instant) -> Option<u64> {
        let entry = self.entries.get(region)?;
        (now.saturating_duration_since(entry.measured_at) < LATENCY_TTL).then_some(entry.ms).flatten()
    }

    /// Every region was measured within `LATENCY_TTL` (an answer or not).
    pub fn is_fresh(&self, now: Instant) -> bool {
        SONIOX_REGIONS.iter().all(|r| {
            self.entries.get(*r).is_some_and(|e| now.saturating_duration_since(e.measured_at) < LATENCY_TTL)
        })
    }
}

/// Regions full a moment ago (`FULL_COOLDOWN`), shared by every session.
#[derive(Debug, Default)]
pub struct Cooldowns {
    until: HashMap<String, Instant>,
}

impl Cooldowns {
    pub fn mark_full(&mut self, region: &str, now: Instant) {
        self.until.insert(region.to_string(), now + FULL_COOLDOWN);
    }

    pub fn is_cooling(&self, region: &str, now: Instant) -> bool {
        self.until.get(region).is_some_and(|until| now < *until)
    }
}

static COOLDOWNS: OnceLock<Mutex<Cooldowns>> = OnceLock::new();

/// The app-wide cooldowns.
pub fn cooldowns() -> &'static Mutex<Cooldowns> {
    COOLDOWNS.get_or_init(Default::default)
}

/// The regions `cfg` may use, in the order to try them (keys not considered):
/// `fixed` → `region`; `ordered` → the enabled ones in list order; `auto` →
/// the enabled ones fastest first, unmeasured ones after them in list order.
/// Regions full a moment ago move to the end.
pub fn order_regions(
    cfg: &SonioxConfig,
    latency: &LatencyTable,
    cooldowns: &Cooldowns,
    now: Instant,
) -> Vec<&'static str> {
    let mut regions = cfg.allowed_regions();
    if cfg.region_mode == SonioxRegionMode::Auto {
        // Stable: equal latencies and unmeasured regions keep the list order.
        regions.sort_by_key(|r| latency.fresh_ms(r, now).map_or((1, 0), |ms| (0, ms)));
    }
    if cfg.region_mode != SonioxRegionMode::Fixed {
        regions.sort_by_key(|r| cooldowns.is_cooling(r, now));
    }
    regions
}

/// Where a session may connect, best first. A gateway (custom URLs) is the
/// one target, with `region`'s key. Without `failover` only the best is kept.
/// `ws_urls` overrides region WebSocket URLs (tests).
pub fn candidates(
    cfg: &SonioxConfig,
    keys: &RegionKeys,
    latency: &LatencyTable,
    cooldowns: &Cooldowns,
    now: Instant,
    ws_urls: Option<&HashMap<String, String>>,
) -> Vec<Target> {
    if cfg.uses_custom_endpoint() {
        return keys
            .key_for(cfg.fixed_region())
            .map(|key| Target { region: "custom".into(), ws_url: cfg.ws_endpoint(), key: key.to_string() })
            .into_iter()
            .collect();
    }
    let mut targets: Vec<Target> = order_regions(cfg, latency, cooldowns, now)
        .into_iter()
        .filter_map(|region| {
            let key = keys.key_for(region)?;
            let ws_url = ws_urls
                .and_then(|urls| urls.get(region).cloned())
                .unwrap_or_else(|| soniox_region_ws_url(region).to_string());
            Some(Target { region: region.to_string(), ws_url, key: key.to_string() })
        })
        .collect();
    if !cfg.failover {
        targets.truncate(1);
    }
    targets
}

// ── What a failure means for the region ─────────────────────────────────────

/// Why a session moved to another region (`soniox_region_switch`.reason).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchReason {
    Concurrency,
    Unavailable,
    ModelNotAvailable,
    Budget,
    Network,
    KeyRejected,
    InternalError,
}

/// What a failed connection means for the region it used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionAction {
    /// Another region can help: try the next one now. `cooldown`: it was full.
    Switch { reason: SwitchReason, cooldown: bool },
    /// The region refused the key: skip it for the rest of the session.
    KeyRejected,
    /// `internal_error`: once more in the same region, then the next one.
    RetryThenSwitch,
    /// An organization-wide limit (every region shares it): back off (≥ 20 s)
    /// and start again from the first region.
    OrgLimit,
    /// Reconnect to the same region after the usual backoff (`class`).
    SameRegion { class: RetryClass },
    /// Nothing will help (organization balance or budget, a bad request).
    Stop,
}

/// The region action for a Soniox error frame, by `error_type`, else by code.
/// A 429 is organization-wide when its message says so, else a project's
/// (another region's project can help).
pub fn action_for_error(err: &SonioxError) -> RegionAction {
    use RegionAction::*;
    let org_wide = err.message.to_ascii_lowercase().contains("organi");
    let full = if org_wide { OrgLimit } else { Switch { reason: SwitchReason::Concurrency, cooldown: true } };
    match err.error_type.as_deref().unwrap_or("") {
        "max_concurrent_connections_reached" | "limit_exceeded" => full,
        "service_unavailable" => Switch { reason: SwitchReason::Unavailable, cooldown: false },
        "internal_error" => RetryThenSwitch,
        "model_not_available" => Switch { reason: SwitchReason::ModelNotAvailable, cooldown: false },
        "project_monthly_budget_exhausted" => Switch { reason: SwitchReason::Budget, cooldown: false },
        "unauthenticated" | "permission_denied" | "temp_api_key_session_expired" => KeyRejected,
        "organization_balance_exhausted" | "organization_monthly_budget_exhausted" | "invalid_request" => Stop,
        "request_timeout" => SameRegion { class: RetryClass::Retry },
        "max_duration_reached" => SameRegion { class: RetryClass::NewSessionNow },
        _ => match err.code {
            Some(429) => full,
            Some(401) | Some(403) => KeyRejected,
            Some(400) | Some(402) => Stop,
            Some(408) => SameRegion { class: RetryClass::Retry },
            Some(413) => SameRegion { class: RetryClass::NewSessionNow },
            Some(500) => RetryThenSwitch,
            Some(code) if code > 500 => Switch { reason: SwitchReason::Unavailable, cooldown: false },
            _ => SameRegion { class: RetryClass::Retry },
        },
    }
}

/// Why a connection couldn't be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectFailure {
    /// DNS, TCP, TLS or a timeout.
    Network,
    /// The handshake got an HTTP status.
    Http(u16),
    /// The URL or the key can't be used at all.
    Invalid,
}

/// The region action for a connection that couldn't be opened.
pub fn action_for_connect(failure: &ConnectFailure) -> RegionAction {
    use RegionAction::*;
    match failure {
        ConnectFailure::Network => Switch { reason: SwitchReason::Network, cooldown: false },
        ConnectFailure::Http(401) | ConnectFailure::Http(403) => KeyRejected,
        ConnectFailure::Http(429) => Switch { reason: SwitchReason::Concurrency, cooldown: true },
        ConnectFailure::Http(_) => Switch { reason: SwitchReason::Unavailable, cooldown: false },
        ConnectFailure::Invalid => Stop,
    }
}

/// A failure after the connection was up for a while: reconnect to the same
/// region first (with its audio buffer); only a refused key, an
/// organization-wide limit or a hopeless error changes that.
pub fn mid_session(action: RegionAction) -> RegionAction {
    match action {
        RegionAction::Stop | RegionAction::KeyRejected | RegionAction::OrgLimit => action,
        RegionAction::SameRegion { class } => RegionAction::SameRegion { class },
        RegionAction::Switch { .. } | RegionAction::RetryThenSwitch => {
            RegionAction::SameRegion { class: RetryClass::Retry }
        }
    }
}

/// What the session does after a failure.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Connect to `current()` now; `switched` names the region left and why.
    Now { switched: Option<(String, SwitchReason)> },
    /// Back off (`class`), then connect to `current()`.
    Backoff { class: RetryClass },
    /// Nothing left to try.
    GiveUp,
}

/// A session's way through its candidate regions.
#[derive(Debug)]
pub struct RegionRouter {
    targets: Vec<Target>,
    index: usize,
    /// Regions whose key was refused during this session.
    rejected: HashSet<String>,
    retried_internal: bool,
    /// Failures in a row (across regions) since a connection last held.
    failures_in_a_row: usize,
    /// A region of this round was full: the backoff after the round waits ≥ 20 s
    /// (closed streams can hold their slot that long).
    round_had_full: bool,
}

impl RegionRouter {
    pub fn new(targets: Vec<Target>) -> Self {
        Self {
            targets,
            index: 0,
            rejected: HashSet::new(),
            retried_internal: false,
            failures_in_a_row: 0,
            round_had_full: false,
        }
    }

    pub fn current(&self) -> Option<&Target> {
        self.targets.get(self.index).filter(|t| !self.rejected.contains(&t.region))
    }

    pub fn regions(&self) -> Vec<&str> {
        self.targets.iter().map(|t| t.region.as_str()).collect()
    }

    /// A connection held: start counting failures again.
    pub fn on_established(&mut self) {
        self.failures_in_a_row = 0;
        self.retried_internal = false;
        self.round_had_full = false;
    }

    pub fn on_failure(&mut self, action: RegionAction, cooldowns: &mut Cooldowns, now: Instant) -> Step {
        match action {
            RegionAction::Stop => Step::GiveUp,
            RegionAction::SameRegion { class } => Step::Backoff { class },
            RegionAction::OrgLimit => {
                // Another region shares the same organization limit: wait, then from the top.
                self.failures_in_a_row = 0;
                self.retried_internal = false;
                match self.first_usable() {
                    Some(first) => {
                        self.index = first;
                        Step::Backoff { class: RetryClass::RateLimited }
                    }
                    None => Step::GiveUp,
                }
            }
            RegionAction::RetryThenSwitch if !self.retried_internal => {
                self.retried_internal = true;
                Step::Now { switched: None }
            }
            RegionAction::RetryThenSwitch => self.switch(SwitchReason::InternalError, true),
            RegionAction::KeyRejected => {
                if let Some(target) = self.targets.get(self.index) {
                    self.rejected.insert(target.region.clone());
                }
                if self.first_usable().is_none() {
                    return Step::GiveUp;
                }
                // The region is out of the round: its failure doesn't count against the others.
                self.switch(SwitchReason::KeyRejected, false)
            }
            RegionAction::Switch { reason, cooldown } => {
                self.round_had_full |= reason == SwitchReason::Concurrency;
                if cooldown {
                    if let Some(target) = self.targets.get(self.index) {
                        cooldowns.mark_full(&target.region, now);
                    }
                }
                self.switch(reason, true)
            }
        }
    }

    /// Move to the next usable region now; after every one failed in a row,
    /// back off and keep going round. `counts`: the failure counts toward that.
    fn switch(&mut self, reason: SwitchReason, counts: bool) -> Step {
        self.retried_internal = false;
        if counts {
            self.failures_in_a_row += 1;
        }
        let usable = self.targets.iter().filter(|t| !self.rejected.contains(&t.region)).count();
        let from = self.targets.get(self.index).map(|t| t.region.clone());
        let Some(next) = self.next_usable() else { return Step::GiveUp };
        self.index = next;
        let to = self.targets[next].region.clone();
        if self.failures_in_a_row >= usable {
            self.failures_in_a_row = 0;
            let class = if std::mem::take(&mut self.round_had_full) { RetryClass::RateLimited } else { RetryClass::Retry };
            return Step::Backoff { class };
        }
        match from {
            Some(from) if from != to => Step::Now { switched: Some((from, reason)) },
            _ => Step::Now { switched: None },
        }
    }

    fn first_usable(&self) -> Option<usize> {
        self.targets.iter().position(|t| !self.rejected.contains(&t.region))
    }

    /// The next usable target after the current one (round), possibly the current one.
    fn next_usable(&self) -> Option<usize> {
        let n = self.targets.len();
        (1..=n).map(|k| (self.index + k) % n).find(|&i| !self.rejected.contains(&self.targets[i].region))
    }
}

// ── Latency ─────────────────────────────────────────────────────────────────

/// The regions' REST bases (`/v1/models` lives under them).
pub fn default_rest_bases() -> Vec<(String, String)> {
    SONIOX_REGIONS.iter().map(|r| (r.to_string(), soniox_region_rest_base(r).to_string())).collect()
}

#[derive(Default)]
struct LatencyCache {
    table: LatencyTable,
    /// Epoch ms of the last complete measurement.
    measured_at_ms: u64,
    running: bool,
}

static LATENCY: OnceLock<Mutex<LatencyCache>> = OnceLock::new();

fn latency_cache() -> &'static Mutex<LatencyCache> {
    LATENCY.get_or_init(Default::default)
}

/// The cached latencies (whatever was measured so far).
pub fn latency_table() -> LatencyTable {
    latency_cache().lock().map(|c| c.table.clone()).unwrap_or_default()
}

/// One region: the fastest of `LATENCY_TRIES` unauthenticated `GET {base}/v1/models`
/// (a quick 401). The first try includes DNS and TLS; later ones reuse the connection.
pub async fn measure_region(client: &reqwest::Client, base: &str) -> Result<u64, String> {
    let url = format!("{}/v1/models", base.trim_end_matches('/'));
    let mut best: Option<u64> = None;
    let mut last_error = String::new();
    for _ in 0..LATENCY_TRIES {
        let started = Instant::now();
        match client.get(&url).timeout(LATENCY_REQUEST_TIMEOUT).send().await {
            Ok(response) => {
                let ms = started.elapsed().as_millis() as u64;
                // Read the body so the connection can be reused for the next try.
                let _ = response.bytes().await;
                best = Some(best.map_or(ms, |b| b.min(ms)));
            }
            Err(e) => last_error = if e.is_timeout() { "timeout".to_string() } else { "unreachable".to_string() },
        }
    }
    best.ok_or(last_error)
}

/// Measure `bases` concurrently, writing each result into `table` as it arrives.
async fn measure_into(bases: Vec<(String, String)>, sink: impl Fn(String, Result<u64, String>) + Clone) {
    let client = reqwest::Client::builder().connect_timeout(LATENCY_REQUEST_TIMEOUT).build().unwrap_or_default();
    let jobs = bases.into_iter().map(|(region, base)| {
        let client = client.clone();
        let sink = sink.clone();
        async move {
            let result = measure_region(&client, &base).await;
            sink(region, result);
        }
    });
    futures::future::join_all(jobs).await;
}

fn record(region: String, result: Result<u64, String>) {
    if let Ok(mut cache) = latency_cache().lock() {
        let (ms, error) = match result {
            Ok(ms) => (Some(ms), None),
            Err(e) => (None, Some(e)),
        };
        cache.table.entries.insert(region, LatencyEntry { ms, error, measured_at: Instant::now() });
    }
}

/// `soniox_measure_latency`: per region `{ms, error}`.
#[derive(Debug, Clone, Serialize)]
pub struct LatencyReport {
    pub regions: BTreeMap<String, LatencyResult>,
    pub measured_at_ms: u64,
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LatencyResult {
    pub ms: Option<u64>,
    pub error: Option<String>,
}

fn report(cached: bool) -> LatencyReport {
    let cache = latency_cache().lock();
    let (table, measured_at_ms) = match cache {
        Ok(c) => (c.table.clone(), c.measured_at_ms),
        Err(_) => (LatencyTable::default(), 0),
    };
    let regions = SONIOX_REGIONS
        .iter()
        .map(|r| {
            let entry = table.entries.get(*r);
            let result = LatencyResult {
                ms: entry.and_then(|e| e.ms),
                error: entry.map_or(Some("not measured".to_string()), |e| e.error.clone()),
            };
            (r.to_string(), result)
        })
        .collect();
    LatencyReport { regions, measured_at_ms, cached }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Settings-page latency test: the cache when fresh (unless `force`), else all four now.
pub async fn measure_latency(force: bool) -> LatencyReport {
    if !force && latency_table().is_fresh(Instant::now()) {
        return report(true);
    }
    measure_into(default_rest_bases(), record).await;
    if let Ok(mut cache) = latency_cache().lock() {
        cache.measured_at_ms = epoch_ms();
    }
    report(false)
}

/// The last latency test without measuring (`measured_at_ms` 0: none yet).
pub fn cached_latency() -> LatencyReport {
    report(true)
}

/// For an `auto` session: the cache when fresh; else measure, waiting at most
/// `budget` (regions that don't answer by then go last; the test finishes in
/// the background and updates the cache for the next connection).
pub async fn latency_for_session(budget: Duration) -> LatencyTable {
    if latency_table().is_fresh(Instant::now()) {
        return latency_table();
    }
    let start = {
        let mut cache = match latency_cache().lock() {
            Ok(cache) => cache,
            Err(_) => return LatencyTable::default(),
        };
        let start = !cache.running;
        cache.running = true;
        start
    };
    if start {
        tokio::spawn(async {
            measure_into(default_rest_bases(), record).await;
            if let Ok(mut cache) = latency_cache().lock() {
                cache.running = false;
                cache.measured_at_ms = epoch_ms();
            }
        });
    }
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if latency_table().is_fresh(Instant::now()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    latency_table()
}

/// `auto` sessions running now; while there are any, the latency test is
/// redone every `LATENCY_TTL` in the background (one refresher for the app).
static AUTO_SESSIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static REFRESHER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Held by an `auto` session while it runs.
pub struct AutoSession(());

impl Drop for AutoSession {
    fn drop(&mut self) {
        AUTO_SESSIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// An `auto` session started: keep the latency cache fresh while it runs.
pub fn auto_session_started() -> AutoSession {
    use std::sync::atomic::Ordering;
    AUTO_SESSIONS.fetch_add(1, Ordering::SeqCst);
    if !REFRESHER.swap(true, Ordering::SeqCst) {
        tokio::spawn(async {
            loop {
                tokio::time::sleep(LATENCY_TTL).await;
                if AUTO_SESSIONS.load(Ordering::SeqCst) == 0 {
                    break;
                }
                measure_into(default_rest_bases(), record).await;
                if let Ok(mut cache) = latency_cache().lock() {
                    cache.measured_at_ms = epoch_ms();
                }
            }
            REFRESHER.store(false, Ordering::SeqCst);
        });
    }
    AutoSession(())
}

// ── Which region a key belongs to ───────────────────────────────────────────

/// One region's answer to `/v1/models` with the key.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyProbe {
    pub status: Option<u16>,
    pub error: Option<String>,
    /// 200 (listed) or 403 (valid key without the model-listing permission).
    pub matches: bool,
}

/// `soniox_add_key`: the key's region (None = not found / ambiguous), whether it was saved.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AddKeyResult {
    pub region: Option<String>,
    pub stored: bool,
    pub statuses: BTreeMap<String, KeyProbe>,
}

impl AddKeyResult {
    /// The user picked the region: no detection.
    pub fn chosen(region: &str) -> Self {
        Self { region: Some(region.to_string()), stored: false, statuses: BTreeMap::new() }
    }
}

/// Ask every region's `/v1/models` with `key` at once: a key works in its
/// own region only (200 or 403 there, 401 elsewhere). One match = its region.
pub async fn detect_key_region(key: &str, bases: &[(String, String)]) -> AddKeyResult {
    let client = reqwest::Client::builder().timeout(DETECT_TIMEOUT).build().unwrap_or_default();
    let probes = bases.iter().map(|(region, base)| {
        let client = client.clone();
        let url = format!("{}/v1/models", base.trim_end_matches('/'));
        let region = region.clone();
        async move {
            let probe = match client.get(&url).bearer_auth(key).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    KeyProbe { status: Some(status), error: None, matches: matches!(status, 200..=299 | 403) }
                }
                Err(e) => KeyProbe {
                    status: None,
                    error: Some(if e.is_timeout() { "timeout" } else { "unreachable" }.to_string()),
                    matches: false,
                },
            };
            (region, probe)
        }
    });
    let statuses: BTreeMap<String, KeyProbe> = futures::future::join_all(probes).await.into_iter().collect();
    let matching: Vec<&String> = statuses.iter().filter(|(_, p)| p.matches).map(|(r, _)| r).collect();
    let region = match matching.as_slice() {
        [only] => Some(soniox_region(only).to_string()),
        _ => None,
    };
    AddKeyResult { region, stored: false, statuses }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn cfg(json: &str) -> SonioxConfig {
        serde_json::from_str(json).unwrap()
    }

    fn keys(regions: &[&str], legacy: Option<&str>, legacy_region: &str) -> RegionKeys {
        RegionKeys {
            per_region: regions.iter().map(|r| (r.to_string(), format!("key-{}", r))).collect(),
            legacy: legacy.map(str::to_string),
            legacy_region: legacy_region.to_string(),
        }
    }

    fn latency(now: Instant, pairs: &[(&str, Option<u64>, u64)]) -> LatencyTable {
        let mut table = LatencyTable::default();
        for (region, ms, age_secs) in pairs {
            table.entries.insert(
                region.to_string(),
                LatencyEntry { ms: *ms, error: None, measured_at: now - Duration::from_secs(*age_secs) },
            );
        }
        table
    }

    fn ids(targets: &[Target]) -> Vec<&str> {
        targets.iter().map(|t| t.region.as_str()).collect()
    }

    const ALL_ON: &str = r#"[{"id":"us","enabled":true},{"id":"eu","enabled":true},{"id":"jp","enabled":true},{"id":"in","enabled":true}]"#;

    #[test]
    fn the_old_key_counts_for_the_fixed_region_only() {
        let k = keys(&["jp"], Some("legacy"), "us");
        assert_eq!(k.key_for("us"), Some("legacy"));
        assert_eq!(k.key_for("jp"), Some("key-jp"));
        assert_eq!(k.key_for("eu"), None);
        let own = keys(&["us"], Some("legacy"), "us");
        assert_eq!(own.key_for("us"), Some("key-us"));
        assert!(!format!("{:?}", own).contains("key-us"), "Debug never prints keys");
    }

    #[test]
    fn fixed_mode_uses_its_region_alone() {
        let now = Instant::now();
        let c = cfg(r#"{"region":"eu","region_mode":"fixed"}"#);
        let t = candidates(&c, &keys(&["us", "eu"], None, "eu"), &LatencyTable::default(), &Cooldowns::default(), now, None);
        assert_eq!(ids(&t), vec!["eu"]);
        assert_eq!(t[0].ws_url, "wss://stt-rt.eu.soniox.com/transcribe-websocket");
        assert_eq!(t[0].key, "key-eu");
        // No key for it: nothing to try.
        let none = candidates(&c, &keys(&["us"], None, "eu"), &LatencyTable::default(), &Cooldowns::default(), now, None);
        assert!(none.is_empty());
    }

    #[test]
    fn ordered_mode_keeps_the_list_order_of_enabled_regions_with_a_key() {
        let now = Instant::now();
        let c = cfg(r#"{"region_mode":"ordered","regions":[{"id":"jp","enabled":true},{"id":"in","enabled":false},
            {"id":"us","enabled":true},{"id":"eu","enabled":true}]}"#);
        let t = candidates(&c, &keys(&["jp", "in", "eu"], Some("legacy"), "us"), &LatencyTable::default(), &Cooldowns::default(), now, None);
        assert_eq!(ids(&t), vec!["jp", "us", "eu"]);
        assert_eq!(t[1].key, "legacy");
    }

    #[test]
    fn auto_mode_puts_the_fastest_first_and_unmeasured_regions_last_in_list_order() {
        let now = Instant::now();
        let c = cfg(&format!(r#"{{"region_mode":"auto","regions":{}}}"#, ALL_ON));
        let k = keys(&["us", "eu", "jp", "in"], None, "us");
        let table = latency(now, &[("us", Some(180), 10), ("jp", Some(40), 10), ("in", Some(90), 10)]);
        assert_eq!(ids(&candidates(&c, &k, &table, &Cooldowns::default(), now, None)), vec!["jp", "in", "us", "eu"]);
        // A timed-out region (no answer) goes last, like an unmeasured one.
        let timed_out = latency(now, &[("us", None, 1), ("eu", Some(300), 1), ("jp", None, 1), ("in", Some(90), 1)]);
        assert_eq!(ids(&candidates(&c, &k, &timed_out, &Cooldowns::default(), now, None)), vec!["in", "eu", "us", "jp"]);
        // Measurements older than 10 min no longer count: back to the list order.
        let stale = latency(now, &[("jp", Some(10), 11 * 60), ("in", Some(20), 11 * 60)]);
        assert!(!stale.is_fresh(now));
        assert_eq!(ids(&candidates(&c, &k, &stale, &Cooldowns::default(), now, None)), vec!["us", "eu", "jp", "in"]);
    }

    #[test]
    fn a_region_that_was_full_goes_last_for_five_minutes() {
        let now = Instant::now();
        let c = cfg(&format!(r#"{{"region_mode":"auto","regions":{}}}"#, ALL_ON));
        let k = keys(&["us", "eu", "jp", "in"], None, "us");
        let table = latency(now, &[("us", Some(180), 0), ("eu", Some(200), 0), ("jp", Some(40), 0), ("in", Some(90), 0)]);
        let mut cool = Cooldowns::default();
        cool.mark_full("jp", now);
        assert_eq!(ids(&candidates(&c, &k, &table, &cool, now, None)), vec!["in", "us", "eu", "jp"]);
        let later = now + FULL_COOLDOWN + Duration::from_secs(1);
        let fresh_again = latency(later, &[("us", Some(180), 0), ("eu", Some(200), 0), ("jp", Some(40), 0), ("in", Some(90), 0)]);
        assert_eq!(ids(&candidates(&c, &k, &fresh_again, &cool, later, None)), vec!["jp", "in", "us", "eu"]);
    }

    #[test]
    fn without_failover_only_the_best_region_is_tried_and_a_gateway_ignores_regions() {
        let now = Instant::now();
        let c = cfg(&format!(r#"{{"region_mode":"ordered","failover":false,"regions":{}}}"#, ALL_ON));
        let k = keys(&["eu", "jp"], None, "us");
        assert_eq!(ids(&candidates(&c, &k, &LatencyTable::default(), &Cooldowns::default(), now, None)), vec!["eu"]);

        let gw = cfg(&format!(r#"{{"region":"jp","region_mode":"auto","ws_url":"wss://gw.example/rt","regions":{}}}"#, ALL_ON));
        let t = candidates(&gw, &keys(&["jp"], None, "jp"), &LatencyTable::default(), &Cooldowns::default(), now, None);
        assert_eq!(t, vec![Target { region: "custom".into(), ws_url: "wss://gw.example/rt".into(), key: "key-jp".into() }]);
    }

    #[test]
    fn key_status_reports_regions_and_whether_the_config_can_connect() {
        let has = |slots: &'static [&'static str]| move |slot: &str| slots.contains(&slot);
        let fixed = cfg(r#"{"region":"eu"}"#);
        let s = key_status(&fixed, has(&["soniox"]));
        assert!(s.legacy && s.any_enabled);
        assert_eq!(s.legacy_region, "eu");
        assert_eq!(s.regions.values().filter(|v| **v).count(), 0);

        let auto = cfg(r#"{"region_mode":"auto","regions":[{"id":"jp","enabled":true},{"id":"us","enabled":false}]}"#);
        assert!(key_status(&auto, has(&["soniox_jp"])).any_enabled);
        // A key only for a disabled region (or the old slot of a disabled region) doesn't count.
        assert!(!key_status(&auto, has(&["soniox_us", "soniox"])).any_enabled);
        assert_eq!(key_status(&auto, has(&["soniox_us"])).regions["us"], true);

        // The old key keeps its pinned region when the fixed region changes…
        let moved = cfg(r#"{"region":"jp","legacy_key_region":"us"}"#);
        let s = key_status(&moved, has(&["soniox"]));
        assert_eq!(s.legacy_region, "us");
        assert!(!s.any_enabled, "Japan has no key of its own");
        // …and a gateway uses `region`'s key.
        let gw = cfg(r#"{"region":"jp","legacy_key_region":"us","ws_url":"wss://gw.example/rt"}"#);
        assert!(!key_status(&gw, has(&["soniox"])).any_enabled);
        assert!(key_status(&gw, has(&["soniox_jp"])).any_enabled);
    }

    fn err(code: u16, kind: &str, message: &str) -> SonioxError {
        SonioxError { code: Some(code), error_type: Some(kind.into()), message: message.into(), request_id: None }
    }

    #[test]
    fn each_error_maps_to_a_region_action() {
        use RegionAction::*;
        let switch = |reason, cooldown| Switch { reason, cooldown };
        let cases = [
            (err(429, "max_concurrent_connections_reached", "Project concurrency limit"), switch(SwitchReason::Concurrency, true)),
            (err(429, "limit_exceeded", "Project request limit exceeded"), switch(SwitchReason::Concurrency, true)),
            (err(429, "limit_exceeded", "Organization request limit exceeded"), OrgLimit),
            (err(429, "max_concurrent_connections_reached", "organization limit of 10 reached"), OrgLimit),
            (err(503, "service_unavailable", "Cannot continue request (code 1)"), switch(SwitchReason::Unavailable, false)),
            (err(500, "internal_error", ""), RetryThenSwitch),
            (err(400, "model_not_available", "model not available in this region"), switch(SwitchReason::ModelNotAvailable, false)),
            (err(402, "project_monthly_budget_exhausted", ""), switch(SwitchReason::Budget, false)),
            (err(401, "unauthenticated", ""), KeyRejected),
            (err(403, "permission_denied", ""), KeyRejected),
            (err(402, "organization_balance_exhausted", ""), Stop),
            (err(402, "organization_monthly_budget_exhausted", ""), Stop),
            (err(400, "invalid_request", "bad audio format"), Stop),
            (err(408, "request_timeout", ""), SameRegion { class: RetryClass::Retry }),
            (err(413, "max_duration_reached", ""), SameRegion { class: RetryClass::NewSessionNow }),
            (err(502, "something_new", ""), switch(SwitchReason::Unavailable, false)),
            (err(429, "something_new", "project"), switch(SwitchReason::Concurrency, true)),
        ];
        for (error, expected) in cases {
            assert_eq!(action_for_error(&error), expected, "{:?}", error);
        }
        assert_eq!(action_for_connect(&ConnectFailure::Network), switch(SwitchReason::Network, false));
        assert_eq!(action_for_connect(&ConnectFailure::Http(401)), KeyRejected);
        assert_eq!(action_for_connect(&ConnectFailure::Http(429)), switch(SwitchReason::Concurrency, true));
        assert_eq!(action_for_connect(&ConnectFailure::Invalid), Stop);
        // After a while up, a drop or a regional error reconnects to the same region first.
        assert_eq!(mid_session(switch(SwitchReason::Unavailable, false)), SameRegion { class: RetryClass::Retry });
        assert_eq!(mid_session(KeyRejected), KeyRejected);
        assert_eq!(mid_session(OrgLimit), OrgLimit);
    }

    fn router(regions: &[&str]) -> RegionRouter {
        RegionRouter::new(
            regions
                .iter()
                .map(|r| Target { region: r.to_string(), ws_url: format!("ws://{}", r), key: format!("k-{}", r) })
                .collect(),
        )
    }

    #[test]
    fn the_router_moves_on_when_a_region_is_full_and_backs_off_after_a_full_round() {
        let now = Instant::now();
        let mut cool = Cooldowns::default();
        let mut r = router(&["jp", "in", "us"]);
        let full = RegionAction::Switch { reason: SwitchReason::Concurrency, cooldown: true };
        assert_eq!(r.on_failure(full, &mut cool, now), Step::Now { switched: Some(("jp".into(), SwitchReason::Concurrency)) });
        assert_eq!(r.current().unwrap().region, "in");
        assert!(cool.is_cooling("jp", now));
        let down = RegionAction::Switch { reason: SwitchReason::Unavailable, cooldown: false };
        assert_eq!(r.on_failure(down, &mut cool, now), Step::Now { switched: Some(("in".into(), SwitchReason::Unavailable)) });
        // The third failure in a row: every region failed once — back off (≥ 20 s: one
        // was full), then go on round.
        assert_eq!(r.on_failure(down, &mut cool, now), Step::Backoff { class: RetryClass::RateLimited });
        assert_eq!(r.current().unwrap().region, "jp");
        // A connection that holds resets the count.
        r.on_established();
        assert!(matches!(r.on_failure(down, &mut cool, now), Step::Now { .. }));
    }

    #[test]
    fn an_organization_wide_limit_waits_and_restarts_from_the_first_region() {
        let now = Instant::now();
        let mut cool = Cooldowns::default();
        let mut r = router(&["jp", "in"]);
        let down = RegionAction::Switch { reason: SwitchReason::Network, cooldown: false };
        r.on_failure(down, &mut cool, now);
        assert_eq!(r.current().unwrap().region, "in");
        assert_eq!(r.on_failure(RegionAction::OrgLimit, &mut cool, now), Step::Backoff { class: RetryClass::RateLimited });
        assert_eq!(r.current().unwrap().region, "jp");
        assert!(!cool.is_cooling("in", now));
    }

    #[test]
    fn a_refused_key_skips_its_region_for_the_session() {
        let now = Instant::now();
        let mut cool = Cooldowns::default();
        let mut r = router(&["jp", "in"]);
        assert_eq!(
            r.on_failure(RegionAction::KeyRejected, &mut cool, now),
            Step::Now { switched: Some(("jp".into(), SwitchReason::KeyRejected)) }
        );
        let down = RegionAction::Switch { reason: SwitchReason::Unavailable, cooldown: false };
        // Only "in" is left: failing again backs off and stays there.
        assert_eq!(r.on_failure(down, &mut cool, now), Step::Backoff { class: RetryClass::Retry });
        assert_eq!(r.current().unwrap().region, "in");
        assert_eq!(r.on_failure(RegionAction::KeyRejected, &mut cool, now), Step::GiveUp);
        assert!(r.current().is_none());
    }

    #[test]
    fn internal_errors_retry_once_in_place_and_stop_or_same_region_never_switch() {
        let now = Instant::now();
        let mut cool = Cooldowns::default();
        let mut r = router(&["us", "eu"]);
        assert_eq!(r.on_failure(RegionAction::RetryThenSwitch, &mut cool, now), Step::Now { switched: None });
        assert_eq!(r.current().unwrap().region, "us");
        assert_eq!(
            r.on_failure(RegionAction::RetryThenSwitch, &mut cool, now),
            Step::Now { switched: Some(("us".into(), SwitchReason::InternalError)) }
        );
        let mut s = router(&["us", "eu"]);
        assert_eq!(
            s.on_failure(RegionAction::SameRegion { class: RetryClass::Retry }, &mut cool, now),
            Step::Backoff { class: RetryClass::Retry }
        );
        assert_eq!(s.current().unwrap().region, "us");
        assert_eq!(s.on_failure(RegionAction::Stop, &mut cool, now), Step::GiveUp);
        // One candidate (no failover): a regional failure just backs off.
        let mut one = router(&["us"]);
        let down = RegionAction::Switch { reason: SwitchReason::Unavailable, cooldown: false };
        assert_eq!(one.on_failure(down, &mut cool, now), Step::Backoff { class: RetryClass::Retry });
    }

    /// A fake REST host per region: answers `/v1/models` with `status`
    /// (after `delay`), and records the Authorization header it got.
    async fn fake_rest(status: u16, delay: Duration) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut auths = Vec::new();
            while let Ok(Ok((mut s, _))) = tokio::time::timeout(Duration::from_millis(1500), listener.accept()).await {
                let mut buf = vec![0u8; 4096];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                if let Some(line) = req.lines().find(|l| l.starts_with("authorization:")) {
                    auths.push(line.trim().to_string());
                }
                tokio::time::sleep(delay).await;
                let reason = match status { 200 => "OK", 401 => "Unauthorized", 403 => "Forbidden", _ => "Error" };
                let resp = format!("HTTP/1.1 {} {}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}", status, reason);
                let _ = s.write_all(resp.as_bytes()).await;
            }
            auths
        });
        (base, handle)
    }

    #[tokio::test]
    async fn a_key_is_found_in_the_one_region_that_takes_it() {
        let (us, _) = fake_rest(401, Duration::ZERO).await;
        let (eu, _) = fake_rest(401, Duration::ZERO).await;
        let (jp, jp_seen) = fake_rest(403, Duration::ZERO).await;
        let bases = vec![("us".to_string(), us), ("eu".to_string(), eu), ("jp".to_string(), jp), ("in".to_string(), "http://127.0.0.1:9".to_string())];
        let result = detect_key_region("snx-test", &bases).await;
        assert_eq!(result.region.as_deref(), Some("jp"));
        assert!(!result.stored);
        assert_eq!(result.statuses["us"], KeyProbe { status: Some(401), error: None, matches: false });
        assert!(result.statuses["jp"].matches);
        assert_eq!(result.statuses["in"].status, None);
        assert!(result.statuses["in"].error.is_some());
        assert_eq!(jp_seen.await.unwrap(), vec!["authorization: bearer snx-test".to_string()]);
    }

    #[tokio::test]
    async fn an_unclear_key_region_is_left_to_the_user() {
        let (us, _) = fake_rest(401, Duration::ZERO).await;
        let (eu, _) = fake_rest(401, Duration::ZERO).await;
        let none = detect_key_region("k", &[("us".into(), us), ("eu".into(), eu)]).await;
        assert_eq!(none.region, None);
        let (a, _) = fake_rest(200, Duration::ZERO).await;
        let (b, _) = fake_rest(200, Duration::ZERO).await;
        let two = detect_key_region("k", &[("us".into(), a), ("eu".into(), b)]).await;
        assert_eq!(two.region, None);
        assert_eq!(two.statuses.values().filter(|p| p.matches).count(), 2);
    }

    #[tokio::test]
    async fn latency_is_the_fastest_try_and_unreachable_regions_report_an_error() {
        let (slow, slow_seen) = fake_rest(401, Duration::from_millis(120)).await;
        let (fast, _) = fake_rest(401, Duration::ZERO).await;
        let client = reqwest::Client::new();
        let slow_ms = measure_region(&client, &slow).await.unwrap();
        let fast_ms = measure_region(&client, &fast).await.unwrap();
        assert!(slow_ms >= 120 && fast_ms < slow_ms, "{} vs {}", slow_ms, fast_ms);
        // Without a key: no Authorization header.
        assert!(slow_seen.await.unwrap().is_empty());
        assert!(measure_region(&client, "http://127.0.0.1:9").await.is_err());
    }
}
