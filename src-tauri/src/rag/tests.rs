//! Engine tests: a fake host (documents, events, keychain) and a fake
//! embedding service on a raw socket.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::embedding::test_server::{FakeServer, Reply};
use super::embedding::RetryPolicy;
use super::engine::{RagEngine, RagHost, ResourceInfo, SearchOutcome, SearchParams, VectorState};
use super::indexer::JobKind;
use super::rerank::RerankStatus;
use super::search::SearchMode;
use crate::llm::api::LlmKind;
use crate::net::endpoint::{ConnectionSummary, ResolvedConnection};

#[derive(Default)]
struct FakeHost {
    resources: Mutex<Vec<ResourceInfo>>,
    events: Mutex<Vec<(String, Value)>>,
    secrets: Mutex<HashMap<String, String>>,
    meeting: AtomicBool,
    secret_reads: AtomicUsize,
    connections: Mutex<Vec<ResolvedConnection>>,
}

impl RagHost for FakeHost {
    fn resources(&self) -> Option<Vec<ResourceInfo>> {
        Some(self.resources.lock().unwrap().clone())
    }
    fn resource_text(&self, _id: &str) -> Option<String> {
        None
    }
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
    fn read_secret(&self, slot: &str) -> Result<Option<String>, String> {
        self.secret_reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.secrets.lock().unwrap().get(slot).cloned())
    }
    fn write_secret(&self, slot: &str, value: Option<&str>) -> Result<(), String> {
        let mut s = self.secrets.lock().unwrap();
        match value {
            Some(v) => s.insert(slot.to_string(), v.to_string()),
            None => s.remove(slot),
        };
        Ok(())
    }
    fn meeting_active(&self) -> bool {
        self.meeting.load(Ordering::SeqCst)
    }
    fn resolve_connection(&self, id: &str) -> Result<ResolvedConnection, String> {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("no connection {id}"))
    }
    fn list_connections(&self) -> Vec<ConnectionSummary> {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .map(|c| ConnectionSummary { id: c.id.clone(), name: c.id.clone(), kind: c.kind, base_url: c.base_url.clone() })
            .collect()
    }
}

impl FakeHost {
    fn statuses(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "rag_index_progress")
            .map(|(_, p)| p["status"].as_str().unwrap_or_default().to_string())
            .collect()
    }
}

/// A bag-of-characters embedding: texts sharing characters point the same way.
fn fake_vector(text: &str, dims: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; dims];
    for c in text.chars().filter(|c| !c.is_whitespace()) {
        let slot = (c as u64).wrapping_mul(2_654_435_761) % dims as u64;
        v[slot as usize] += 1.0;
    }
    v[0] += 0.01;
    v
}

/// Fake service: model "model-a" → 16 dims, anything else → 8 dims.
struct Service {
    server: FakeServer,
    inputs: Arc<AtomicUsize>,
    fail: Arc<AtomicUsize>,
}

async fn service() -> Service {
    let inputs = Arc::new(AtomicUsize::new(0));
    let fail = Arc::new(AtomicUsize::new(0));
    let (i, f) = (inputs.clone(), fail.clone());
    let server = FakeServer::start(move |req| {
        let status = f.load(Ordering::SeqCst);
        if status != 0 {
            return Reply::text(status as u16, "service says no");
        }
        let body = req.json();
        let dims = if body["model"] == "model-a" { 16 } else { 8 };
        let texts: Vec<String> = body["input"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
        i.fetch_add(texts.len(), Ordering::SeqCst);
        let data: Vec<Value> = texts
            .iter()
            .enumerate()
            .map(|(n, t)| json!({"index": n, "embedding": fake_vector(t, dims)}))
            .collect();
        Reply::json(200, json!({"data": data}))
    })
    .await;
    Service { server, inputs, fail }
}

fn fast() -> RetryPolicy {
    RetryPolicy { base_delay: Duration::from_millis(1), max_delay: Duration::from_millis(2), transient_attempts: 2, rate_limit_attempts: 2 }
}

struct Fixture {
    dir: PathBuf,
    host: Arc<FakeHost>,
    engine: Arc<RagEngine>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexq-rag-engine-{name}-{}-{}", std::process::id(), super::store::now_ms()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    dir
}

const DOC_A: &str = "向量检索可以在文档很多的时候快速找到内容。混合检索结合了关键词和向量两种方法。";
const DOC_B: &str = "明天的会议讨论预算和招聘计划，财务需要提前准备季度报表。";
const DOC_C: &str = "The quarterly roadmap covers authentication, billing and onboarding for new customers.";
/// Long enough to become a second chunk (chunk size 64 in these tests).
const APPENDED: &str = "新增的一段：重排序可以进一步提高检索结果的质量，候选结果先由混合检索召回，再交给专门的模型重新打分排序。";

impl Fixture {
    async fn new(name: &str, base_url: &str) -> Fixture {
        let dir = temp_dir(name);
        let host = Arc::new(FakeHost::default());
        let engine = RagEngine::start_with(&dir.join("rag"), host.clone(), fast());
        engine
            .update_config(&json!({
                "enabled": true,
                "chunk_size": 64,
                "chunk_overlap": 8,
                "indexing": {"auto_index": false},
                "embedding": {"provider": "openai_compat", "base_url": base_url, "model": "model-a", "batch_size": 2}
            }))
            .unwrap();
        let f = Fixture { dir, host, engine };
        f.write("a", DOC_A);
        f.write("b", DOC_B);
        f.write("c", DOC_C);
        f
    }

    fn write(&self, id: &str, text: &str) {
        let path = self.dir.join("docs").join(format!("{id}.txt"));
        std::fs::write(&path, text).unwrap();
        let mut resources = self.host.resources.lock().unwrap();
        resources.retain(|r| r.id != id);
        resources.push(ResourceInfo {
            id: id.to_string(),
            name: format!("{id}.txt"),
            file_type: "txt".into(),
            path: path.to_string_lossy().to_string(),
        });
    }

    async fn sync(&self) -> super::indexer::JobSummary {
        self.engine.run(JobKind::Sync { resources: None, force: false }).await.unwrap()
    }

    async fn search(&self, query: &str, mode: SearchMode) -> super::engine::SearchOutcome {
        self.engine
            .search(query, SearchParams { top_k: 3, mode, semantic_weight: 0.7 })
            .await
            .unwrap()
    }

    async fn top(&self, query: &str, mode: SearchMode) -> String {
        self.search(query, mode).await.chunks.first().map(|c| c.source_file.clone()).unwrap_or_default()
    }
}

#[tokio::test]
async fn indexes_documents_and_finds_them_by_vectors_and_keywords() {
    let svc = service().await;
    let f = Fixture::new("e2e", &format!("{}/v1", svc.server.base())).await;
    let s = f.sync().await;
    assert_eq!((s.files_total, s.files_done, s.files_failed), (3, 3, 0));
    assert!(s.chunks_inserted >= 3);
    assert_eq!(s.vectors_embedded, s.chunks_inserted);
    assert!(s.error.is_none());

    let info = f.engine.index_info().await;
    assert_eq!(info.vector_state, VectorState::Ready);
    assert_eq!((info.documents, info.documents_indexed), (3, 3));
    assert_eq!(info.vectors, info.chunks);
    assert_eq!(info.pending_vectors, 0);
    assert!(!info.needs_rebuild);
    assert_eq!(info.active_space.as_ref().unwrap().dims, 16);

    for mode in [SearchMode::Hybrid, SearchMode::Semantic, SearchMode::Keyword] {
        assert_eq!(f.top("预算会议", mode).await, "b.txt", "{mode:?}");
        assert_eq!(f.top("billing roadmap", mode).await, "c.txt", "{mode:?}");
    }
    let hybrid = f.search("向量检索", SearchMode::Hybrid).await;
    assert!(hybrid.vector_used && hybrid.degraded.is_none());
    assert_eq!(hybrid.chunks[0].source_file, "a.txt");
    assert_eq!(hybrid.chunks[0].normalized_score, 1.0);
    assert!(hybrid.chunks[0].chunk_id.parse::<i64>().is_ok());

    // The legacy counters come from memory.
    let stats = f.engine.stats();
    assert_eq!((stats.documents, stats.chunks), (3, info.chunks));
    assert!(f.host.statuses().contains(&"complete".to_string()));
}

#[tokio::test]
async fn unchanged_files_are_skipped_and_edits_embed_only_new_chunks() {
    let svc = service().await;
    let f = Fixture::new("incremental", &svc.server.base()).await;
    let first = f.sync().await;
    let embedded_once = svc.inputs.load(Ordering::SeqCst);
    assert_eq!(embedded_once, first.vectors_embedded);

    let again = f.sync().await;
    assert_eq!(again.files_skipped, 3);
    assert_eq!(again.vectors_embedded, 0);
    assert_eq!(svc.inputs.load(Ordering::SeqCst), embedded_once, "nothing re-embedded");

    // Append a paragraph to one document: its old chunks stay.
    std::thread::sleep(Duration::from_millis(5));
    f.write("a", &format!("{DOC_A}\n\n{APPENDED}"));
    let edit = f.sync().await;
    assert_eq!(edit.files_skipped, 2);
    assert!(edit.chunks_kept >= 1, "{edit:?}");
    assert!(edit.vectors_embedded >= 1 && edit.vectors_embedded <= 2, "{edit:?}");
    assert_eq!(svc.inputs.load(Ordering::SeqCst), embedded_once + edit.vectors_embedded);
    assert_eq!(f.top("重排序", SearchMode::Hybrid).await, "a.txt");

    // A copy of a document under another id reuses every vector.
    f.write("a2", &format!("{DOC_A}\n\n{APPENDED}"));
    let copy = f.sync().await;
    assert_eq!(copy.vectors_embedded, 0);
    assert!(copy.vectors_reused >= 2, "{copy:?}");
    // Identical texts are returned once.
    let hits = f.search("重排序", SearchMode::Keyword).await.chunks;
    let texts: Vec<&str> = hits.iter().map(|c| c.text.as_str()).collect();
    let unique: std::collections::HashSet<&str> = texts.iter().copied().collect();
    assert_eq!(texts.len(), unique.len());
}

#[tokio::test]
async fn a_changed_model_never_mixes_vectors_and_rebuilds_only_when_asked() {
    let svc = service().await;
    let f = Fixture::new("model-change", &svc.server.base()).await;
    f.sync().await;
    f.engine.update_config(&json!({"embedding": {"model": "model-b"}})).unwrap();

    let info = f.engine.index_info().await;
    assert_eq!(info.vector_state, VectorState::Stale);
    assert!(info.needs_rebuild);
    assert_eq!(info.rebuild_reasons, vec!["model_changed"]);
    assert_eq!(info.pending_vectors, info.chunks, "every chunk needs the new model");

    // Searches use keywords only and don't even embed the query.
    let before = svc.server.hits();
    let out = f.search("预算会议", SearchMode::Semantic).await;
    assert!(!out.vector_used);
    assert_eq!(out.degraded.as_deref(), Some("vectors_stale"));
    assert_eq!(out.chunks[0].source_file, "b.txt");
    assert_eq!(svc.server.hits(), before);

    // A normal sync does not spend anything on the new model.
    let s = f.sync().await;
    assert_eq!(s.vectors_embedded, 0);
    assert_eq!(svc.server.hits(), before);

    // The confirmed rebuild embeds everything into a new space and switches.
    let r = f.engine.run(JobKind::Rebuild).await.unwrap();
    assert!(r.switched_space, "{r:?}");
    assert_eq!(r.vectors_embedded, info.chunks);
    let info = f.engine.index_info().await;
    assert_eq!(info.vector_state, VectorState::Ready);
    assert_eq!(info.active_space.as_ref().unwrap().dims, 8);
    assert_eq!(info.active_space.as_ref().unwrap().model, "model-b");
    assert_eq!(f.engine.store().unwrap().list_spaces().unwrap().len(), 1, "old vectors deleted");
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert!(out.vector_used);
    assert_eq!(out.chunks[0].source_file, "b.txt");
}

#[tokio::test]
async fn changed_chunk_settings_wait_for_a_rebuild() {
    let svc = service().await;
    let f = Fixture::new("chunking", &svc.server.base()).await;
    f.sync().await;
    f.engine.update_config(&json!({"chunk_size": 96})).unwrap();
    let info = f.engine.index_info().await;
    assert_eq!(info.stale_documents, 3);
    assert_eq!(info.rebuild_reasons, vec!["chunking_changed"]);
    assert_eq!(info.vector_state, VectorState::Ready, "vectors still match the model");
    assert_eq!(f.sync().await.files_skipped, 3);
    let r = f.engine.run(JobKind::Rebuild).await.unwrap();
    assert_eq!(r.files_skipped, 0);
    let info = f.engine.index_info().await;
    assert_eq!(info.stale_documents, 0);
    assert!(!info.needs_rebuild);
    assert_eq!(info.pending_vectors, 0);
}

#[tokio::test]
async fn removed_documents_disappear_from_results() {
    let svc = service().await;
    let f = Fixture::new("remove", &svc.server.base()).await;
    f.sync().await;
    f.host.resources.lock().unwrap().retain(|r| r.id != "b");
    let s = f.sync().await;
    assert_eq!(s.files_removed, 1);
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert!(out.chunks.iter().all(|c| c.source_file != "b.txt"));
    let r = f.engine.run(JobKind::Remove { resource_id: "c".into() }).await.unwrap();
    assert!(r.chunks_removed >= 1);
    assert!(f.search("billing", SearchMode::Hybrid).await.chunks.iter().all(|c| c.source_file != "c.txt"));
    assert_eq!(f.engine.index_info().await.documents, 1);
}

#[tokio::test]
async fn embedding_errors_keep_keyword_search_working() {
    let svc = service().await;
    svc.fail.store(401, Ordering::SeqCst);
    let f = Fixture::new("auth", &svc.server.base()).await;
    let s = f.sync().await;
    assert_eq!(s.error_kind.as_deref(), Some("auth"));
    assert!(s.error.as_deref().unwrap().contains("401"));
    assert_eq!(s.vectors_embedded, 0);
    let info = f.engine.index_info().await;
    assert_eq!(info.vector_state, VectorState::Empty);
    assert_eq!(info.pending_vectors, info.chunks);
    assert_eq!(info.last_error.as_ref().unwrap().kind, "auth");
    assert!(f.host.statuses().contains(&"error".to_string()));
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(out.chunks[0].source_file, "b.txt");
    assert!(!out.vector_used);

    // Once the service accepts the key, the next sync fills the vectors in.
    svc.fail.store(0, Ordering::SeqCst);
    let s = f.sync().await;
    assert_eq!(s.vectors_embedded, info.chunks);
    assert_eq!(f.engine.index_info().await.vector_state, VectorState::Ready);
}

#[tokio::test]
async fn unconfigured_embeddings_still_give_keyword_results() {
    let dir = temp_dir("unconfigured");
    let host = Arc::new(FakeHost::default());
    let engine = RagEngine::start_with(&dir.join("rag"), host.clone(), fast());
    engine.update_config(&json!({"enabled": true, "indexing": {"auto_index": false}})).unwrap();
    std::fs::write(dir.join("docs").join("b.txt"), DOC_B).unwrap();
    host.resources.lock().unwrap().push(ResourceInfo {
        id: "b".into(),
        name: "b.txt".into(),
        file_type: "txt".into(),
        path: dir.join("docs").join("b.txt").to_string_lossy().to_string(),
    });
    let s = engine.run(JobKind::Sync { resources: None, force: false }).await.unwrap();
    assert!(s.error.is_none() && s.chunks_inserted >= 1);
    let info = engine.index_info().await;
    assert_eq!(info.vector_state, VectorState::Unconfigured);
    assert_eq!(info.pending_vectors, 0);
    let out = engine.search("财务报表", SearchParams { top_k: 3, mode: SearchMode::Hybrid, semantic_weight: 0.7 }).await.unwrap();
    assert_eq!(out.chunks[0].source_file, "b.txt");
    assert_eq!(out.degraded.as_deref(), Some("vectors_unconfigured"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_index_and_config_survive_a_restart() {
    let svc = service().await;
    let f = Fixture::new("restart", &svc.server.base()).await;
    f.sync().await;
    let chunks = f.engine.index_info().await.chunks;
    // A second engine on the same folder loads the stored config and vectors.
    let host = Arc::new(FakeHost::default());
    *host.resources.lock().unwrap() = f.host.resources.lock().unwrap().clone();
    let engine = RagEngine::start_with(&f.dir.join("rag"), host, fast());
    assert_eq!(engine.config().embedding.model, "model-a");
    let mut ready = false;
    for _ in 0..100 {
        if engine.vector_state(&engine.config()) == VectorState::Ready {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ready, "vectors loaded");
    let info = engine.index_info().await;
    assert_eq!((info.chunks, info.vectors), (chunks, chunks));
    let out = engine.search("预算会议", SearchParams { top_k: 3, mode: SearchMode::Semantic, semantic_weight: 0.7 }).await.unwrap();
    assert!(out.vector_used);
    assert_eq!(out.chunks[0].source_file, "b.txt");
}

#[tokio::test]
async fn first_build_is_automatic_but_only_once_configured() {
    let svc = service().await;
    let dir = temp_dir("auto");
    let host = Arc::new(FakeHost::default());
    let engine = RagEngine::start_with(&dir.join("rag"), host.clone(), fast());
    std::fs::write(dir.join("docs").join("b.txt"), DOC_B).unwrap();
    host.resources.lock().unwrap().push(ResourceInfo {
        id: "b".into(),
        name: "b.txt".into(),
        file_type: "txt".into(),
        path: dir.join("docs").join("b.txt").to_string_lossy().to_string(),
    });
    // Turning RAG on queues a sync (keywords only: no model yet).
    engine.update_config(&json!({"enabled": true})).unwrap();
    // Configuring the model queues the first embedding pass.
    engine.update_config(&json!({"embedding": {"base_url": svc.server.base(), "model": "model-a"}})).unwrap();
    let mut done = false;
    for _ in 0..200 {
        if engine.index_info().await.vector_state == VectorState::Ready && engine.index_info().await.pending_vectors == 0 {
            done = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(done, "first build ran by itself");
    // Changing the model afterwards queues nothing paid.
    let hits = svc.server.hits();
    engine.update_config(&json!({"embedding": {"model": "model-b"}})).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(svc.server.hits(), hits);
    assert_eq!(engine.index_info().await.vector_state, VectorState::Stale);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn cancelling_stops_the_job_and_keeps_finished_batches() {
    let svc = service().await;
    let slow = FakeServer::start(|req| {
        let body = req.json();
        let n = body["input"].as_array().unwrap().len();
        Reply::json(200, json!({"data": (0..n).map(|i| json!({"index": i, "embedding": [1.0, i as f32 + 1.0]})).collect::<Vec<_>>()}))
            .delayed(Duration::from_millis(300))
    })
    .await;
    drop(svc);
    let f = Fixture::new("cancel", &slow.base()).await;
    let engine = f.engine.clone();
    let job = tokio::spawn(async move { engine.run(JobKind::Sync { resources: None, force: false }).await });
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(f.engine.cancel_current());
    let s = job.await.unwrap().unwrap();
    assert!(s.cancelled, "{s:?}");
    assert!(f.host.statuses().contains(&"cancelled".to_string()));
    assert!(!f.engine.cancel_current(), "idle now");
}

#[tokio::test]
async fn meetings_pause_a_local_model_and_slow_a_remote_one() {
    let svc = service().await;
    let f = Fixture::new("meeting", &svc.server.base()).await;
    f.engine.update_config(&json!({"embedding": {"max_concurrency": 4}})).unwrap();
    f.host.meeting.store(true, Ordering::SeqCst);
    let engine = f.engine.clone();
    let job = tokio::spawn(async move { engine.run(JobKind::Sync { resources: None, force: false }).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    // 127.0.0.1 is this machine: paused while the meeting runs.
    assert!(f.host.statuses().contains(&"paused".to_string()));
    assert_eq!(svc.inputs.load(Ordering::SeqCst), 0);
    f.host.meeting.store(false, Ordering::SeqCst);
    let s = job.await.unwrap().unwrap();
    assert!(s.vectors_embedded > 0 && s.error.is_none());
}

#[tokio::test]
async fn secrets_go_to_the_keychain_and_only_a_hint_is_stored() {
    let svc = service().await;
    let f = Fixture::new("secret", &svc.server.base()).await;
    assert_eq!(f.host.secret_reads.load(Ordering::SeqCst), 0);
    let c = f.engine.set_secret(Some("  sk-abcdef123456  ")).unwrap();
    assert!(c.embedding.key_saved);
    assert_eq!(c.embedding.key_hint, "3456");
    assert_eq!(f.host.secrets.lock().unwrap()["rag-embedding"], "sk-abcdef123456");
    let stored = std::fs::read_to_string(f.engine.config_path()).unwrap();
    assert!(!stored.contains("sk-abcdef"), "the key is not in config.json");
    let c = f.engine.set_secret(None).unwrap();
    assert!(!c.embedding.key_saved && c.embedding.key_hint.is_empty());
    assert!(f.host.secrets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn test_embedding_uses_a_draft_without_saving_it() {
    let svc = service().await;
    let f = Fixture::new("draft", "http://127.0.0.1:9/v1").await;
    let r = f
        .engine
        .test_embedding(Some(&json!({"embedding": {"base_url": svc.server.base(), "model": "model-b"}})))
        .await
        .unwrap();
    assert!(r.ok, "{r:?}");
    assert_eq!(r.dims, Some(8));
    assert_eq!(f.engine.config().embedding.base_url, "http://127.0.0.1:9/v1", "draft not saved");
}

#[tokio::test]
async fn clear_empties_everything() {
    let svc = service().await;
    let f = Fixture::new("clear", &svc.server.base()).await;
    f.sync().await;
    f.engine.run(JobKind::Clear).await.unwrap();
    let info = f.engine.index_info().await;
    assert_eq!((info.documents, info.chunks, info.vectors), (0, 0, 0));
    assert!(info.active_space.is_none());
    assert!(f.search("预算", SearchMode::Hybrid).await.chunks.is_empty());
}

// ── Reranking ───────────────────────────────────────────────────────────────

/// How relevant the fake reranker finds a text: the roadmap document (c)
/// first, then the budget one (b), then the vector one (a).
fn relevance(text: &str) -> f64 {
    if text.contains("roadmap") {
        0.9
    } else if text.contains("预算") {
        0.6
    } else if text.contains("向量") {
        0.3
    } else {
        0.1
    }
}

#[derive(Debug, Clone)]
struct RerankCall {
    path: String,
    auth: Option<String>,
    body: Value,
}

/// A fake `/rerank` service answering with `reply`; records every request.
struct Reranker {
    server: FakeServer,
    calls: Arc<Mutex<Vec<RerankCall>>>,
}

async fn reranker(reply: impl Fn(&Value) -> Reply + Send + Sync + 'static) -> Reranker {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let server = FakeServer::start(move |req| {
        let body = req.json();
        seen.lock().unwrap().push(RerankCall { path: req.path.clone(), auth: req.header("authorization"), body: body.clone() });
        reply(&body)
    })
    .await;
    Reranker { server, calls }
}

/// Jina / Cohere style: `results` best first, cut to `top_n`.
fn generic_reply(body: &Value) -> Reply {
    let docs = body["documents"].as_array().cloned().unwrap_or_default();
    let mut results: Vec<Value> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| json!({"index": i, "relevance_score": relevance(d.as_str().unwrap_or_default())}))
        .collect();
    results.sort_by(|a, b| b["relevance_score"].as_f64().partial_cmp(&a["relevance_score"].as_f64()).unwrap());
    if let Some(n) = body["top_n"].as_u64() {
        results.truncate(n as usize);
    }
    Reply::json(200, json!({ "results": results }))
}

fn chunk_ids(out: &SearchOutcome) -> Vec<String> {
    out.chunks.iter().map(|c| c.chunk_id.clone()).collect()
}

fn files(out: &SearchOutcome) -> Vec<&str> {
    out.chunks.iter().map(|c| c.source_file.as_str()).collect()
}

#[tokio::test]
async fn rerank_reorders_the_fused_results_with_the_key_from_the_keychain() {
    let svc = service().await;
    let rr = reranker(generic_reply).await;
    let f = Fixture::new("rerank", &svc.server.base()).await;
    f.sync().await;
    let fused = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(fused.chunks[0].source_file, "b.txt");
    let chunks = f.engine.index_info().await.chunks;

    let c = f.engine.set_rerank_secret(Some("  rk-secret-1234  ")).unwrap();
    assert!(c.rerank.key_saved);
    assert_eq!(c.rerank.key_hint, "1234");
    assert_eq!(f.host.secrets.lock().unwrap()["rag-rerank"], "rk-secret-1234");
    assert!(!std::fs::read_to_string(f.engine.config_path()).unwrap().contains("rk-secret"), "the key is not in config.json");
    f.engine
        .update_config(&json!({"rerank": {"enabled": true, "base_url": format!("{}/v1", rr.server.base()), "model": "rr-model"}}))
        .unwrap();

    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(files(&out), vec!["c.txt", "b.txt", "a.txt"]);
    let report = out.rerank.as_ref().expect("a rerank report");
    assert_eq!(report.status, RerankStatus::Applied);
    assert_eq!(report.candidates, chunks, "every fused chunk is a candidate (30 allowed)");
    assert!(report.error.is_none());
    // `score` is the reranker's; the fusion position and score are kept.
    assert_eq!(out.chunks[0].score, 0.9);
    assert_eq!(out.chunks[0].normalized_score, 1.0);
    assert!((out.chunks[1].normalized_score - 0.6 / 0.9).abs() < 1e-9);
    assert!(out.chunks[0].fused_rank.unwrap() > 1);
    assert_eq!(out.chunks[1].fused_rank, Some(1), "b.txt was first after fusion");
    assert_eq!(out.chunks[1].fused_score, Some(fused.chunks[0].score));

    let calls = rr.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].path, "/v1/rerank");
    assert_eq!(calls[0].auth.as_deref(), Some("Bearer rk-secret-1234"));
    assert_eq!(calls[0].body["model"], "rr-model");
    assert_eq!(calls[0].body["query"], "预算会议");
    assert_eq!(calls[0].body["top_n"], 3, "top_k");
    let sent = calls[0].body["documents"].as_array().unwrap();
    assert_eq!(sent.len(), chunks);
    assert_eq!(sent[0], fused.chunks[0].text.as_str(), "candidates go in fusion order");

    // Only the top-k come back, even when there are more candidates.
    let out = f.engine.search("预算会议", SearchParams { top_k: 1, mode: SearchMode::Hybrid, semantic_weight: 0.7 }).await.unwrap();
    assert_eq!(files(&out), vec!["c.txt"]);

    // A removed key is no longer sent.
    let c = f.engine.set_rerank_secret(None).unwrap();
    assert!(!c.rerank.key_saved && c.rerank.key_hint.is_empty());
    assert!(!f.host.secrets.lock().unwrap().contains_key("rag-rerank"));
    f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(rr.calls.lock().unwrap().last().unwrap().auth, None);
}

#[tokio::test]
async fn a_failing_or_slow_reranker_keeps_the_fusion_order() {
    let svc = service().await;
    let f = Fixture::new("rerank-fail", &svc.server.base()).await;
    f.sync().await;
    let fused = f.search("预算会议", SearchMode::Hybrid).await;

    // Turned on without a model: nothing to send to.
    f.engine.update_config(&json!({"rerank": {"enabled": true, "base_url": "http://127.0.0.1:9/v1"}})).unwrap();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(chunk_ids(&out), chunk_ids(&fused));
    let report = out.rerank.unwrap();
    assert_eq!(report.status, RerankStatus::Unconfigured);
    assert_eq!((report.error_kind.as_deref(), report.candidates), (Some("config"), 0));

    // The service fails.
    let broken = reranker(|_| Reply::text(500, "reranker crashed")).await;
    f.engine.update_config(&json!({"rerank": {"base_url": broken.server.base(), "model": "rr"}})).unwrap();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(chunk_ids(&out), chunk_ids(&fused));
    assert_eq!(out.chunks[0].score, fused.chunks[0].score);
    assert!(out.chunks.iter().all(|c| c.fused_rank.is_none() && c.fused_score.is_none()));
    let report = out.rerank.unwrap();
    assert_eq!(report.status, RerankStatus::Failed);
    assert_eq!(report.error_kind.as_deref(), Some("transient"));
    assert!(report.error.unwrap().contains("500"));

    // The service answers too late.
    let slow = reranker(|body| generic_reply(body).delayed(Duration::from_millis(1500))).await;
    f.engine.update_config(&json!({"rerank": {"base_url": slow.server.base(), "timeout_ms": 200}})).unwrap();
    let started = Instant::now();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert!(started.elapsed() < Duration::from_millis(1200), "waited {:?}", started.elapsed());
    assert_eq!(chunk_ids(&out), chunk_ids(&fused));
    let report = out.rerank.unwrap();
    assert_eq!(report.status, RerankStatus::Failed);
    assert_eq!(report.error_kind.as_deref(), Some("transient"));
    assert!(report.error.unwrap().contains("timed out"));
    assert_eq!(slow.server.hits(), 1);

    // An answer without results.
    let empty = reranker(|_| Reply::json(200, json!({"results": []}))).await;
    f.engine.update_config(&json!({"rerank": {"base_url": empty.server.base(), "timeout_ms": 2500}})).unwrap();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(chunk_ids(&out), chunk_ids(&fused));
    assert_eq!(out.rerank.unwrap().error_kind.as_deref(), Some("bad_response"));
}

#[tokio::test]
async fn repeated_rerank_failures_pause_it_until_the_settings_change_or_a_test_passes() {
    let svc = service().await;
    let down = Arc::new(AtomicBool::new(true));
    let flag = down.clone();
    let flaky = reranker(move |body| if flag.load(Ordering::SeqCst) { Reply::text(502, "bad gateway") } else { generic_reply(body) }).await;
    let f = Fixture::new("rerank-pause", &svc.server.base()).await;
    f.sync().await;
    let fused = f.search("预算会议", SearchMode::Hybrid).await;
    f.engine.update_config(&json!({"rerank": {"enabled": true, "base_url": flaky.server.base(), "model": "rr"}})).unwrap();
    for _ in 0..3 {
        assert_eq!(f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap().status, RerankStatus::Failed);
    }
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(out.rerank.as_ref().unwrap().status, RerankStatus::Paused);
    assert_eq!(chunk_ids(&out), chunk_ids(&fused));
    assert_eq!(flaky.server.hits(), 3, "nothing sent while paused");
    // Any change to the rerank settings tries again at once.
    f.engine.update_config(&json!({"rerank": {"timeout_ms": 3000}})).unwrap();
    assert_eq!(f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap().status, RerankStatus::Failed);
    assert_eq!(flaky.server.hits(), 4);
    for _ in 0..2 {
        f.search("预算会议", SearchMode::Hybrid).await;
    }
    assert_eq!(f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap().status, RerankStatus::Paused);
    // The service is back: a draft test leaves the pause, a test of the saved settings lifts it.
    down.store(false, Ordering::SeqCst);
    assert!(f.engine.test_rerank(Some(&json!({"rerank": {"candidates": 10}}))).await.unwrap().ok);
    assert_eq!(f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap().status, RerankStatus::Paused);
    assert!(f.engine.test_rerank(None).await.unwrap().ok);
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(out.rerank.as_ref().unwrap().status, RerankStatus::Applied);
    assert_eq!(files(&out)[0], "c.txt");
}

#[tokio::test]
async fn rerank_off_sends_nothing_and_changes_nothing() {
    let svc = service().await;
    let rr = reranker(generic_reply).await;
    let f = Fixture::new("rerank-off", &svc.server.base()).await;
    f.sync().await;
    let scored = |out: &SearchOutcome| out.chunks.iter().map(|c| (c.chunk_id.clone(), c.score, c.normalized_score)).collect::<Vec<_>>();
    let mut before = Vec::new();
    for mode in [SearchMode::Hybrid, SearchMode::Semantic, SearchMode::Keyword] {
        before.push(scored(&f.search("预算会议", mode).await));
    }

    // Fully configured but off (the default).
    f.engine.set_rerank_secret(Some("rk-secret-1234")).unwrap();
    f.engine.update_config(&json!({"rerank": {"base_url": rr.server.base(), "model": "rr"}})).unwrap();
    assert!(!f.engine.config().rerank.enabled);
    for (i, mode) in [SearchMode::Hybrid, SearchMode::Semantic, SearchMode::Keyword].into_iter().enumerate() {
        let out = f.search("预算会议", mode).await;
        assert!(out.rerank.is_none(), "{mode:?}");
        assert!(out.chunks.iter().all(|c| c.fused_rank.is_none() && c.fused_score.is_none()));
        assert_eq!(scored(&out), before[i], "{mode:?}: same results as before");
    }
    assert_eq!(rr.server.hits(), 0);

    // On, then off again.
    f.engine.update_config(&json!({"rerank": {"enabled": true}})).unwrap();
    assert_eq!(f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap().status, RerankStatus::Applied);
    f.engine.update_config(&json!({"rerank": {"enabled": false}})).unwrap();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert!(out.rerank.is_none());
    assert_eq!(scored(&out), before[0]);
    assert_eq!(rr.server.hits(), 1);
}

#[tokio::test]
async fn tei_logits_keep_their_order_in_the_normalized_scores() {
    let svc = service().await;
    let tei = reranker(|body| {
        assert!(body.get("model").is_none() && body.get("documents").is_none(), "{body}");
        let texts = body["texts"].as_array().cloned().unwrap_or_default();
        // Raw logits, all negative: dividing by the best would flip the order.
        let logits: Vec<Value> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| json!({"index": i, "score": (relevance(t.as_str().unwrap_or_default()) - 1.0) * 10.0}))
            .collect();
        Reply::json(200, Value::Array(logits))
    })
    .await;
    let f = Fixture::new("rerank-tei", &svc.server.base()).await;
    f.sync().await;
    f.engine.update_config(&json!({"rerank": {"enabled": true, "format": "tei", "base_url": tei.server.base()}})).unwrap();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(out.rerank.as_ref().unwrap().status, RerankStatus::Applied);
    assert_eq!(files(&out), vec!["c.txt", "b.txt", "a.txt"]);
    assert!((out.chunks[0].score + 1.0).abs() < 1e-9, "the raw logit is kept as the score");
    assert_eq!(out.chunks[0].normalized_score, 1.0);
    let normalized: Vec<f64> = out.chunks.iter().map(|c| c.normalized_score).collect();
    assert!(normalized.windows(2).all(|w| w[0] > w[1] && w[1] > 0.0), "{normalized:?}");
    assert_eq!(tei.calls.lock().unwrap()[0].path, "/rerank");
}

#[tokio::test]
async fn rerank_can_reuse_an_llm_connection() {
    let svc = service().await;
    let rr = reranker(generic_reply).await;
    let f = Fixture::new("rerank-connection", &svc.server.base()).await;
    f.sync().await;
    f.host.connections.lock().unwrap().push(ResolvedConnection {
        id: "llm-1".into(),
        kind: LlmKind::OpenAiCompat,
        base_url: format!("{}/v1", rr.server.base()),
        headers: vec![("Authorization".into(), "Bearer llm-key".into())],
        timeout: None,
    });
    // The rerank section's own key is not used with a connection.
    f.engine.set_rerank_secret(Some("rk-own-key-5678")).unwrap();
    f.engine.update_config(&json!({"rerank": {"enabled": true, "connection_id": "llm-1", "model": "rr"}})).unwrap();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert_eq!(out.rerank.as_ref().unwrap().status, RerankStatus::Applied);
    assert_eq!(files(&out)[0], "c.txt");
    let call = rr.calls.lock().unwrap()[0].clone();
    assert_eq!(call.path, "/v1/rerank");
    assert_eq!(call.auth.as_deref(), Some("Bearer llm-key"));

    // The connection gets another address in the LLM settings: the next search follows it.
    let moved = reranker(generic_reply).await;
    f.host.connections.lock().unwrap()[0].base_url = moved.server.base();
    assert_eq!(f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap().status, RerankStatus::Applied);
    assert_eq!((rr.server.hits(), moved.server.hits()), (1, 1));

    // The connection is deleted: nothing more goes through it, and the report says why.
    f.host.connections.lock().unwrap().clear();
    let report = f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap();
    assert_eq!(report.status, RerankStatus::Unconfigured);
    let error = report.error.unwrap();
    assert!(error.contains("reused for reranking") && error.contains("llm-1"), "{error}");
    assert_eq!((rr.server.hits(), moved.server.hits()), (1, 1));

    // A connection id that never existed: the same.
    f.engine.update_config(&json!({"rerank": {"connection_id": "llm-2"}})).unwrap();
    let report = f.search("预算会议", SearchMode::Hybrid).await.rerank.unwrap();
    assert_eq!(report.status, RerankStatus::Unconfigured);
    assert!(report.error.unwrap().contains("llm-2"));
}

#[tokio::test]
async fn embeddings_reuse_an_llm_connection_and_a_deleted_one_is_a_clear_error() {
    let svc = service().await;
    let f = Fixture::new("embedding-connection", "http://127.0.0.1:9/v1").await;
    f.host.connections.lock().unwrap().push(ResolvedConnection {
        id: "llm-1".into(),
        kind: LlmKind::OpenAiCompat,
        base_url: svc.server.base(),
        headers: vec![("Authorization".into(), "Bearer llm-key".into())],
        timeout: None,
    });
    f.engine.update_config(&json!({"embedding": {"connection_id": "llm-1"}})).unwrap();
    let s = f.sync().await;
    assert!(s.error.is_none() && s.vectors_embedded > 0, "{s:?}");
    assert!(f.search("预算会议", SearchMode::Hybrid).await.vector_used);

    // Deleted in the LLM settings: no request goes through it any more,
    // keywords still answer, and every place that shows errors says why.
    f.host.connections.lock().unwrap().clear();
    let hits = svc.server.hits();
    let out = f.search("预算会议", SearchMode::Hybrid).await;
    assert!(!out.vector_used);
    assert_eq!(out.chunks[0].source_file, "b.txt");
    let degraded = out.degraded.unwrap();
    assert!(degraded.contains("reused for embeddings") && degraded.contains("llm-1"), "{degraded}");
    let err = f.engine.test_embedding(None).await.unwrap_err();
    assert!(err.contains("reused for embeddings"), "{err}");
    f.write("d", APPENDED);
    let s = f.sync().await;
    assert_eq!(s.error_kind.as_deref(), Some("config"));
    assert!(s.error.unwrap().contains("reused for embeddings"));
    assert!(f.engine.index_info().await.last_error.unwrap().message.contains("llm-1"));
    assert_eq!(svc.server.hits(), hits);

    // Saving the own address instead (what the settings page sends) works at once.
    f.engine.update_config(&json!({"embedding": {"connection_id": "", "base_url": svc.server.base()}})).unwrap();
    assert!(f.engine.test_embedding(None).await.unwrap().ok);
    assert_eq!(f.sync().await.error, None);
    assert!(f.search("预算会议", SearchMode::Hybrid).await.vector_used);
}

#[tokio::test]
async fn test_rerank_uses_a_draft_without_saving_it() {
    let svc = service().await;
    let rr = reranker(generic_reply).await;
    let f = Fixture::new("rerank-draft", &svc.server.base()).await;
    let r = f
        .engine
        .test_rerank(Some(&json!({"rerank": {"base_url": rr.server.base(), "model": "rr"}})))
        .await
        .unwrap();
    assert!(r.ok, "{r:?}");
    assert_eq!(r.ranked_correctly, Some(true));
    assert!(r.url.ends_with("/rerank"), "{}", r.url);
    assert_eq!(f.engine.config().rerank.base_url, "", "draft not saved");
    // Nothing configured: an error instead of a request.
    assert!(f.engine.test_rerank(None).await.unwrap_err().contains("model"));
    assert_eq!(rr.server.hits(), 1);
}
