use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::DatabaseError;

// ── Data structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub transcript: serde_json::Value,
    pub ai_interactions: serde_json::Value,
    pub summary: Option<String>,
    pub config_snapshot: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub speakers: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub bookmarks: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub action_items: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub topic_sections: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub recording_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub recording_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub waveform_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub recording_offset_ms: Option<i64>,
}

/// Response struct that maps MeetingSpeaker back to frontend SpeakerIdentity format.
#[derive(Debug, Clone, Serialize)]
pub struct MeetingSpeakerResponse {
    pub id: String,           // This is speaker_id (e.g. "speaker_0"), NOT the record UUID
    pub display_name: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub stats: SpeakerStatsResponse,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerStatsResponse {
    pub segment_count: i64,
    pub word_count: i64,
    pub talk_time_ms: i64,
    pub last_spoke_ms: i64,
}

impl From<MeetingSpeaker> for MeetingSpeakerResponse {
    fn from(s: MeetingSpeaker) -> Self {
        MeetingSpeakerResponse {
            id: s.speaker_id,
            display_name: s.display_name,
            source: s.source,
            color: s.color,
            stats: SpeakerStatsResponse {
                segment_count: s.segment_count,
                word_count: s.word_count,
                talk_time_ms: s.talk_time_ms,
                last_spoke_ms: 0,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSummary {
    pub id: String,
    pub title: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub segment_count: i64,
    pub has_summary: bool,
    pub audio_mode: String,
    pub ai_scenario: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
    /// Diarization tag of a remote-party line ("S1"); `speaker` stays "Them".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_tag: Option<String>,
    pub timestamp_ms: i64,
    pub is_final: bool,
    pub confidence: f64,
    pub created_at: String,
}

/// The `meeting_speakers` id under which a remote speaker tag's name is
/// kept ("them:S1").
pub fn remote_speaker_id(tag: &str) -> String {
    format!("them:{tag}")
}

/// Label of a remote speaker tag that was never renamed ("S2" → "Speaker 2").
pub fn default_remote_speaker_name(tag: &str) -> String {
    match tag.strip_prefix('S') {
        Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => format!("Speaker {n}"),
        _ => tag.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingUpdate {
    pub title: Option<String>,
    pub end_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub transcript: Option<serde_json::Value>,
    pub ai_interactions: Option<serde_json::Value>,
    pub summary: Option<String>,
    pub config_snapshot: Option<serde_json::Value>,
    pub recording_path: Option<String>,
    pub recording_size: Option<i64>,
    pub waveform_path: Option<String>,
    pub recording_offset_ms: Option<i64>,
}

// ── CRUD operations ──────────────────────────────────────────────────────────

/// Create a new meeting with a UUID and the current timestamp.
pub fn create_meeting(conn: &Connection, title: &str) -> Result<Meeting, DatabaseError> {
    let id = Uuid::new_v4().to_string();
    let start_time = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO meetings (id, title, start_time, transcript, ai_interactions)
         VALUES (?1, ?2, ?3, '[]', '[]')",
        params![id, title, start_time],
    )?;

    Ok(Meeting {
        id,
        title: title.to_string(),
        start_time,
        end_time: None,
        duration_seconds: None,
        transcript: serde_json::json!([]),
        ai_interactions: serde_json::json!([]),
        summary: None,
        config_snapshot: None,
        speakers: None,
        bookmarks: None,
        action_items: None,
        topic_sections: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    })
}

/// Merge completed or interrupted answers by ID without replacing earlier history.
pub fn merge_meeting_ai_interactions(
    conn: &Connection,
    meeting_id: &str,
    incoming: Vec<serde_json::Value>,
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    let previous: String = transaction.query_row(
        "SELECT ai_interactions FROM meetings WHERE id = ?1",
        [meeting_id],
        |row| row.get(0),
    )?;
    let mut entries: Vec<serde_json::Value> = serde_json::from_str(&previous).unwrap_or_default();
    let mut positions: std::collections::HashMap<String, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| Some((entry.get("id")?.as_str()?.to_owned(), index)))
        .collect();
    for entry in incoming {
        let id = entry.get("id").and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| DatabaseError::Query("AI interaction requires an ID".into()))?;
        if let Some(&index) = positions.get(id) {
            entries[index] = entry;
        } else {
            positions.insert(id.to_owned(), entries.len());
            entries.push(entry);
        }
    }
    let timestamp = |entry: &serde_json::Value| {
        entry.get("timestamp").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned()
    };
    entries.sort_by_cached_key(|entry| std::cmp::Reverse(timestamp(entry)));
    let json = serde_json::to_string(&entries).map_err(|err| DatabaseError::Query(err.to_string()))?;
    transaction.execute("UPDATE meetings SET ai_interactions = ?1 WHERE id = ?2", params![json, meeting_id])?;
    transaction.commit()?;
    Ok(())
}

/// Get a single meeting by ID, with its transcript segments joined in.
pub fn get_meeting(conn: &Connection, id: &str) -> Result<Meeting, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, start_time, end_time, duration_seconds,
                transcript, ai_interactions, summary, config_snapshot,
                recording_path, recording_size, waveform_path, recording_offset_ms
         FROM meetings WHERE id = ?1",
    )?;

    let meeting = stmt
        .query_row(params![id], |row| {
            let transcript_str: String = row.get(5)?;
            let ai_str: String = row.get(6)?;
            let summary: Option<String> = row.get(7)?;
            let config_str: Option<String> = row.get(8)?;

            Ok(Meeting {
                id: row.get(0)?,
                title: row.get(1)?,
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                duration_seconds: row.get(4)?,
                transcript: serde_json::from_str(&transcript_str).unwrap_or(serde_json::json!([])),
                ai_interactions: serde_json::from_str(&ai_str).unwrap_or(serde_json::json!([])),
                summary,
                config_snapshot: config_str
                    .and_then(|s| serde_json::from_str(&s).ok()),
                speakers: None,
                bookmarks: None,
                action_items: None,
                topic_sections: None,
                recording_path: row.get(9)?,
                recording_size: row.get(10)?,
                waveform_path: row.get(11)?,
                recording_offset_ms: row.get(12)?,
            })
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DatabaseError::NotFound(format!("Meeting {} not found", id))
            }
            other => DatabaseError::Query(other.to_string()),
        })?;

    // Also fetch and merge transcript segments into the transcript array
    let mut meeting = meeting;
    let start_ms = chrono::DateTime::parse_from_rfc3339(&meeting.start_time)
        .map(|time| time.timestamp_millis())
        .unwrap_or_default();
    let mut segments = list_transcript_segments(conn, id)?;
    if !segments.is_empty() {
        for segment in &mut segments {
            segment.timestamp_ms = absolute_meeting_time_ms(segment.timestamp_ms, start_ms);
        }
        segments.sort_by_key(|segment| segment.timestamp_ms);
        meeting.transcript = serde_json::to_value(&segments).unwrap_or(serde_json::json!([]));
    } else if let Some(legacy_segments) = meeting.transcript.as_array_mut() {
        for segment in legacy_segments.iter_mut() {
            if let Some(timestamp_ms) = segment["timestamp_ms"].as_i64() {
                segment["timestamp_ms"] = absolute_meeting_time_ms(timestamp_ms, start_ms).into();
            }
        }
        legacy_segments.sort_by_key(|segment| segment["timestamp_ms"].as_i64());
    }

    // Load feature tables
    let speakers = list_meeting_speakers(conn, id)?;
    if !speakers.is_empty() {
        let speaker_responses: Vec<MeetingSpeakerResponse> =
            speakers.into_iter().map(|s| s.into()).collect();
        meeting.speakers = Some(serde_json::to_value(&speaker_responses).unwrap_or(serde_json::json!([])));
    }

    let bookmarks = list_meeting_bookmarks(conn, id)?;
    if !bookmarks.is_empty() {
        meeting.bookmarks = Some(serde_json::to_value(&bookmarks).unwrap_or(serde_json::json!([])));
    }

    let action_items = list_meeting_action_items(conn, id)?;
    if !action_items.is_empty() {
        meeting.action_items = Some(serde_json::to_value(&action_items).unwrap_or(serde_json::json!([])));
    }

    let topic_sections = list_meeting_topic_sections(conn, id)?;
    if !topic_sections.is_empty() {
        meeting.topic_sections = Some(serde_json::to_value(&topic_sections).unwrap_or(serde_json::json!([])));
    }

    Ok(meeting)
}

/// List meetings with pagination, ordered by start_time descending.
pub fn list_meetings(
    conn: &Connection,
    limit: u32,
    offset: u32,
) -> Result<Vec<MeetingSummary>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.start_time, m.end_time, m.duration_seconds,
                (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id) AS segment_count,
                CASE WHEN m.summary IS NOT NULL AND m.summary != '' THEN 1 ELSE 0 END AS has_summary,
                m.audio_mode, m.ai_scenario
         FROM meetings m
         ORDER BY m.start_time DESC
         LIMIT ?1 OFFSET ?2",
    )?;

    let rows = stmt.query_map(params![limit, offset], |row| {
        Ok(MeetingSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            start_time: row.get(2)?,
            end_time: row.get(3)?,
            duration_seconds: row.get(4)?,
            segment_count: row.get(5)?,
            has_summary: row.get::<_, i32>(6)? != 0,
            audio_mode: row.get::<_, String>(7).unwrap_or_else(|_| "online".to_string()),
            ai_scenario: row.get::<_, String>(8).unwrap_or_else(|_| "team_meeting".to_string()),
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Update specific fields of a meeting.
pub fn update_meeting(
    conn: &Connection,
    id: &str,
    updates: &MeetingUpdate,
) -> Result<(), DatabaseError> {
    // Build dynamic SET clause
    let mut sets: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref title) = updates.title {
        sets.push(format!("title = ?{}", sets.len() + 1));
        param_values.push(Box::new(title.clone()));
    }
    if let Some(ref end_time) = updates.end_time {
        sets.push(format!("end_time = ?{}", sets.len() + 1));
        param_values.push(Box::new(end_time.clone()));
    }
    if let Some(duration) = updates.duration_seconds {
        sets.push(format!("duration_seconds = ?{}", sets.len() + 1));
        param_values.push(Box::new(duration));
    }
    if let Some(ref transcript) = updates.transcript {
        sets.push(format!("transcript = ?{}", sets.len() + 1));
        param_values.push(Box::new(transcript.to_string()));
    }
    if let Some(ref ai) = updates.ai_interactions {
        sets.push(format!("ai_interactions = ?{}", sets.len() + 1));
        param_values.push(Box::new(ai.to_string()));
    }
    if let Some(ref summary) = updates.summary {
        sets.push(format!("summary = ?{}", sets.len() + 1));
        param_values.push(Box::new(summary.clone()));
    }
    if let Some(ref config) = updates.config_snapshot {
        sets.push(format!("config_snapshot = ?{}", sets.len() + 1));
        param_values.push(Box::new(config.to_string()));
    }
    if let Some(ref recording_path) = updates.recording_path {
        sets.push(format!("recording_path = ?{}", sets.len() + 1));
        param_values.push(Box::new(recording_path.clone()));
    }
    if let Some(recording_size) = updates.recording_size {
        sets.push(format!("recording_size = ?{}", sets.len() + 1));
        param_values.push(Box::new(recording_size));
    }
    if let Some(ref waveform_path) = updates.waveform_path {
        sets.push(format!("waveform_path = ?{}", sets.len() + 1));
        param_values.push(Box::new(waveform_path.clone()));
    }
    if let Some(recording_offset_ms) = updates.recording_offset_ms {
        sets.push(format!("recording_offset_ms = ?{}", sets.len() + 1));
        param_values.push(Box::new(recording_offset_ms));
    }

    if sets.is_empty() {
        return Ok(());
    }

    // Add the id as the last parameter
    let id_param_idx = sets.len() + 1;
    let sql = format!(
        "UPDATE meetings SET {} WHERE id = ?{}",
        sets.join(", "),
        id_param_idx
    );
    param_values.push(Box::new(id.to_string()));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let rows_affected = conn.execute(&sql, param_refs.as_slice())?;
    if rows_affected == 0 {
        return Err(DatabaseError::NotFound(format!(
            "Meeting {} not found",
            id
        )));
    }

    Ok(())
}

/// Update recording-related fields on a meeting after post-processing completes.
pub fn update_meeting_recording(
    conn: &Connection,
    id: &str,
    recording_path: &str,
    recording_size: i64,
    waveform_path: Option<&str>,
    recording_offset_ms: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE meetings SET recording_path = ?1, recording_size = ?2, waveform_path = ?3, recording_offset_ms = ?4 WHERE id = ?5",
        params![recording_path, recording_size, waveform_path, recording_offset_ms, id],
    )
}

fn recording_paths(
    conn: &Connection,
    id: &str,
) -> Result<(Option<String>, Option<String>), DatabaseError> {
    conn.query_row(
        "SELECT recording_path, waveform_path FROM meetings WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => DatabaseError::NotFound(format!("Meeting {id} not found")),
        other => other.into(),
    })
}

/// Delete a meeting and queue its files for cleanup in the same transaction.
/// The segment and translation foreign keys cascade.
pub fn delete_meeting(conn: &Connection, id: &str) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    queue_recording_file_deletion(&transaction, id)?;
    transaction.execute("DELETE FROM meeting_speakers WHERE meeting_id = ?1", [id])?;
    transaction.execute("DELETE FROM meeting_bookmarks WHERE meeting_id = ?1", [id])?;
    transaction.execute("DELETE FROM meeting_action_items WHERE meeting_id = ?1", [id])?;
    transaction.execute("DELETE FROM meeting_topic_sections WHERE meeting_id = ?1", [id])?;
    super::meeting_chat::delete_chat_messages(&transaction, id)?;
    transaction.execute("DELETE FROM meetings WHERE id = ?1", [id])?;
    transaction.commit()?;

    Ok(())
}

/// Clear recording metadata and queue its files without removing the meeting.
pub fn delete_recording(conn: &Connection, id: &str) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    queue_recording_file_deletion(&transaction, id)?;
    transaction.execute(
        "UPDATE meetings SET recording_path = NULL, recording_size = NULL,
         waveform_path = NULL, recording_offset_ms = NULL WHERE id = ?1",
        [id],
    )?;
    transaction.commit()?;
    Ok(())
}

fn queue_recording_file_deletion(conn: &Connection, id: &str) -> Result<(), DatabaseError> {
    let (recording, waveform) = recording_paths(conn, id)?;
    conn.execute(
        "INSERT INTO recording_file_deletions (meeting_id, recording_path, waveform_path)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(meeting_id) DO UPDATE SET
            recording_path = COALESCE(recording_file_deletions.recording_path, excluded.recording_path),
            waveform_path = COALESCE(recording_file_deletions.waveform_path, excluded.waveform_path)",
        params![id, recording, waveform],
    )?;
    Ok(())
}

pub fn pending_recording_file_deletion(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<(Option<String>, Option<String>)>> {
    conn.query_row(
        "SELECT recording_path, waveform_path FROM recording_file_deletions WHERE meeting_id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()
}

pub fn pending_recording_file_deletion_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT meeting_id FROM recording_file_deletions")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

pub fn confirm_recording_file_deletion(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM recording_file_deletions WHERE meeting_id = ?1", [id])?;
    Ok(())
}

pub fn list_meeting_history_ids(
    conn: &Connection,
    active_meeting_id: Option<&str>,
) -> Result<Vec<String>, DatabaseError> {
    let mut statement = conn.prepare("SELECT id FROM meetings WHERE id IS NOT ?1")?;
    let rows = statement.query_map([active_meeting_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn ensure_meeting_exists(conn: &Connection, meeting_id: &str) -> Result<(), DatabaseError> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
        [meeting_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(DatabaseError::NotFound(format!("Meeting {meeting_id} not found")))
    }
}

/// Search meetings by title and transcript segment text.
pub fn search_meetings(
    conn: &Connection,
    query: &str,
) -> Result<Vec<MeetingSummary>, DatabaseError> {
    let search_pattern = format!("%{}%", query);

    let mut stmt = conn.prepare(
        "SELECT DISTINCT m.id, m.title, m.start_time, m.end_time, m.duration_seconds,
                (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id) AS segment_count,
                CASE WHEN m.summary IS NOT NULL AND m.summary != '' THEN 1 ELSE 0 END AS has_summary,
                m.audio_mode, m.ai_scenario
         FROM meetings m
         LEFT JOIN transcript_segments ts ON ts.meeting_id = m.id
         WHERE m.title LIKE ?1
            OR ts.text LIKE ?1
            OR m.summary LIKE ?1
         ORDER BY m.start_time DESC
         LIMIT 50",
    )?;

    let rows = stmt.query_map(params![search_pattern], |row| {
        Ok(MeetingSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            start_time: row.get(2)?,
            end_time: row.get(3)?,
            duration_seconds: row.get(4)?,
            segment_count: row.get(5)?,
            has_summary: row.get::<_, i32>(6)? != 0,
            audio_mode: row.get::<_, String>(7).unwrap_or_else(|_| "online".to_string()),
            ai_scenario: row.get::<_, String>(8).unwrap_or_else(|_| "team_meeting".to_string()),
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Append a single transcript segment (used for incremental 30s saves).
pub fn append_transcript_segment(
    conn: &Connection,
    meeting_id: &str,
    segment: &TranscriptSegment,
) -> Result<(), DatabaseError> {
    conn.execute(
        "INSERT INTO transcript_segments
            (id, meeting_id, text, speaker, speaker_id, timestamp_ms, is_final, confidence, created_at, speaker_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(meeting_id, id) DO UPDATE SET
            text = excluded.text,
            speaker = excluded.speaker,
            speaker_id = excluded.speaker_id,
            timestamp_ms = excluded.timestamp_ms,
            is_final = excluded.is_final,
            confidence = excluded.confidence,
            speaker_tag = excluded.speaker_tag
         WHERE excluded.is_final OR NOT transcript_segments.is_final",
        params![
            segment.id,
            meeting_id,
            segment.text,
            segment.speaker,
            segment.speaker_id,
            segment.timestamp_ms,
            segment.is_final,
            segment.confidence,
            segment.created_at,
            segment.speaker_tag,
        ],
    )?;

    Ok(())
}

/// Legacy captures used in-meeting offsets alongside Unix-millisecond timestamps.
pub fn relative_meeting_time_ms(timestamp_ms: i64, meeting_start_ms: i64) -> i64 {
    if is_epoch_timestamp(timestamp_ms) && meeting_start_ms > 0 {
        timestamp_ms.saturating_sub(meeting_start_ms).max(0)
    } else {
        timestamp_ms.max(0)
    }
}

fn is_epoch_timestamp(timestamp_ms: i64) -> bool {
    timestamp_ms >= crate::stt::segment_accumulator::EPOCH_MS_FLOOR as i64
}

fn absolute_meeting_time_ms(timestamp_ms: i64, meeting_start_ms: i64) -> i64 {
    if is_epoch_timestamp(timestamp_ms) || meeting_start_ms <= 0 {
        timestamp_ms
    } else {
        meeting_start_ms.saturating_add(timestamp_ms.max(0))
    }
}

/// List transcript segments in insertion order to break ties after time normalization.
fn list_transcript_segments(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<TranscriptSegment>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, text, speaker, speaker_id, timestamp_ms, is_final, confidence, created_at, speaker_tag
         FROM transcript_segments
         WHERE meeting_id = ?1
         ORDER BY rowid",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(TranscriptSegment {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            text: row.get(2)?,
            speaker: row.get(3)?,
            speaker_id: row.get(4)?,
            timestamp_ms: row.get(5)?,
            is_final: row.get(6)?,
            confidence: row.get(7)?,
            created_at: row.get(8)?,
            speaker_tag: row.get(9)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ── Meeting speakers CRUD ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSpeaker {
    pub id: String,
    pub meeting_id: String,
    pub speaker_id: String,
    pub display_name: String,
    pub source: String,
    pub color: Option<String>,
    pub segment_count: i64,
    pub word_count: i64,
    pub talk_time_ms: i64,
}

/// Replace all speakers for a meeting (delete + insert).
pub fn save_meeting_speakers(
    conn: &Connection,
    meeting_id: &str,
    speakers: &[MeetingSpeaker],
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    ensure_meeting_exists(&transaction, meeting_id)?;
    transaction.execute(
        "DELETE FROM meeting_speakers WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = transaction.prepare(
        "INSERT INTO meeting_speakers
            (id, meeting_id, speaker_id, display_name, source, color, segment_count, word_count, talk_time_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;

    for s in speakers {
        stmt.execute(params![
            s.id,
            meeting_id,
            s.speaker_id,
            s.display_name,
            s.source,
            s.color,
            s.segment_count,
            s.word_count,
            s.talk_time_ms,
        ])?;
    }

    drop(stmt);
    transaction.commit()?;
    Ok(())
}

/// Rename a single speaker within a meeting. A remote speaker tag
/// ("them:S1") that has no row yet gets one, so its name persists.
pub fn rename_speaker(
    conn: &Connection,
    meeting_id: &str,
    speaker_id: &str,
    new_name: &str,
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    ensure_meeting_exists(&transaction, meeting_id)?;
    let updated = transaction.execute(
        "UPDATE meeting_speakers SET display_name = ?1 WHERE meeting_id = ?2 AND speaker_id = ?3",
        params![new_name, meeting_id, speaker_id],
    )?;
    if updated == 0 && speaker_id.starts_with("them:") {
        transaction.execute(
            "INSERT INTO meeting_speakers (id, meeting_id, speaker_id, display_name, source)
             VALUES (?1, ?2, ?3, ?4, 'remote_tag')",
            params![Uuid::new_v4().to_string(), meeting_id, speaker_id, new_name],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

/// List all speakers for a given meeting.
pub fn list_meeting_speakers(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingSpeaker>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, speaker_id, display_name, source, color, segment_count, word_count, talk_time_ms
         FROM meeting_speakers WHERE meeting_id = ?1",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingSpeaker {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            speaker_id: row.get(2)?,
            display_name: row.get(3)?,
            source: row.get(4)?,
            color: row.get(5)?,
            segment_count: row.get(6)?,
            word_count: row.get(7)?,
            talk_time_ms: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ── Meeting bookmarks CRUD ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingBookmark {
    pub id: String,
    pub meeting_id: String,
    pub timestamp_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_id: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
}

/// Replace all bookmarks for a meeting (delete + insert).
pub fn save_meeting_bookmarks(
    conn: &Connection,
    meeting_id: &str,
    bookmarks: &[MeetingBookmark],
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    ensure_meeting_exists(&transaction, meeting_id)?;
    transaction.execute(
        "DELETE FROM meeting_bookmarks WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = transaction.prepare(
        "INSERT INTO meeting_bookmarks (id, meeting_id, timestamp_ms, segment_id, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    for b in bookmarks {
        stmt.execute(params![
            b.id,
            meeting_id,
            b.timestamp_ms,
            b.segment_id,
            b.note,
            b.created_at,
        ])?;
    }

    drop(stmt);
    transaction.commit()?;
    Ok(())
}

/// List all bookmarks for a given meeting, ordered by timestamp.
pub fn list_meeting_bookmarks(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingBookmark>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, timestamp_ms, segment_id, note, created_at
         FROM meeting_bookmarks WHERE meeting_id = ?1 ORDER BY timestamp_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingBookmark {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            timestamp_ms: row.get(2)?,
            segment_id: row.get(3)?,
            note: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Add a single bookmark to a meeting.
pub fn add_meeting_bookmark(
    conn: &Connection,
    bookmark: &MeetingBookmark,
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    ensure_meeting_exists(&transaction, &bookmark.meeting_id)?;
    transaction.execute(
        "INSERT INTO meeting_bookmarks (id, meeting_id, timestamp_ms, segment_id, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            bookmark.id,
            bookmark.meeting_id,
            bookmark.timestamp_ms,
            bookmark.segment_id,
            bookmark.note,
            bookmark.created_at,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Update a bookmark's note.
pub fn update_meeting_bookmark_note(
    conn: &Connection,
    bookmark_id: &str,
    note: Option<&str>,
) -> Result<(), DatabaseError> {
    conn.execute(
        "UPDATE meeting_bookmarks SET note = ?1 WHERE id = ?2",
        params![note, bookmark_id],
    )?;
    Ok(())
}

/// Delete a single bookmark.
pub fn delete_meeting_bookmark(
    conn: &Connection,
    bookmark_id: &str,
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_bookmarks WHERE id = ?1",
        params![bookmark_id],
    )?;
    Ok(())
}

// ── Meeting action items CRUD ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingActionItem {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub assignee_speaker_id: Option<String>,
    pub timestamp_ms: i64,
    pub completed: bool,
}

/// Replace all action items for a meeting (delete + insert).
pub fn save_meeting_action_items(
    conn: &Connection,
    meeting_id: &str,
    items: &[MeetingActionItem],
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    ensure_meeting_exists(&transaction, meeting_id)?;
    transaction.execute(
        "DELETE FROM meeting_action_items WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = transaction.prepare(
        "INSERT INTO meeting_action_items (id, meeting_id, text, assignee_speaker_id, timestamp_ms, completed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    for item in items {
        stmt.execute(params![
            item.id,
            meeting_id,
            item.text,
            item.assignee_speaker_id,
            item.timestamp_ms,
            item.completed as i32,
        ])?;
    }

    drop(stmt);
    transaction.commit()?;
    Ok(())
}

/// List all action items for a given meeting, ordered by timestamp.
pub fn list_meeting_action_items(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingActionItem>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, text, assignee_speaker_id, timestamp_ms, completed
         FROM meeting_action_items WHERE meeting_id = ?1 ORDER BY timestamp_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingActionItem {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            text: row.get(2)?,
            assignee_speaker_id: row.get(3)?,
            timestamp_ms: row.get(4)?,
            completed: row.get(5)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Update completion status of a single action item.
pub fn update_action_item_completed(
    conn: &Connection,
    item_id: &str,
    completed: bool,
) -> Result<(), DatabaseError> {
    conn.execute(
        "UPDATE meeting_action_items SET completed = ?1 WHERE id = ?2",
        params![completed as i32, item_id],
    )?;
    Ok(())
}

/// Delete a single action item.
pub fn delete_action_item(
    conn: &Connection,
    item_id: &str,
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_action_items WHERE id = ?1",
        params![item_id],
    )?;
    Ok(())
}

// ── Meeting topic sections CRUD ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTopicSection {
    pub id: String,
    pub meeting_id: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

/// Replace all topic sections for a meeting (delete + insert).
pub fn save_meeting_topic_sections(
    conn: &Connection,
    meeting_id: &str,
    sections: &[MeetingTopicSection],
) -> Result<(), DatabaseError> {
    let transaction = conn.unchecked_transaction()?;
    ensure_meeting_exists(&transaction, meeting_id)?;
    transaction.execute(
        "DELETE FROM meeting_topic_sections WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = transaction.prepare(
        "INSERT INTO meeting_topic_sections (id, meeting_id, title, start_ms, end_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;

    for sec in sections {
        stmt.execute(params![
            sec.id,
            meeting_id,
            sec.title,
            sec.start_ms,
            sec.end_ms,
        ])?;
    }

    drop(stmt);
    transaction.commit()?;
    Ok(())
}

/// List all topic sections for a given meeting, ordered by start time.
pub fn list_meeting_topic_sections(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingTopicSection>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, title, start_ms, end_ms
         FROM meeting_topic_sections WHERE meeting_id = ?1 ORDER BY start_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingTopicSection {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            title: row.get(2)?,
            start_ms: row.get(3)?,
            end_ms: row.get(4)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        conn
    }

    fn segment(meeting_id: &str, id: &str, text: &str, tag: Option<&str>, ts: i64) -> TranscriptSegment {
        TranscriptSegment {
            id: id.into(),
            meeting_id: meeting_id.into(),
            text: text.into(),
            speaker: "Them".into(),
            speaker_id: Some("them".into()),
            speaker_tag: tag.map(str::to_string),
            timestamp_ms: ts,
            is_final: true,
            confidence: 0.9,
            created_at: "2026-10-22T10:00:00Z".into(),
        }
    }

    #[test]
    fn ai_history_keeps_cancelled_and_older_answers_across_upserts() {
        let conn = db();
        let meeting = create_meeting(&conn, "Answers").unwrap();
        let cancelled = serde_json::json!({
            "id": "cancelled", "response": "Partial answer", "timestamp": "2026-11-27T08:00:00.000Z",
        });
        merge_meeting_ai_interactions(&conn, &meeting.id, vec![cancelled.clone()]).unwrap();
        for index in 0..105 {
            let answer = serde_json::json!({
                "id": format!("answer-{index}"), "response": "Complete", "timestamp": "2026-11-27T08:01:00.000Z",
            });
            merge_meeting_ai_interactions(&conn, &meeting.id, vec![answer]).unwrap();
        }
        merge_meeting_ai_interactions(&conn, &meeting.id, vec![serde_json::json!({
            "id": "answer-104", "response": "Updated", "timestamp": "2026-11-27T08:02:00.000Z",
        })]).unwrap();

        let stored = get_meeting(&conn, &meeting.id).unwrap().ai_interactions;
        let entries = stored.as_array().unwrap();
        assert_eq!(entries.len(), 106);
        assert_eq!(entries[0]["response"], "Updated");
        assert_eq!(entries.last(), Some(&cancelled));
        assert!(entries.iter().any(|entry| entry["id"] == "answer-0"));
    }

    #[test]
    fn segments_keep_speaker_tag_and_latest_text() {
        let conn = db();
        migrations::run(&conn).unwrap(); // the v8 column migration is idempotent
        let meeting = create_meeting(&conn, "Sync").unwrap();
        append_transcript_segment(&conn, &meeting.id, &segment(&meeting.id, "p1", "We ship", Some("S2"), 1)).unwrap();
        append_transcript_segment(&conn, &meeting.id, &segment(&meeting.id, "p2", "Ok", None, 2)).unwrap();
        // The paragraph grew after it was first saved: saving it again replaces it.
        append_transcript_segment(&conn, &meeting.id, &segment(&meeting.id, "p1", "We ship on Friday", Some("S2"), 1)).unwrap();

        let loaded = list_transcript_segments(&conn, &meeting.id).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!((loaded[0].text.as_str(), loaded[0].speaker_tag.as_deref()), ("We ship on Friday", Some("S2")));
        assert_eq!(loaded[1].speaker_tag, None);
        let json = get_meeting(&conn, &meeting.id).unwrap().transcript;
        assert_eq!(json[0]["speaker_tag"], "S2");
        assert!(json[1].get("speaker_tag").is_none(), "untagged lines omit the field");
    }

    #[test]
    fn history_orders_old_relative_and_absolute_segment_times() {
        let conn = db();
        let meeting = create_meeting(&conn, "Mixed recording").unwrap();
        let start = chrono::DateTime::parse_from_rfc3339(&meeting.start_time).unwrap().timestamp_millis();
        append_transcript_segment(
            &conn, &meeting.id, &segment(&meeting.id, "relative", "later", None, 4000),
        ).unwrap();
        append_transcript_segment(
            &conn, &meeting.id, &segment(&meeting.id, "absolute", "earlier", None, start + 1000),
        ).unwrap();
        let transcript = get_meeting(&conn, &meeting.id).unwrap().transcript;
        assert_eq!(transcript[0]["id"], "absolute");
        assert_eq!(transcript[0]["timestamp_ms"], start + 1000);
        assert_eq!(transcript[1]["id"], "relative");
        assert_eq!(transcript[1]["timestamp_ms"], start + 4000);
    }

    #[test]
    fn failed_delete_commit_rolls_back_meeting_feature_and_translation_rows() {
        let conn = db();
        let meeting = create_meeting(&conn, "Recorded meeting").unwrap();
        update_meeting_recording(&conn, &meeting.id, "voice.ogg", 25, Some("voice.waveform.json"), 0).unwrap();
        let bookmark = MeetingBookmark {
            id: "bookmark".into(),
            meeting_id: meeting.id.clone(),
            timestamp_ms: 50,
            segment_id: Some("acc_1".into()),
            note: None,
            created_at: meeting.start_time.clone(),
        };
        add_meeting_bookmark(&conn, &bookmark).unwrap();
        append_transcript_segment(
            &conn, &meeting.id, &segment(&meeting.id, "acc_1", "Hello", None, 50),
        ).unwrap();
        super::super::translation::save_translation(
            &conn, "acc_1", &meeting.id, "en", "es", "Hello", "Hola", "provider",
        ).unwrap();

        conn.execute_batch(
            "CREATE TABLE force_bad_commit (
                 meeting_id TEXT REFERENCES meetings(id) DEFERRABLE INITIALLY DEFERRED
             );
             CREATE TRIGGER fail_meeting_delete_commit AFTER DELETE ON meetings BEGIN
                INSERT INTO force_bad_commit VALUES ('missing');
             END;",
        ).unwrap();
        assert!(delete_meeting(&conn, &meeting.id).is_err());
        assert!(pending_recording_file_deletion(&conn, &meeting.id).unwrap().is_none());
        let retained = get_meeting(&conn, &meeting.id).unwrap();
        assert_eq!(retained.recording_path.as_deref(), Some("voice.ogg"));
        assert_eq!(retained.waveform_path.as_deref(), Some("voice.waveform.json"));
        assert_eq!(list_meeting_bookmarks(&conn, &meeting.id).unwrap().len(), 1);
        assert_eq!(list_transcript_segments(&conn, &meeting.id).unwrap().len(), 1);
        assert_eq!(super::super::translation::count_meeting_translations(&conn, &meeting.id, "es").unwrap(), 1);

        conn.execute("DROP TRIGGER fail_meeting_delete_commit", []).unwrap();
        delete_meeting(&conn, &meeting.id).unwrap();
        assert_eq!(
            pending_recording_file_deletion(&conn, &meeting.id).unwrap(),
            Some((Some("voice.ogg".into()), Some("voice.waveform.json".into()))),
        );
        assert!(get_meeting(&conn, &meeting.id).is_err());
        assert!(list_meeting_bookmarks(&conn, &meeting.id).unwrap().is_empty());
        assert!(list_transcript_segments(&conn, &meeting.id).unwrap().is_empty());
        assert_eq!(super::super::translation::count_meeting_translations(&conn, &meeting.id, "es").unwrap(), 0);
        assert!(add_meeting_bookmark(&conn, &bookmark).is_err());
    }

    #[test]
    fn replacement_rolls_back_on_a_duplicate_and_history_is_unpaginated() {
        let conn = db();
        let active = create_meeting(&conn, "Current meeting").unwrap();
        let old = create_meeting(&conn, "Old meeting").unwrap();
        for _ in 0..50 {
            create_meeting(&conn, "More history").unwrap();
        }
        let ids = list_meeting_history_ids(&conn, Some(&active.id)).unwrap();
        assert_eq!(ids.len(), 51);
        assert!(ids.contains(&old.id));
        assert!(!ids.contains(&active.id));

        let topic = |id: &str| MeetingTopicSection {
            id: id.into(), meeting_id: old.id.clone(), title: id.into(), start_ms: 0, end_ms: None,
        };
        save_meeting_topic_sections(&conn, &old.id, &[topic("original")]).unwrap();
        assert!(save_meeting_topic_sections(&conn, &old.id, &[topic("same"), topic("same")]).is_err());
        let loaded = list_meeting_topic_sections(&conn, &old.id).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "original");
    }

    #[test]
    fn renaming_a_remote_tag_creates_its_speaker_row_once() {
        let conn = db();
        let meeting = create_meeting(&conn, "Sync").unwrap();
        rename_speaker(&conn, &meeting.id, &remote_speaker_id("S1"), "Erin").unwrap();
        rename_speaker(&conn, &meeting.id, &remote_speaker_id("S1"), "Erin K").unwrap();
        // Other speakers are only renamed when they exist.
        rename_speaker(&conn, &meeting.id, "speaker_3", "Nobody").unwrap();
        let speakers = list_meeting_speakers(&conn, &meeting.id).unwrap();
        assert_eq!(speakers.len(), 1);
        assert_eq!(
            (speakers[0].speaker_id.as_str(), speakers[0].display_name.as_str(), speakers[0].source.as_str()),
            ("them:S1", "Erin K", "remote_tag")
        );
    }

    #[test]
    fn default_remote_speaker_names() {
        assert_eq!(default_remote_speaker_name("S1"), "Speaker 1");
        assert_eq!(default_remote_speaker_name("S12"), "Speaker 12");
        assert_eq!(default_remote_speaker_name("X"), "X");
    }
}
