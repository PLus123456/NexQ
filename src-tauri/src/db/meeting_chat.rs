//! "Ask this meeting" chat: the questions asked about a past meeting and the
//! answers given, saved with the meeting.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// One chat message about a meeting. `created_at` is Unix milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingChatMessage {
    pub id: String,
    pub meeting_id: String,
    /// `"user"` | `"assistant"`.
    pub role: String,
    pub content: String,
    /// The model that answered (assistant rows).
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub created_at: i64,
}

pub fn insert_chat_message(conn: &Connection, msg: &MeetingChatMessage) -> rusqlite::Result<()> {
    let rows = conn.execute(
        "INSERT INTO meeting_chat
            (id, meeting_id, role, content, model, input_tokens, output_tokens, created_at)
         SELECT ?1, id, ?3, ?4, ?5, ?6, ?7, ?8 FROM meetings WHERE id = ?2",
        params![
            msg.id,
            msg.meeting_id,
            msg.role,
            msg.content,
            msg.model,
            msg.input_tokens,
            msg.output_tokens,
            msg.created_at,
        ],
    )?;
    if rows == 0 {
        Err(rusqlite::Error::QueryReturnedNoRows)
    } else {
        Ok(())
    }
}

/// The meeting's chat, oldest first (insert order breaks ties).
pub fn list_chat_messages(conn: &Connection, meeting_id: &str) -> rusqlite::Result<Vec<MeetingChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, role, content, model, input_tokens, output_tokens, created_at
         FROM meeting_chat WHERE meeting_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingChatMessage {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            input_tokens: row.get(5)?,
            output_tokens: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Remove a meeting's chat (the meeting is being deleted).
pub fn delete_chat_messages(conn: &Connection, meeting_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM meeting_chat WHERE meeting_id = ?1", params![meeting_id])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{meetings, migrations};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO meetings (id, title, start_time) VALUES
                ('m1', 'Chat meeting', '2026-11-27T00:00:00Z'),
                ('other', 'Other meeting', '2026-11-27T01:00:00Z')",
            [],
        ).unwrap();
        conn
    }

    fn msg(id: &str, meeting_id: &str, role: &str, content: &str, created_at: i64) -> MeetingChatMessage {
        MeetingChatMessage {
            id: id.into(),
            meeting_id: meeting_id.into(),
            role: role.into(),
            content: content.into(),
            model: (role == "assistant").then(|| "sonnet".to_string()),
            input_tokens: (role == "assistant").then_some(120),
            output_tokens: (role == "assistant").then_some(30),
            created_at,
        }
    }

    #[test]
    fn chat_roundtrip_in_memory() {
        let conn = db();
        // Inserted out of order: listing follows created_at.
        let answer = msg("a1", "m1", "assistant", "Friday.", 2_000);
        let question = msg("q1", "m1", "user", "When do we ship?", 1_000);
        insert_chat_message(&conn, &answer).unwrap();
        insert_chat_message(&conn, &question).unwrap();
        insert_chat_message(&conn, &msg("q9", "other", "user", "Unrelated", 1_500)).unwrap();

        let listed = list_chat_messages(&conn, "m1").unwrap();
        assert_eq!(listed, vec![question, answer]);
        assert!(list_chat_messages(&conn, "nope").unwrap().is_empty());
    }

    #[test]
    fn meeting_chat_rejects_unknown_role() {
        let conn = db();
        assert!(insert_chat_message(&conn, &msg("x", "m1", "system", "no", 1)).is_err());
    }

    #[test]
    fn meeting_chat_same_millisecond_keeps_insert_order() {
        let conn = db();
        insert_chat_message(&conn, &msg("q", "m1", "user", "Q", 5)).unwrap();
        insert_chat_message(&conn, &msg("a", "m1", "assistant", "A", 5)).unwrap();
        let ids: Vec<String> = list_chat_messages(&conn, "m1").unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["q", "a"]);
    }

    #[test]
    fn migration_idempotent() {
        let conn = db();
        migrations::run(&conn).unwrap();
        insert_chat_message(&conn, &msg("q1", "m1", "user", "Still works?", 1)).unwrap();
        assert_eq!(list_chat_messages(&conn, "m1").unwrap().len(), 1);
    }

    #[test]
    fn meeting_chat_deleted_with_its_meeting() {
        let conn = db();
        let meeting = meetings::create_meeting(&conn, "Standup").unwrap();
        insert_chat_message(&conn, &msg("q1", &meeting.id, "user", "Q", 1)).unwrap();
        insert_chat_message(&conn, &msg("a1", &meeting.id, "assistant", "A", 2)).unwrap();
        meetings::delete_meeting(&conn, &meeting.id).unwrap();
        assert!(list_chat_messages(&conn, &meeting.id).unwrap().is_empty());
        assert!(insert_chat_message(&conn, &msg("late", &meeting.id, "assistant", "Late reply", 3)).is_err());
    }
}
