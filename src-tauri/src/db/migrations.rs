use rusqlite::Connection;

/// Run all migrations idempotently. Called on every app startup.
pub fn run(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Enable WAL mode for better concurrent read performance
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    v1_schema(conn)?;
    v2_rag_schema(conn)?;
    v3_meeting_mode_schema(conn)?;
    v4_bookmark_segment_id(conn)?;
    v5_recording_columns(conn)?;
    v6_translation_schema(conn)?;
    v7_meeting_chat(conn)?;
    v8_segment_speaker_tag(conn)?;
    v9_scope_transcripts_to_meetings(conn)?;
    v10_recording_file_deletions(conn)?;

    log::info!("Database migrations completed successfully");
    Ok(())
}

/// Schema v1: meetings, transcript_segments, context_resources, app_state
fn v1_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meetings (
            id              TEXT PRIMARY KEY NOT NULL,
            title           TEXT NOT NULL,
            start_time      TEXT NOT NULL,
            end_time        TEXT,
            duration_seconds INTEGER,
            transcript      TEXT NOT NULL DEFAULT '[]',
            ai_interactions TEXT NOT NULL DEFAULT '[]',
            summary         TEXT,
            config_snapshot TEXT
        );

        CREATE TABLE IF NOT EXISTS transcript_segments (
            id              TEXT PRIMARY KEY NOT NULL,
            meeting_id      TEXT NOT NULL,
            text            TEXT NOT NULL,
            speaker         TEXT NOT NULL DEFAULT 'Unknown',
            timestamp_ms    INTEGER NOT NULL,
            is_final        BOOLEAN NOT NULL DEFAULT 0,
            confidence      REAL NOT NULL DEFAULT 0.0,
            created_at      TEXT NOT NULL,
            FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS context_resources (
            id              TEXT PRIMARY KEY NOT NULL,
            name            TEXT NOT NULL,
            file_type       TEXT NOT NULL,
            file_path       TEXT NOT NULL,
            size_bytes      INTEGER NOT NULL DEFAULT 0,
            token_count     INTEGER NOT NULL DEFAULT 0,
            preview         TEXT NOT NULL DEFAULT '',
            loaded_at       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key             TEXT PRIMARY KEY NOT NULL,
            value           TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_transcript_segments_meeting_id
            ON transcript_segments(meeting_id);

        CREATE INDEX IF NOT EXISTS idx_meetings_start_time
            ON meetings(start_time);
        ",
    )?;

    Ok(())
}

/// Schema v2: RAG tables — chunks, embeddings, FTS5 index, and context_resources extensions.
fn v2_rag_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Add new columns to context_resources (safe: ignore error if column already exists)
    for alter in &[
        "ALTER TABLE context_resources ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE context_resources ADD COLUMN index_status TEXT NOT NULL DEFAULT 'none'",
        "ALTER TABLE context_resources ADD COLUMN last_indexed_at TEXT",
    ] {
        if let Err(e) = conn.execute_batch(alter) {
            // "duplicate column name" is expected on re-runs; any other error is real
            let msg = e.to_string();
            if !msg.contains("duplicate column") {
                log::warn!("ALTER TABLE context_resources warning: {}", msg);
            }
        }
    }

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS rag_chunks (
            chunk_id        TEXT PRIMARY KEY NOT NULL,
            file_id         TEXT NOT NULL,
            chunk_index     INTEGER NOT NULL,
            text            TEXT NOT NULL,
            token_count     INTEGER NOT NULL,
            source_type     TEXT NOT NULL DEFAULT 'file',
            created_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rag_embeddings (
            chunk_id        TEXT PRIMARY KEY NOT NULL,
            embedding       BLOB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rag_chunks_file_id
            ON rag_chunks(file_id);
        ",
    )?;

    // FTS5 virtual table (content-sync with rag_chunks)
    // Wrap in a check: FTS5 virtual tables don't support IF NOT EXISTS in all SQLite builds.
    let fts_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='rag_fts'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !fts_exists {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE rag_fts USING fts5(text, content=rag_chunks, content_rowid=rowid);",
        )?;
    }

    // Triggers to keep FTS5 in sync — use safe pattern (check sqlite_master before creating)
    let trigger_exists = |name: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?1",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
            > 0
    };

    if !trigger_exists("rag_fts_insert") {
        conn.execute_batch(
            "CREATE TRIGGER rag_fts_insert AFTER INSERT ON rag_chunks BEGIN
                INSERT INTO rag_fts(rowid, text) VALUES (new.rowid, new.text);
            END;",
        )?;
    }

    if !trigger_exists("rag_fts_delete") {
        conn.execute_batch(
            "CREATE TRIGGER rag_fts_delete AFTER DELETE ON rag_chunks BEGIN
                INSERT INTO rag_fts(rag_fts, rowid, text) VALUES('delete', old.rowid, old.text);
            END;",
        )?;
    }

    if !trigger_exists("rag_fts_update") {
        conn.execute_batch(
            "CREATE TRIGGER rag_fts_update AFTER UPDATE ON rag_chunks BEGIN
                INSERT INTO rag_fts(rag_fts, rowid, text) VALUES('delete', old.rowid, old.text);
                INSERT INTO rag_fts(rowid, text) VALUES (new.rowid, new.text);
            END;",
        )?;
    }

    Ok(())
}

/// Schema v4: Add segment_id to meeting_bookmarks for segment-anchored bookmarks.
fn v4_bookmark_segment_id(conn: &Connection) -> Result<(), rusqlite::Error> {
    if let Err(e) =
        conn.execute_batch("ALTER TABLE meeting_bookmarks ADD COLUMN segment_id TEXT")
    {
        let msg = e.to_string();
        if !msg.contains("duplicate column") {
            log::warn!("ALTER TABLE meeting_bookmarks warning: {}", msg);
        }
    }

    Ok(())
}

/// Schema v5: Recording columns — recording_path, recording_size, waveform_path, recording_offset_ms.
fn v5_recording_columns(conn: &Connection) -> Result<(), rusqlite::Error> {
    let columns = [
        "ALTER TABLE meetings ADD COLUMN recording_path TEXT",
        "ALTER TABLE meetings ADD COLUMN recording_size INTEGER",
        "ALTER TABLE meetings ADD COLUMN waveform_path TEXT",
        "ALTER TABLE meetings ADD COLUMN recording_offset_ms INTEGER",
    ];
    for sql in &columns {
        match conn.execute(sql, []) {
            Ok(_) => {}
            Err(e) => {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(e);
                }
            }
        }
    }
    Ok(())
}

/// Schema v6: Translation cache — stores translated transcript segments.
fn v6_translation_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS transcript_translations (
            id              TEXT PRIMARY KEY NOT NULL,
            segment_id      TEXT NOT NULL,
            meeting_id      TEXT NOT NULL,
            source_lang     TEXT NOT NULL,
            target_lang     TEXT NOT NULL,
            original_text   TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            provider        TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(segment_id, target_lang)
        );

        CREATE INDEX IF NOT EXISTS idx_translations_meeting
            ON transcript_translations(meeting_id, target_lang);
        ",
    )?;
    Ok(())
}

/// Schema v7: "Ask this meeting" chat, saved per meeting (`created_at` in Unix ms).
fn v7_meeting_chat(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meeting_chat (
            id              TEXT PRIMARY KEY NOT NULL,
            meeting_id      TEXT NOT NULL,
            role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content         TEXT NOT NULL,
            model           TEXT,
            input_tokens    INTEGER,
            output_tokens   INTEGER,
            created_at      INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_meeting_chat_meeting_id
            ON meeting_chat(meeting_id);
        ",
    )?;
    Ok(())
}

/// Schema v8: diarization speaker tag ("S1", "S2"...) of remote-party
/// transcript lines; NULL for untagged lines.
fn v8_segment_speaker_tag(conn: &Connection) -> Result<(), rusqlite::Error> {
    match conn.execute("ALTER TABLE transcript_segments ADD COLUMN speaker_tag TEXT", []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Segments and translations can reuse the same capture IDs in different meetings.
fn v9_scope_transcripts_to_meetings(conn: &Connection) -> Result<(), rusqlite::Error> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version >= 9 {
        return Ok(());
    }

    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(
        "
        CREATE TABLE transcript_segments_v9 (
            id              TEXT NOT NULL,
            meeting_id      TEXT NOT NULL,
            text            TEXT NOT NULL,
            speaker         TEXT NOT NULL DEFAULT 'Unknown',
            timestamp_ms    INTEGER NOT NULL,
            is_final        BOOLEAN NOT NULL DEFAULT 0,
            confidence      REAL NOT NULL DEFAULT 0.0,
            created_at      TEXT NOT NULL,
            speaker_id      TEXT,
            speaker_tag     TEXT,
            PRIMARY KEY (meeting_id, id),
            FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
        );

        INSERT INTO transcript_segments_v9
            (id, meeting_id, text, speaker, timestamp_ms, is_final, confidence, created_at, speaker_id, speaker_tag)
        SELECT s.id, s.meeting_id, s.text, s.speaker, s.timestamp_ms, s.is_final, s.confidence,
               s.created_at, s.speaker_id, s.speaker_tag
        FROM transcript_segments s INNER JOIN meetings m ON m.id = s.meeting_id
        ORDER BY s.rowid;

        DROP TABLE transcript_segments;
        ALTER TABLE transcript_segments_v9 RENAME TO transcript_segments;
        CREATE INDEX idx_transcript_segments_meeting_id
            ON transcript_segments(meeting_id);

        CREATE TABLE transcript_translations_v9 (
            id              TEXT PRIMARY KEY NOT NULL,
            segment_id      TEXT NOT NULL,
            meeting_id      TEXT NOT NULL,
            source_lang     TEXT NOT NULL,
            target_lang     TEXT NOT NULL,
            original_text   TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            provider        TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(meeting_id, segment_id, target_lang),
            FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
        );

        INSERT INTO transcript_translations_v9
            (id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider, created_at)
        SELECT t.id, t.segment_id, t.meeting_id, t.source_lang, t.target_lang, t.original_text,
               t.translated_text, t.provider, t.created_at
        FROM transcript_translations t INNER JOIN meetings m ON m.id = t.meeting_id;

        DROP TABLE transcript_translations;
        ALTER TABLE transcript_translations_v9 RENAME TO transcript_translations;
        CREATE INDEX idx_translations_meeting ON transcript_translations(meeting_id, target_lang);

        PRAGMA user_version = 9;
        ",
    )?;
    transaction.commit()
}

fn v10_recording_file_deletions(conn: &Connection) -> Result<(), rusqlite::Error> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version >= 10 {
        return Ok(());
    }

    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS recording_file_deletions (
            meeting_id     TEXT PRIMARY KEY NOT NULL,
            recording_path TEXT,
            waveform_path  TEXT
         );
         PRAGMA user_version = 10;",
    )?;
    transaction.commit()
}

/// Schema v3: In-person meeting mode — meeting metadata, speakers, bookmarks,
/// topic sections, and action items.
fn v3_meeting_mode_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Add new columns to meetings (safe: ignore error if column already exists)
    for alter in &[
        "ALTER TABLE meetings ADD COLUMN audio_mode TEXT NOT NULL DEFAULT 'online'",
        "ALTER TABLE meetings ADD COLUMN ai_scenario TEXT NOT NULL DEFAULT 'team_meeting'",
        "ALTER TABLE meetings ADD COLUMN noise_preset TEXT",
    ] {
        if let Err(e) = conn.execute_batch(alter) {
            let msg = e.to_string();
            if !msg.contains("duplicate column") {
                log::warn!("ALTER TABLE meetings warning: {}", msg);
            }
        }
    }

    // Add speaker_id column to transcript_segments
    if let Err(e) =
        conn.execute_batch("ALTER TABLE transcript_segments ADD COLUMN speaker_id TEXT")
    {
        let msg = e.to_string();
        if !msg.contains("duplicate column") {
            log::warn!("ALTER TABLE transcript_segments warning: {}", msg);
        }
    }

    // Backfill speaker_id from existing speaker values (idempotent: only fills NULLs)
    conn.execute_batch(
        "
        UPDATE transcript_segments SET speaker_id = 'you'     WHERE speaker_id IS NULL AND speaker = 'User';
        UPDATE transcript_segments SET speaker_id = 'them'    WHERE speaker_id IS NULL AND speaker IN ('Interviewer', 'Them');
        UPDATE transcript_segments SET speaker_id = 'unknown' WHERE speaker_id IS NULL AND speaker = 'Unknown';
        ",
    )?;

    // New tables for in-person meeting features
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meeting_speakers (
            id              TEXT PRIMARY KEY,
            meeting_id      TEXT NOT NULL,
            speaker_id      TEXT NOT NULL,
            display_name    TEXT NOT NULL,
            source          TEXT NOT NULL,
            color           TEXT,
            segment_count   INTEGER DEFAULT 0,
            word_count      INTEGER DEFAULT 0,
            talk_time_ms    INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS meeting_bookmarks (
            id              TEXT PRIMARY KEY,
            meeting_id      TEXT NOT NULL,
            timestamp_ms    INTEGER NOT NULL,
            note            TEXT,
            created_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meeting_topic_sections (
            id              TEXT PRIMARY KEY,
            meeting_id      TEXT NOT NULL,
            title           TEXT NOT NULL,
            start_ms        INTEGER NOT NULL,
            end_ms          INTEGER
        );

        CREATE TABLE IF NOT EXISTS meeting_action_items (
            id              TEXT PRIMARY KEY,
            meeting_id      TEXT NOT NULL,
            text            TEXT NOT NULL,
            assignee_speaker_id TEXT,
            timestamp_ms    INTEGER NOT NULL,
            completed       INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_meeting_speakers_meeting_id
            ON meeting_speakers(meeting_id);

        CREATE INDEX IF NOT EXISTS idx_meeting_bookmarks_meeting_id
            ON meeting_bookmarks(meeting_id);

        CREATE INDEX IF NOT EXISTS idx_meeting_topic_sections_meeting_id
            ON meeting_topic_sections(meeting_id);

        CREATE INDEX IF NOT EXISTS idx_meeting_action_items_meeting_id
            ON meeting_action_items(meeting_id);
        ",
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{meetings, translation};

    #[test]
    fn v9_preserves_legacy_meeting_data_and_scopes_reused_segment_ids() {
        let conn = Connection::open_in_memory().unwrap();
        v1_schema(&conn).unwrap();
        v3_meeting_mode_schema(&conn).unwrap();
        v6_translation_schema(&conn).unwrap();
        v8_segment_speaker_tag(&conn).unwrap();
        let old = meetings::create_meeting(&conn, "Old meeting").unwrap();
        let new = meetings::create_meeting(&conn, "New meeting").unwrap();
        conn.execute(
            "INSERT INTO transcript_segments
                (id, meeting_id, text, speaker, speaker_id, speaker_tag, timestamp_ms, is_final, created_at)
             VALUES ('acc_1', ?1, 'old transcript', 'Them', 'them', 'S1', 2000, 1, 'legacy time')",
            [&old.id],
        ).unwrap();
        conn.execute(
            "INSERT INTO transcript_translations
                (id, meeting_id, segment_id, source_lang, target_lang, original_text, translated_text, provider)
             VALUES ('legacy', ?1, 'acc_1', 'en', 'es', 'old transcript', 'old translation', 'provider'),
                    ('orphan', 'deleted-meeting', 'acc_2', 'en', 'es', 'gone', 'gone', 'provider')",
            [&old.id],
        ).unwrap();

        run(&conn).unwrap();
        run(&conn).unwrap();
        let old_segments = meetings::get_meeting(&conn, &old.id).unwrap().transcript;
        assert_eq!(old_segments[0]["text"], "old transcript");
        assert_eq!(old_segments[0]["speaker_tag"], "S1");
        assert_eq!(old_segments[0]["created_at"], "legacy time");
        let mut new_segment: meetings::TranscriptSegment =
            serde_json::from_value(old_segments[0].clone()).unwrap();
        new_segment.meeting_id.clone_from(&new.id);
        new_segment.text = "new transcript".into();
        meetings::append_transcript_segment(&conn, &new.id, &new_segment).unwrap();
        translation::save_translation(
            &conn, "acc_1", &new.id, "en", "es", "new transcript", "new translation", "provider",
        ).unwrap();

        assert_eq!(meetings::get_meeting(&conn, &old.id).unwrap().transcript[0]["text"], "old transcript");
        assert_eq!(meetings::get_meeting(&conn, &new.id).unwrap().transcript[0]["text"], "new transcript");
        let old_result = translation::get_segment_translation(&conn, &old.id, "acc_1", "es").unwrap().unwrap();
        let new_result = translation::get_segment_translation(&conn, &new.id, "acc_1", "es").unwrap().unwrap();
        assert_eq!(old_result.id, "legacy");
        assert_eq!(old_result.translated_text, "old translation");
        assert_eq!(new_result.translated_text, "new translation");
        assert_eq!(translation::get_all_meeting_translations(&conn, "deleted-meeting").unwrap().len(), 0);

        assert!(translation::save_translation(
            &conn, "acc_2", "deleted-meeting", "en", "es", "gone", "gone", "provider",
        ).is_err());
    }
}
