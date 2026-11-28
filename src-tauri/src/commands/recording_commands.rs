use serde::Serialize;
use std::{fs, path::Path};
use tauri::{command, State};

use crate::audio::waveform::{downsample_waveform, WaveformData};
use crate::state::AppState;

/// Maximum waveform peaks returned to the frontend.
const MAX_WAVEFORM_PEAKS: usize = 4000;

#[derive(Debug, Serialize)]
pub struct RecordingInfo {
    pub path: String,
    pub size_bytes: i64,
    pub duration_ms: u64,
    pub waveform_path: String,
    pub offset_ms: i64,
    pub waveform_data: Option<WaveformData>,
}

/// Query playback metadata. The waveform is optional, including for older
/// recordings with a missing, empty or unreadable waveform path.
#[command]
pub async fn get_recording_info(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RecordingInfo>, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let result: rusqlite::Result<(Option<String>, Option<i64>, Option<String>, Option<i64>)> = {
        let db = db.lock().map_err(|e| format!("Failed to lock database: {e}"))?;
        db.connection().query_row(
            "SELECT recording_path, recording_size, waveform_path, recording_offset_ms \
             FROM meetings WHERE id = ?1",
            rusqlite::params![meeting_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
    };

    match result {
        Ok((Some(path), size, waveform, offset)) if !path.is_empty() =>
            tokio::task::spawn_blocking(move || read_recording_info(path, size, waveform, offset))
                .await
                .map(Some)
                .map_err(|err| format!("Failed to read recording metadata: {err}")),
        Err(rusqlite::Error::QueryReturnedNoRows) | Ok(_) => Ok(None),
        Err(e) => Err(format!("Failed to query recording info: {e}")),
    }
}

fn read_recording_info(
    path: String,
    size: Option<i64>,
    waveform: Option<String>,
    offset: Option<i64>,
) -> RecordingInfo {
    let waveform_data: Option<WaveformData> = waveform.as_ref().filter(|path| !path.is_empty())
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok());
    let duration_ms = waveform_data.as_ref().map(|data| data.duration_ms)
        .or_else(|| recording_duration_ms(Path::new(&path)))
        .unwrap_or_default();
    RecordingInfo {
        size_bytes: size.or_else(|| fs::metadata(&path).ok().map(|info| info.len() as i64)).unwrap_or_default(),
        path,
        duration_ms,
        waveform_path: waveform.filter(|_| waveform_data.is_some()).unwrap_or_default(),
        offset_ms: offset.unwrap_or_default(),
        waveform_data: waveform_data.map(|data| downsample_waveform(data, MAX_WAVEFORM_PEAKS)),
    }
}

fn recording_duration_ms(path: &Path) -> Option<u64> {
    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("wav")) {
        let reader = hound::WavReader::open(path).ok()?;
        (u64::from(reader.duration()) * 1000).checked_div(u64::from(reader.spec().sample_rate))
    } else {
        crate::audio::encoder::opus_duration_ms(path)
    }
}

/// Return the absolute filesystem path of the recording file.
/// The frontend uses convertFileSrc() to convert this to a WebView-accessible URL.
#[command]
pub async fn get_recording_file_url(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _artifacts = state.recording_artifacts.lock().await;
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let conn = db.connection();

    let path: Option<String> = conn
        .query_row(
            "SELECT recording_path FROM meetings WHERE id = ?1",
            rusqlite::params![meeting_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query recording path: {}", e))?;

    path.filter(|path| !path.is_empty())
        .ok_or_else(|| format!("No recording found for meeting {}", meeting_id))
}

/// Delete recording and waveform files from disk and clear recording columns in DB.
#[command]
pub async fn delete_recording(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _lifecycle = state.meeting_lifecycle.lock().await;
    if super::meeting_commands::active_meeting_id(&state)?.as_deref() == Some(meeting_id.as_str()) {
        return Err("Cannot delete a recording for the active meeting".to_string());
    }
    let _artifacts = state.recording_artifacts.lock().await;
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let conn = db.connection();
    crate::db::meetings::delete_recording(conn, &meeting_id)
        .map_err(|e| format!("Failed to clear recording metadata: {e}"))?;
    complete_recording_file_deletion(conn, &meeting_id)
        .map_err(|e| format!("Recording files are pending cleanup: {e}"))
}

pub(crate) fn complete_recording_file_deletion(
    conn: &rusqlite::Connection,
    meeting_id: &str,
) -> Result<(), String> {
    use crate::db::meetings::{confirm_recording_file_deletion, pending_recording_file_deletion};

    if let Some((recording, waveform)) = pending_recording_file_deletion(conn, meeting_id)
        .map_err(|error| error.to_string())?
    {
        remove_recording_files(meeting_id, recording.as_deref(), waveform.as_deref())
            .map_err(|error| error.to_string())?;
        confirm_recording_file_deletion(conn, meeting_id).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Recover deletion requests interrupted between the database commit and unlink.
pub(crate) fn recover_recording_file_deletions(conn: &rusqlite::Connection) {
    match crate::db::meetings::pending_recording_file_deletion_ids(conn) {
        Ok(ids) => {
            for id in ids {
                if let Err(error) = complete_recording_file_deletion(conn, &id) {
                    log::warn!("Recording cleanup still pending for meeting {id}: {error}");
                }
            }
        }
        Err(error) => log::warn!("Couldn't read pending recording deletions: {error}"),
    }
}

fn remove_recording_files(
    meeting_id: &str,
    recording_path: Option<&str>,
    waveform_path: Option<&str>,
) -> std::io::Result<()> {
    let primary = recording_path.filter(|path| !path.is_empty()).map(std::path::Path::new);
    if let Some(waveform) = waveform_path.filter(|path| !path.is_empty()).map(std::path::Path::new) {
        if Some(waveform) != primary {
            remove_recording_file(waveform)?;
        }
    }

    // Interrupted processing on earlier versions may leave files before their
    // paths make it into SQLite. Capture always names these files by meeting UUID.
    if let (Ok(id), Ok(directory)) = (uuid::Uuid::parse_str(meeting_id), crate::paths::recordings_dir()) {
        for extension in ["waveform.json", "wav", "ogg"] {
            let path = directory.join(format!("{id}.{extension}"));
            if Some(path.as_path()) != primary {
                remove_recording_file(&path)?;
            }
        }
    }

    // Keep the playable recording if cleaning up a sidecar fails.
    if let Some(path) = primary {
        remove_recording_file(path)?;
    }
    Ok(())
}

fn remove_recording_file(path: &std::path::Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(std::io::Error::new(
            error.kind(),
            format!("Failed to delete {}: {error}", path.display()),
        )),
    }
}

#[cfg(test)]
mod file_cleanup_tests {
    use super::*;
    use crate::db::{meetings, migrations};

    #[test]
    fn a_valid_audio_file_plays_without_waveform_or_other_metadata() {
        let wav = std::env::temp_dir().join(format!("nexq-info-{}.wav", uuid::Uuid::new_v4()));
        let writer = crate::audio::recorder::start_recording_at(wav.clone()).unwrap();
        writer.write_samples(&[100; 1600]);
        writer.stop().unwrap();
        for wave in [None, Some(String::new()), Some(wav.to_string_lossy().into_owned())] {
            let info = read_recording_info(wav.to_string_lossy().into_owned(), None, wave, None);
            assert_eq!(Path::new(&info.path), wav.as_path());
            assert!(info.size_bytes > 0);
            assert_eq!(info.duration_ms, 100);
            assert!(info.waveform_path.is_empty());
            assert!(info.waveform_data.is_none());
        }
        let _ = fs::remove_file(wav);
    }

    #[test]
    fn deleting_history_removes_the_recording_and_waveform() {
        let directory = std::env::temp_dir().join(format!("nexq-delete-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let recording = directory.join("meeting.ogg");
        let waveform = directory.join("meeting.waveform.json");
        fs::write(&recording, "recording").unwrap();
        fs::write(&waveform, "waveform").unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        let meeting = meetings::create_meeting(&conn, "Recorded meeting").unwrap();
        meetings::update_meeting_recording(
            &conn,
            &meeting.id,
            recording.to_str().unwrap(),
            9,
            waveform.to_str(),
            0,
        ).unwrap();
        meetings::delete_meeting(&conn, &meeting.id).unwrap();
        assert!(recording.exists());
        assert!(waveform.exists());
        complete_recording_file_deletion(&conn, &meeting.id).unwrap();

        assert!(!recording.exists());
        assert!(!waveform.exists());
        assert!(meetings::get_meeting(&conn, &meeting.id).is_err());
        assert!(meetings::pending_recording_file_deletion(&conn, &meeting.id).unwrap().is_none());
        complete_recording_file_deletion(&conn, &meeting.id).unwrap();
        fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn failed_file_cleanup_is_retried_from_database_on_restart() {
        let directory = std::env::temp_dir().join(format!("nexq-delete-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let database = directory.join("nexq.db");
        let recording = directory.join("meeting.ogg");
        let unavailable_waveform = directory.join("meeting.waveform.json");
        fs::write(&recording, "recording").unwrap();
        fs::create_dir(&unavailable_waveform).unwrap();
        let conn = rusqlite::Connection::open(&database).unwrap();
        migrations::run(&conn).unwrap();
        let meeting = meetings::create_meeting(&conn, "Recorded meeting").unwrap();
        meetings::update_meeting_recording(
            &conn, &meeting.id, recording.to_str().unwrap(), 9, unavailable_waveform.to_str(), 0,
        ).unwrap();

        meetings::delete_recording(&conn, &meeting.id).unwrap();
        assert!(meetings::get_meeting(&conn, &meeting.id).unwrap().recording_path.is_none());
        assert!(complete_recording_file_deletion(&conn, &meeting.id).is_err());
        assert!(recording.exists());
        assert!(meetings::pending_recording_file_deletion(&conn, &meeting.id).unwrap().is_some());
        drop(conn);

        fs::remove_dir(&unavailable_waveform).unwrap();
        let conn = rusqlite::Connection::open(&database).unwrap();
        migrations::run(&conn).unwrap();
        recover_recording_file_deletions(&conn);
        assert!(!recording.exists());
        assert!(meetings::pending_recording_file_deletion(&conn, &meeting.id).unwrap().is_none());
        drop(conn);
        fs::remove_dir_all(&directory).unwrap();
    }
}
