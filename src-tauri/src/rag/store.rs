//! `<app data>/rag/rag.db`: the RAG index, kept apart from `nexq.db` so the
//! meeting database never waits on it, a reset is one file, and gigabytes of
//! vectors don't bloat the main database.
//!
//! Layout (schema version in `PRAGMA user_version`):
//! - `rag_documents`: one row per context resource, with the size, mtime and
//!   content hash used to skip unchanged files.
//! - `rag_chunks`: integer ids that are also the FTS rowid and the vector key;
//!   `chunk_hash` (sha256 of the text) lets unchanged chunks keep their row
//!   and lets a moved or duplicated chunk reuse an existing vector.
//! - `rag_spaces`: one per embedding model setup (see `RagConfig::space_key`);
//!   vectors of different spaces are never compared.
//! - `rag_vectors`: L2-normalized f32 little-endian vectors per (space, chunk).
//! - `rag_fts`: contentless FTS5 over the bigram text from `cjk.rs`.
//!
//! Every function is synchronous: call them from `spawn_blocking`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;

use super::cjk;
use super::vector_store::{bytes_to_f32_vec, f32_vec_to_bytes};

/// Current schema version.
pub const SCHEMA_VERSION: i32 = 1;

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS rag_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rag_spaces (
    id INTEGER PRIMARY KEY,
    space_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    descriptor TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'building',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rag_spaces_key ON rag_spaces(space_key);
CREATE TABLE IF NOT EXISTS rag_documents (
    id INTEGER PRIMARY KEY,
    resource_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    file_type TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    content_hash BLOB,
    chunk_params TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    token_total INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rag_chunks (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_est INTEGER NOT NULL,
    chunk_hash BLOB NOT NULL,
    start_char INTEGER NOT NULL DEFAULT 0,
    end_char INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rag_chunks_doc ON rag_chunks(doc_id, ord);
CREATE INDEX IF NOT EXISTS rag_chunks_hash ON rag_chunks(chunk_hash);
CREATE TABLE IF NOT EXISTS rag_vectors (
    id INTEGER PRIMARY KEY,
    space_id INTEGER NOT NULL REFERENCES rag_spaces(id) ON DELETE CASCADE,
    chunk_id INTEGER NOT NULL REFERENCES rag_chunks(id) ON DELETE CASCADE,
    vec BLOB NOT NULL,
    UNIQUE (chunk_id, space_id)
);
CREATE INDEX IF NOT EXISTS rag_vectors_space ON rag_vectors(space_id, chunk_id);
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
    body,
    tokenize = 'porter unicode61 remove_diacritics 2',
    content = '',
    contentless_delete = 1
);
";

/// A vector space (one embedding model setup).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpaceRow {
    pub id: i64,
    pub space_key: String,
    pub fingerprint: String,
    pub provider: String,
    pub model: String,
    pub dims: usize,
    pub status: String,
    pub created_at: i64,
}

/// A stored document.
#[derive(Debug, Clone, PartialEq)]
pub struct DocRow {
    pub id: i64,
    pub resource_id: String,
    pub name: String,
    pub file_type: String,
    pub path: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub content_hash: Option<Vec<u8>>,
    pub chunk_params: String,
    pub status: String,
    pub error: Option<String>,
    pub chunk_count: usize,
    pub token_total: usize,
    pub updated_at: i64,
}

/// What is known about a document's file.
#[derive(Debug, Clone)]
pub struct DocMeta {
    pub resource_id: String,
    pub name: String,
    pub file_type: String,
    pub path: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
}

/// A chunk to store.
#[derive(Debug, Clone)]
pub struct NewChunk {
    pub ord: usize,
    pub text: String,
    pub token_est: usize,
    pub hash: Vec<u8>,
    pub start_char: usize,
    pub end_char: usize,
}

/// Result of [`Store::apply_document`].
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ApplyOutcome {
    pub doc_id: i64,
    /// Chunk ids deleted (their vectors and FTS rows went with them).
    pub removed: Vec<i64>,
    /// Chunks whose text was already stored: same id, vectors kept.
    pub kept: usize,
    /// New chunk ids.
    pub inserted: Vec<i64>,
    /// (space id, chunk id) of vectors copied from an identical chunk.
    pub copied: Vec<(i64, i64)>,
}

/// Text and source of a chunk, for search results.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkDetail {
    pub id: i64,
    pub text: String,
    pub ord: usize,
    pub hash: Vec<u8>,
    pub doc_name: String,
    pub resource_id: String,
}

/// Counts for the status display.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StoreStats {
    pub documents: usize,
    pub documents_indexed: usize,
    pub documents_error: usize,
    pub chunks: usize,
    pub tokens: usize,
    /// Vectors in the asked space.
    pub vectors: usize,
    pub last_indexed_at_ms: Option<i64>,
}

pub struct Store {
    path: PathBuf,
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
}

fn err(e: rusqlite::Error) -> String {
    format!("RAG index database error: {e}")
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Store {
    /// Opens (creating and migrating) the database. A file SQLite can't read
    /// is moved aside as `rag.db.corrupt-<time>` and a fresh one is created:
    /// everything in it can be rebuilt from the context files.
    pub fn open(path: &Path) -> Result<Store, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        }
        match Self::open_inner(path) {
            Ok(store) => Ok(store),
            Err(OpenError::Corrupt(detail)) => {
                let aside = path.with_extension(format!("db.corrupt-{}", now_ms()));
                log::error!("rag.db unreadable ({detail}); moving it to {}", aside.display());
                std::fs::rename(path, &aside).map_err(|e| format!("Cannot move the damaged index aside: {e}"))?;
                for ext in ["db-wal", "db-shm"] {
                    let _ = std::fs::remove_file(path.with_extension(ext));
                }
                Self::open_inner(path).map_err(|e| e.message())
            }
            Err(e) => Err(e.message()),
        }
    }

    fn open_inner(path: &Path) -> Result<Store, OpenError> {
        let writer = open_connection(path, true)?;
        migrate(&writer)?;
        let reader = open_connection(path, false)?;
        Ok(Store { path: path.to_path_buf(), writer: Mutex::new(writer), reader: Mutex::new(reader) })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        self.writer.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn reader(&self) -> MutexGuard<'_, Connection> {
        self.reader.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── Meta and spaces ─────────────────────────────────────────────────────

    pub fn meta(&self, key: &str) -> Result<Option<String>, String> {
        self.writer()
            .query_row("SELECT value FROM rag_meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.writer()
            .execute(
                "INSERT INTO rag_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// The space searches use, if any.
    pub fn active_space(&self) -> Result<Option<SpaceRow>, String> {
        let Some(id) = self.meta("active_space_id")?.and_then(|v| v.parse::<i64>().ok()) else {
            return Ok(None);
        };
        self.space(id)
    }

    pub fn space(&self, id: i64) -> Result<Option<SpaceRow>, String> {
        self.writer()
            .query_row(
                "SELECT id, space_key, fingerprint, provider, model, dims, status, created_at
                 FROM rag_spaces WHERE id = ?1",
                [id],
                space_row,
            )
            .optional()
            .map_err(err)
    }

    /// The newest space made with `space_key` (a rebuild resumes into it).
    pub fn space_by_key(&self, space_key: &str) -> Result<Option<SpaceRow>, String> {
        self.writer()
            .query_row(
                "SELECT id, space_key, fingerprint, provider, model, dims, status, created_at
                 FROM rag_spaces WHERE space_key = ?1 ORDER BY id DESC LIMIT 1",
                [space_key],
                space_row,
            )
            .optional()
            .map_err(err)
    }

    pub fn list_spaces(&self) -> Result<Vec<SpaceRow>, String> {
        let conn = self.writer();
        let mut stmt = conn
            .prepare("SELECT id, space_key, fingerprint, provider, model, dims, status, created_at FROM rag_spaces ORDER BY id")
            .map_err(err)?;
        let rows = stmt.query_map([], space_row).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Creates the space for `fingerprint` (or returns the existing one).
    pub fn create_space(
        &self,
        space_key: &str,
        fingerprint: &str,
        provider: &str,
        model: &str,
        dims: usize,
        descriptor: &str,
    ) -> Result<SpaceRow, String> {
        let conn = self.writer();
        conn.execute(
            "INSERT OR IGNORE INTO rag_spaces (space_key, fingerprint, provider, model, dims, descriptor, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'building', ?7)",
            params![space_key, fingerprint, provider, model, dims as i64, descriptor, now_ms()],
        )
        .map_err(err)?;
        conn.query_row(
            "SELECT id, space_key, fingerprint, provider, model, dims, status, created_at
             FROM rag_spaces WHERE fingerprint = ?1",
            [fingerprint],
            space_row,
        )
        .map_err(err)
    }

    /// Makes `id` the space searches use and marks it ready.
    pub fn activate_space(&self, id: i64) -> Result<(), String> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(err)?;
        tx.execute("UPDATE rag_spaces SET status = 'ready' WHERE id = ?1", [id]).map_err(err)?;
        tx.execute(
            "INSERT INTO rag_meta (key, value) VALUES ('active_space_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [id.to_string()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// Deletes a space and its vectors, a few thousand rows per transaction so
    /// searches and the meeting never wait on one long write.
    pub fn delete_space(&self, id: i64) -> Result<usize, String> {
        let mut removed = 0usize;
        loop {
            let n = self
                .writer()
                .execute(
                    "DELETE FROM rag_vectors WHERE id IN
                       (SELECT id FROM rag_vectors WHERE space_id = ?1 LIMIT 5000)",
                    [id],
                )
                .map_err(err)?;
            removed += n;
            if n == 0 {
                break;
            }
        }
        let conn = self.writer();
        conn.execute("DELETE FROM rag_spaces WHERE id = ?1", [id]).map_err(err)?;
        conn.execute(
            "DELETE FROM rag_meta WHERE key = 'active_space_id' AND value = ?1",
            [id.to_string()],
        )
        .map_err(err)?;
        let _ = conn.execute_batch("PRAGMA incremental_vacuum;");
        Ok(removed)
    }

    // ── Documents ───────────────────────────────────────────────────────────

    pub fn document(&self, resource_id: &str) -> Result<Option<DocRow>, String> {
        self.writer()
            .query_row(&format!("{DOC_SELECT} WHERE resource_id = ?1"), [resource_id], doc_row)
            .optional()
            .map_err(err)
    }

    pub fn list_documents(&self) -> Result<Vec<DocRow>, String> {
        let conn = self.writer();
        let mut stmt = conn.prepare(&format!("{DOC_SELECT} ORDER BY id")).map_err(err)?;
        let rows = stmt.query_map([], doc_row).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Stores a document's chunks, changing only what changed: chunks whose
    /// text is already stored for this document keep their id and vectors,
    /// the rest are deleted or inserted (with their FTS rows). A new chunk
    /// whose text exists elsewhere gets a copy of that chunk's vectors in
    /// every space. One transaction.
    pub fn apply_document(
        &self,
        meta: &DocMeta,
        content_hash: &[u8],
        chunk_params: &str,
        chunks: &[NewChunk],
    ) -> Result<ApplyOutcome, String> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(err)?;
        let token_total: usize = chunks.iter().map(|c| c.token_est).sum();
        let doc_id: i64 = tx
            .query_row(
                "INSERT INTO rag_documents
                   (resource_id, name, file_type, path, size_bytes, mtime_ms, content_hash, chunk_params,
                    status, error, chunk_count, token_total, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)
                 ON CONFLICT(resource_id) DO UPDATE SET
                   name = excluded.name, file_type = excluded.file_type, path = excluded.path,
                   size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms,
                   content_hash = excluded.content_hash, chunk_params = excluded.chunk_params,
                   status = excluded.status, error = NULL, chunk_count = excluded.chunk_count,
                   token_total = excluded.token_total, updated_at = excluded.updated_at
                 RETURNING id",
                params![
                    meta.resource_id,
                    meta.name,
                    meta.file_type,
                    meta.path,
                    meta.size_bytes,
                    meta.mtime_ms,
                    content_hash,
                    chunk_params,
                    if chunks.is_empty() { "empty" } else { "indexed" },
                    chunks.len() as i64,
                    token_total as i64,
                    now_ms(),
                ],
                |r| r.get(0),
            )
            .map_err(err)?;

        let mut pool: HashMap<Vec<u8>, Vec<(i64, i64, i64, i64)>> = HashMap::new();
        {
            let mut stmt = tx
                .prepare("SELECT id, chunk_hash, ord, start_char, end_char FROM rag_chunks WHERE doc_id = ?1 ORDER BY ord DESC")
                .map_err(err)?;
            let rows = stmt
                .query_map([doc_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
                })
                .map_err(err)?;
            for row in rows {
                let (id, hash, ord, start, end) = row.map_err(err)?;
                pool.entry(hash).or_default().push((id, ord, start, end));
            }
        }

        let mut outcome = ApplyOutcome { doc_id, ..Default::default() };
        {
            let mut update = tx
                .prepare("UPDATE rag_chunks SET ord = ?2, start_char = ?3, end_char = ?4 WHERE id = ?1")
                .map_err(err)?;
            let mut insert = tx
                .prepare(
                    "INSERT INTO rag_chunks (doc_id, ord, text, token_est, chunk_hash, start_char, end_char)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(err)?;
            let mut insert_fts = tx.prepare("INSERT INTO rag_fts (rowid, body) VALUES (?1, ?2)").map_err(err)?;
            let mut copy_vectors = tx
                .prepare(
                    "INSERT OR IGNORE INTO rag_vectors (space_id, chunk_id, vec)
                     SELECT v.space_id, ?1, v.vec FROM rag_vectors v
                     JOIN rag_chunks c ON c.id = v.chunk_id
                     WHERE c.chunk_hash = ?2 AND c.id != ?1
                     GROUP BY v.space_id",
                )
                .map_err(err)?;
            let mut copied_spaces = tx.prepare("SELECT space_id FROM rag_vectors WHERE chunk_id = ?1").map_err(err)?;

            for chunk in chunks {
                let reused = pool.get_mut(&chunk.hash).and_then(Vec::pop);
                if let Some((id, ord, start, end)) = reused {
                    if (ord, start, end) != (chunk.ord as i64, chunk.start_char as i64, chunk.end_char as i64) {
                        update
                            .execute(params![id, chunk.ord as i64, chunk.start_char as i64, chunk.end_char as i64])
                            .map_err(err)?;
                    }
                    outcome.kept += 1;
                    continue;
                }
                insert
                    .execute(params![
                        doc_id,
                        chunk.ord as i64,
                        chunk.text,
                        chunk.token_est as i64,
                        chunk.hash,
                        chunk.start_char as i64,
                        chunk.end_char as i64,
                    ])
                    .map_err(err)?;
                let id = tx.last_insert_rowid();
                insert_fts.execute(params![id, cjk::fts_document_text(&chunk.text)]).map_err(err)?;
                if copy_vectors.execute(params![id, chunk.hash]).map_err(err)? > 0 {
                    let spaces = copied_spaces
                        .query_map([id], |r| r.get::<_, i64>(0))
                        .map_err(err)?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(err)?;
                    outcome.copied.extend(spaces.into_iter().map(|s| (s, id)));
                }
                outcome.inserted.push(id);
            }

            let mut delete_fts = tx.prepare("DELETE FROM rag_fts WHERE rowid = ?1").map_err(err)?;
            let mut delete_chunk = tx.prepare("DELETE FROM rag_chunks WHERE id = ?1").map_err(err)?;
            for (id, ..) in pool.into_values().flatten() {
                delete_fts.execute([id]).map_err(err)?;
                delete_chunk.execute([id]).map_err(err)?;
                outcome.removed.push(id);
            }
        }
        outcome.removed.sort_unstable();
        tx.commit().map_err(err)?;
        Ok(outcome)
    }

    /// Records a new size / mtime / name for a document whose text did not change.
    pub fn touch_document(&self, meta: &DocMeta) -> Result<(), String> {
        self.writer()
            .execute(
                "UPDATE rag_documents SET name = ?2, file_type = ?3, path = ?4, size_bytes = ?5,
                   mtime_ms = ?6, updated_at = ?7,
                   status = CASE WHEN status = 'error' THEN 'indexed' ELSE status END, error = NULL
                 WHERE resource_id = ?1",
                params![meta.resource_id, meta.name, meta.file_type, meta.path, meta.size_bytes, meta.mtime_ms, now_ms()],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Marks a document as failed. Its previous chunks stay searchable.
    pub fn mark_document_error(&self, meta: &DocMeta, error: &str) -> Result<(), String> {
        self.writer()
            .execute(
                "INSERT INTO rag_documents (resource_id, name, file_type, path, size_bytes, mtime_ms, status, error, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'error', ?7, ?8)
                 ON CONFLICT(resource_id) DO UPDATE SET
                   name = excluded.name, file_type = excluded.file_type, path = excluded.path,
                   status = 'error', error = excluded.error, updated_at = excluded.updated_at",
                params![meta.resource_id, meta.name, meta.file_type, meta.path, meta.size_bytes, meta.mtime_ms, error, now_ms()],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Deletes a document with its chunks, vectors and FTS rows; returns the
    /// deleted chunk ids.
    pub fn delete_document(&self, resource_id: &str) -> Result<Vec<i64>, String> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(err)?;
        let Some(doc_id) = tx
            .query_row("SELECT id FROM rag_documents WHERE resource_id = ?1", [resource_id], |r| r.get::<_, i64>(0))
            .optional()
            .map_err(err)?
        else {
            return Ok(Vec::new());
        };
        let ids: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM rag_chunks WHERE doc_id = ?1 ORDER BY id").map_err(err)?;
            let rows = stmt.query_map([doc_id], |r| r.get(0)).map_err(err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(err)?
        };
        {
            let mut delete_fts = tx.prepare("DELETE FROM rag_fts WHERE rowid = ?1").map_err(err)?;
            for id in &ids {
                delete_fts.execute([id]).map_err(err)?;
            }
        }
        tx.execute("DELETE FROM rag_chunks WHERE doc_id = ?1", [doc_id]).map_err(err)?;
        tx.execute("DELETE FROM rag_documents WHERE id = ?1", [doc_id]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(ids)
    }

    /// Deletes everything (schema kept).
    pub fn clear_all(&self) -> Result<(), String> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(err)?;
        tx.execute_batch(
            "DELETE FROM rag_vectors;
             DELETE FROM rag_chunks;
             DELETE FROM rag_documents;
             DELETE FROM rag_spaces;
             DELETE FROM rag_meta WHERE key = 'active_space_id';
             INSERT INTO rag_fts (rag_fts) VALUES ('delete-all');",
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        let _ = conn.execute_batch("PRAGMA incremental_vacuum;");
        Ok(())
    }

    // ── Vectors ─────────────────────────────────────────────────────────────

    /// Up to `limit` chunks (id > `after_id`, by id) without a vector in `space_id`.
    pub fn chunks_missing_vectors(&self, space_id: i64, after_id: i64, limit: usize) -> Result<Vec<(i64, String)>, String> {
        let conn = self.writer();
        let mut stmt = conn
            .prepare_cached(
                "SELECT c.id, c.text FROM rag_chunks c
                 WHERE c.id > ?2 AND NOT EXISTS
                   (SELECT 1 FROM rag_vectors v WHERE v.space_id = ?1 AND v.chunk_id = c.id)
                 ORDER BY c.id LIMIT ?3",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![space_id, after_id, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Chunks without a vector in `space_id` (all chunks when `space_id` is None).
    pub fn count_missing_vectors(&self, space_id: Option<i64>) -> Result<usize, String> {
        let conn = self.writer();
        let n: i64 = match space_id {
            Some(space) => conn
                .query_row(
                    "SELECT COUNT(*) FROM rag_chunks c WHERE NOT EXISTS
                       (SELECT 1 FROM rag_vectors v WHERE v.space_id = ?1 AND v.chunk_id = c.id)",
                    [space],
                    |r| r.get(0),
                )
                .map_err(err)?,
            None => conn.query_row("SELECT COUNT(*) FROM rag_chunks", [], |r| r.get(0)).map_err(err)?,
        };
        Ok(n as usize)
    }

    /// Documents chunked with other chunk settings than `chunk_params`.
    pub fn count_stale_documents(&self, chunk_params: &str) -> Result<usize, String> {
        self.writer()
            .query_row(
                "SELECT COUNT(*) FROM rag_documents WHERE status IN ('indexed', 'empty') AND chunk_params != ?1",
                [chunk_params],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n as usize)
            .map_err(err)
    }

    /// Stores vectors (one transaction). Chunks deleted in the meantime are
    /// skipped; returns the chunk ids actually stored.
    pub fn insert_vectors(&self, space_id: i64, rows: &[(i64, Vec<f32>)]) -> Result<Vec<i64>, String> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(err)?;
        let mut stored = Vec::with_capacity(rows.len());
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO rag_vectors (space_id, chunk_id, vec)
                     SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM rag_chunks WHERE id = ?2)
                     ON CONFLICT (chunk_id, space_id) DO UPDATE SET vec = excluded.vec",
                )
                .map_err(err)?;
            for (chunk_id, vector) in rows {
                if stmt.execute(params![space_id, chunk_id, f32_vec_to_bytes(vector)]).map_err(err)? > 0 {
                    stored.push(*chunk_id);
                }
            }
        }
        tx.commit().map_err(err)?;
        Ok(stored)
    }

    /// Streams every vector of a space to `f` (reader connection).
    pub fn for_each_vector(&self, space_id: i64, mut f: impl FnMut(i64, &[f32])) -> Result<usize, String> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare("SELECT chunk_id, vec FROM rag_vectors WHERE space_id = ?1 ORDER BY chunk_id")
            .map_err(err)?;
        let mut rows = stmt.query([space_id]).map_err(err)?;
        let mut n = 0usize;
        while let Some(row) = rows.next().map_err(err)? {
            let id: i64 = row.get(0).map_err(err)?;
            let blob = row
                .get_ref(1)
                .map_err(err)?
                .as_blob()
                .map_err(|e| format!("RAG index database error: {e}"))?;
            f(id, &bytes_to_f32_vec(blob));
            n += 1;
        }
        Ok(n)
    }

    /// The vectors of `ids` in `space_id` (missing ids are left out).
    pub fn fetch_vectors(&self, space_id: i64, ids: &[i64]) -> Result<Vec<(i64, Vec<f32>)>, String> {
        let mut out = Vec::with_capacity(ids.len());
        let conn = self.reader();
        for batch in ids.chunks(500) {
            let sql = format!(
                "SELECT chunk_id, vec FROM rag_vectors WHERE space_id = ? AND chunk_id IN ({})",
                placeholders(batch.len())
            );
            let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
            let mut values: Vec<i64> = Vec::with_capacity(batch.len() + 1);
            values.push(space_id);
            values.extend_from_slice(batch);
            let rows = stmt
                .query_map(params_from_iter(values), |r| {
                    let blob: Vec<u8> = r.get(1)?;
                    Ok((r.get::<_, i64>(0)?, bytes_to_f32_vec(&blob)))
                })
                .map_err(err)?;
            for row in rows {
                out.push(row.map_err(err)?);
            }
        }
        Ok(out)
    }

    // ── Search ──────────────────────────────────────────────────────────────

    /// BM25 keyword search: (chunk id, score), higher is better.
    pub fn fts_search(&self, match_expr: &str, limit: usize) -> Result<Vec<(i64, f64)>, String> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached(
                "SELECT rowid, bm25(rag_fts) AS score FROM rag_fts
                 WHERE rag_fts MATCH ?1 ORDER BY score LIMIT ?2",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![match_expr, limit as i64], |r| Ok((r.get::<_, i64>(0)?, -r.get::<_, f64>(1)?)))
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Text and source of the given chunks.
    pub fn chunk_details(&self, ids: &[i64]) -> Result<HashMap<i64, ChunkDetail>, String> {
        let mut out = HashMap::with_capacity(ids.len());
        let conn = self.reader();
        for batch in ids.chunks(500) {
            let sql = format!(
                "SELECT c.id, c.text, c.ord, c.chunk_hash, d.name, d.resource_id
                 FROM rag_chunks c JOIN rag_documents d ON d.id = c.doc_id
                 WHERE c.id IN ({})",
                placeholders(batch.len())
            );
            let mut stmt = conn.prepare_cached(&sql).map_err(err)?;
            let rows = stmt
                .query_map(params_from_iter(batch.iter()), |r| {
                    Ok(ChunkDetail {
                        id: r.get(0)?,
                        text: r.get(1)?,
                        ord: r.get::<_, i64>(2)? as usize,
                        hash: r.get(3)?,
                        doc_name: r.get(4)?,
                        resource_id: r.get(5)?,
                    })
                })
                .map_err(err)?;
            for row in rows {
                let detail = row.map_err(err)?;
                out.insert(detail.id, detail);
            }
        }
        Ok(out)
    }

    // ── Stats ───────────────────────────────────────────────────────────────

    pub fn stats(&self, space_id: Option<i64>) -> Result<StoreStats, String> {
        let conn = self.reader();
        let mut stats = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(status IN ('indexed', 'empty')), 0), COALESCE(SUM(status = 'error'), 0),
                        COALESCE(SUM(chunk_count), 0), COALESCE(SUM(token_total), 0), MAX(updated_at)
                 FROM rag_documents",
                [],
                |r| {
                    Ok(StoreStats {
                        documents: r.get::<_, i64>(0)? as usize,
                        documents_indexed: r.get::<_, i64>(1)? as usize,
                        documents_error: r.get::<_, i64>(2)? as usize,
                        chunks: r.get::<_, i64>(3)? as usize,
                        tokens: r.get::<_, i64>(4)? as usize,
                        vectors: 0,
                        last_indexed_at_ms: r.get(5)?,
                    })
                },
            )
            .map_err(err)?;
        if let Some(space) = space_id {
            stats.vectors = conn
                .query_row("SELECT COUNT(*) FROM rag_vectors WHERE space_id = ?1", [space], |r| r.get::<_, i64>(0))
                .map_err(err)? as usize;
        }
        Ok(stats)
    }
}

const DOC_SELECT: &str = "SELECT id, resource_id, name, file_type, path, size_bytes, mtime_ms, content_hash,
    chunk_params, status, error, chunk_count, token_total, updated_at FROM rag_documents";

fn doc_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DocRow> {
    Ok(DocRow {
        id: r.get(0)?,
        resource_id: r.get(1)?,
        name: r.get(2)?,
        file_type: r.get(3)?,
        path: r.get(4)?,
        size_bytes: r.get(5)?,
        mtime_ms: r.get(6)?,
        content_hash: r.get(7)?,
        chunk_params: r.get(8)?,
        status: r.get(9)?,
        error: r.get(10)?,
        chunk_count: r.get::<_, i64>(11)? as usize,
        token_total: r.get::<_, i64>(12)? as usize,
        updated_at: r.get(13)?,
    })
}

fn space_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SpaceRow> {
    Ok(SpaceRow {
        id: r.get(0)?,
        space_key: r.get(1)?,
        fingerprint: r.get(2)?,
        provider: r.get(3)?,
        model: r.get(4)?,
        dims: r.get::<_, i64>(5)? as usize,
        status: r.get(6)?,
        created_at: r.get(7)?,
    })
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

enum OpenError {
    Corrupt(String),
    Other(String),
}

impl OpenError {
    fn message(self) -> String {
        match self {
            Self::Corrupt(m) | Self::Other(m) => m,
        }
    }
}

impl From<rusqlite::Error> for OpenError {
    fn from(e: rusqlite::Error) -> Self {
        match e.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseCorrupt) | Some(rusqlite::ErrorCode::NotADatabase) => {
                OpenError::Corrupt(e.to_string())
            }
            _ => OpenError::Other(err(e)),
        }
    }
}

fn open_connection(path: &Path, writer: bool) -> Result<Connection, OpenError> {
    let conn = Connection::open(path)?;
    if writer {
        // Only take effect on a new, empty file: 8 KB pages hold a 1024-d f32
        // vector without overflow pages; incremental vacuum frees deleted spaces.
        conn.execute_batch("PRAGMA page_size = 8192; PRAGMA auto_vacuum = INCREMENTAL;")?;
    }
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;",
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.set_prepared_statement_cache_capacity(32);
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), OpenError> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(OpenError::Other(format!(
            "rag.db was written by a newer NexQ Plus (index schema v{version}, this build knows v{SCHEMA_VERSION}). Reset the index to use it with this version."
        )));
    }
    if version < 1 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"))?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    pub(crate) fn temp_db(name: &str) -> (PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("nexq-rag-store-{name}-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("rag.db");
        let store = Store::open(&path).unwrap();
        (dir, store)
    }

    fn meta(id: &str) -> DocMeta {
        DocMeta {
            resource_id: id.to_string(),
            name: format!("{id}.txt"),
            file_type: "txt".into(),
            path: format!("/tmp/{id}.txt"),
            size_bytes: 10,
            mtime_ms: 1,
        }
    }

    fn chunks(texts: &[&str]) -> Vec<NewChunk> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| NewChunk {
                ord: i,
                text: t.to_string(),
                token_est: cjk::estimate_tokens(t),
                hash: Sha256::digest(t.as_bytes()).to_vec(),
                start_char: i * 10,
                end_char: i * 10 + 5,
            })
            .collect()
    }

    fn ids_of(store: &Store, resource: &str) -> Vec<(String, i64)> {
        let conn = store.writer();
        let mut stmt = conn
            .prepare("SELECT c.text, c.id FROM rag_chunks c JOIN rag_documents d ON d.id = c.doc_id WHERE d.resource_id = ?1 ORDER BY c.ord")
            .unwrap();
        stmt.query_map([resource], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn creates_schema_once_with_large_pages() {
        let (dir, store) = temp_db("schema");
        let conn = store.writer();
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let page: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
        assert_eq!(page, 8192);
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        drop(conn);
        drop(store);
        // Reopening is a no-op.
        let store = Store::open(&dir.join("rag.db")).unwrap();
        assert!(store.list_documents().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_newer_schema_and_replaces_a_damaged_file() {
        let (dir, store) = temp_db("versions");
        store.writer().execute_batch("PRAGMA user_version = 99;").unwrap();
        drop(store);
        let path = dir.join("rag.db");
        let e = Store::open(&path).err().unwrap();
        assert!(e.contains("newer"), "{e}");

        let bad = dir.join("bad").join("rag.db");
        std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
        std::fs::write(&bad, vec![0x42u8; 16384]).unwrap();
        let store = Store::open(&bad).unwrap();
        assert!(store.list_documents().unwrap().is_empty());
        let aside = std::fs::read_dir(bad.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
        assert!(aside, "damaged file kept aside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_keeps_unchanged_chunks_and_replaces_the_rest() {
        let (dir, store) = temp_db("apply");
        let out = store.apply_document(&meta("a"), b"h1", "p", &chunks(&["alpha", "beta", "gamma"])).unwrap();
        assert_eq!(out.inserted.len(), 3);
        assert_eq!(out.kept, 0);
        let before = ids_of(&store, "a");

        // "beta" changes, "delta" is added, order shifts.
        let out = store.apply_document(&meta("a"), b"h2", "p", &chunks(&["alpha", "gamma", "BETA two", "delta"])).unwrap();
        assert_eq!(out.kept, 2);
        assert_eq!(out.inserted.len(), 2);
        assert_eq!(out.removed, vec![before[1].1]);
        let after = ids_of(&store, "a");
        assert_eq!(after.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(), ["alpha", "gamma", "BETA two", "delta"]);
        assert_eq!(after[0].1, before[0].1, "alpha kept its id");
        assert_eq!(after[1].1, before[2].1, "gamma kept its id");

        let doc = store.document("a").unwrap().unwrap();
        assert_eq!(doc.chunk_count, 4);
        assert_eq!(doc.content_hash.as_deref(), Some(&b"h2"[..]));
        assert_eq!(doc.status, "indexed");

        // FTS follows: the removed text is gone, the new one is found.
        assert!(store.fts_search("\"beta\"", 10).unwrap().iter().all(|(id, _)| *id != before[1].1));
        let hits = store.fts_search("\"delta\"", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, after[3].1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_chunks_in_one_document_are_all_stored() {
        let (dir, store) = temp_db("dups");
        store.apply_document(&meta("a"), b"h", "p", &chunks(&["same", "same", "other"])).unwrap();
        assert_eq!(ids_of(&store, "a").len(), 3);
        let out = store.apply_document(&meta("a"), b"h2", "p", &chunks(&["same", "other", "same"])).unwrap();
        assert_eq!(out.kept, 3);
        assert!(out.removed.is_empty() && out.inserted.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vectors_are_copied_to_identical_new_chunks_and_cascade_on_delete() {
        let (dir, store) = temp_db("vectors");
        let space = store.create_space("k", "fp", "openai_compat", "m", 2, "{}").unwrap();
        let other = store.create_space("k2", "fp2", "ollama", "m2", 3, "{}").unwrap();
        let a = store.apply_document(&meta("a"), b"h", "p", &chunks(&["shared text", "only a"])).unwrap();
        assert_eq!(store.count_missing_vectors(Some(space.id)).unwrap(), 2);
        let missing = store.chunks_missing_vectors(space.id, 0, 10).unwrap();
        assert_eq!(missing.len(), 2);
        let stored = store
            .insert_vectors(space.id, &[(a.inserted[0], vec![0.6, 0.8]), (a.inserted[1], vec![1.0, 0.0])])
            .unwrap();
        assert_eq!(stored.len(), 2);
        store.insert_vectors(other.id, &[(a.inserted[0], vec![0.0, 0.0, 1.0])]).unwrap();
        assert_eq!(store.count_missing_vectors(Some(space.id)).unwrap(), 0);

        // A second document with the shared text reuses both spaces' vectors.
        let b = store.apply_document(&meta("b"), b"h", "p", &chunks(&["shared text", "only b"])).unwrap();
        let mut copied = b.copied.clone();
        copied.sort();
        assert_eq!(copied, vec![(space.id, b.inserted[0]), (other.id, b.inserted[0])]);
        assert_eq!(store.fetch_vectors(space.id, &[b.inserted[0]]).unwrap(), vec![(b.inserted[0], vec![0.6, 0.8])]);
        assert_eq!(store.count_missing_vectors(Some(space.id)).unwrap(), 1);

        // Deleting a document removes its vectors and FTS rows.
        let removed = store.delete_document("a").unwrap();
        assert_eq!(removed, a.inserted);
        assert!(store.fetch_vectors(space.id, &a.inserted).unwrap().is_empty());
        assert!(store.fts_search("\"only\"", 10).unwrap().iter().all(|(id, _)| !a.inserted.contains(id)));
        // A vector for a chunk deleted meanwhile is skipped, not an error.
        assert!(store.insert_vectors(space.id, &[(a.inserted[1], vec![1.0, 0.0])]).unwrap().is_empty());

        let mut seen = Vec::new();
        assert_eq!(store.for_each_vector(space.id, |id, v| seen.push((id, v.to_vec()))).unwrap(), 1);
        assert_eq!(seen, vec![(b.inserted[0], vec![0.6, 0.8])]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn spaces_activate_and_delete_in_batches() {
        let (dir, store) = temp_db("spaces");
        assert_eq!(store.active_space().unwrap(), None);
        let s1 = store.create_space("k1", "fp1", "openai_compat", "m", 2, "{}").unwrap();
        assert_eq!(store.create_space("k1", "fp1", "openai_compat", "m", 2, "{}").unwrap().id, s1.id, "idempotent");
        assert_eq!(s1.status, "building");
        store.activate_space(s1.id).unwrap();
        let active = store.active_space().unwrap().unwrap();
        assert_eq!((active.id, active.status.as_str()), (s1.id, "ready"));
        assert_eq!(store.space_by_key("k1").unwrap().unwrap().id, s1.id);

        let texts: Vec<String> = (0..6000).map(|i| format!("chunk {i}")).collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let out = store.apply_document(&meta("big"), b"h", "p", &chunks(&refs)).unwrap();
        let rows: Vec<(i64, Vec<f32>)> = out.inserted.iter().map(|id| (*id, vec![1.0, 0.0])).collect();
        store.insert_vectors(s1.id, &rows).unwrap();
        assert_eq!(store.stats(Some(s1.id)).unwrap().vectors, 6000);
        assert_eq!(store.delete_space(s1.id).unwrap(), 6000);
        assert_eq!(store.active_space().unwrap(), None);
        assert!(store.list_spaces().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bigram_fts_finds_chinese_words_and_ranks_by_bm25() {
        let (dir, store) = temp_db("fts");
        let a = store.apply_document(&meta("a"), b"h", "p", &chunks(&["向量检索在文档很多时也很快", "今天天气不错"])).unwrap();
        let b = store.apply_document(&meta("b"), b"h", "p", &chunks(&["我们开会讨论了明年的预算和招聘计划"])).unwrap();
        let q = cjk::fts_match_query("向量检索", 48).unwrap();
        let hits = store.fts_search(&q, 10).unwrap();
        assert_eq!(hits[0].0, a.inserted[0]);
        let hits = store.fts_search(&cjk::fts_match_query("预算是多少？", 48).unwrap(), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, b.inserted[0]);
        // English words are stemmed.
        let e = store.apply_document(&meta("e"), b"h", "p", &chunks(&["Quarterly meetings were scheduled"])).unwrap();
        let hits = store.fts_search(&cjk::fts_match_query("meeting schedule", 48).unwrap(), 10).unwrap();
        assert_eq!(hits[0].0, e.inserted[0]);

        let details = store.chunk_details(&[a.inserted[0], b.inserted[0]]).unwrap();
        assert_eq!(details[&b.inserted[0]].doc_name, "b.txt");
        assert_eq!(details[&a.inserted[0]].ord, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stats_errors_touch_and_clear() {
        let (dir, store) = temp_db("stats");
        store.apply_document(&meta("a"), b"h", "p", &chunks(&["one two", "three"])).unwrap();
        store.mark_document_error(&meta("bad"), "cannot parse").unwrap();
        store.mark_document_error(&meta("a"), "now broken").unwrap();
        let s = store.stats(None).unwrap();
        assert_eq!((s.documents, s.documents_indexed, s.documents_error, s.chunks), (2, 0, 2, 2));
        let a = store.document("a").unwrap().unwrap();
        assert_eq!(a.error.as_deref(), Some("now broken"));
        assert_eq!(a.chunk_count, 2, "old chunks stay searchable");
        let mut m = meta("a");
        m.mtime_ms = 99;
        store.touch_document(&m).unwrap();
        let a = store.document("a").unwrap().unwrap();
        assert_eq!((a.status.as_str(), a.mtime_ms, a.error), ("indexed", 99, None));
        store.set_meta("x", "1").unwrap();
        store.clear_all().unwrap();
        let s = store.stats(None).unwrap();
        assert_eq!((s.documents, s.chunks), (0, 0));
        assert!(store.fts_search("\"one\"", 10).unwrap().is_empty());
        assert_eq!(store.meta("x").unwrap().as_deref(), Some("1"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
