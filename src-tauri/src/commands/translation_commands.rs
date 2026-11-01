// src-tauri/src/commands/translation_commands.rs
use tauri::{command, AppHandle, Emitter};
use crate::state::AppState;
use crate::llm::api::{resolve_for_task, LlmTask};
use crate::translation::{
    TranslationProviderType, TranslationResult, ConnectionStatus, Language,
    DetectedLanguage, TranslationKeys,
};
use crate::translation::llm_provider::translate_with_llm;
use crate::translation::options::TranslationOptionsPatch;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::Manager;

/// One live segment or a selection.
const LIVE_LLM_TIMEOUT: Duration = Duration::from_secs(30);
/// One segment of a post-meeting batch.
const BATCH_LLM_TIMEOUT: Duration = Duration::from_secs(60);
/// The settings page's "Test" button.
const TEST_LLM_TIMEOUT: Duration = Duration::from_secs(15);

/// `translation_backend_status`: the outcome of the last
/// `set_translation_provider`, for every window (the frontend shows the error).
#[derive(Debug, Clone, Serialize)]
struct BackendStatus {
    provider: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn parse_provider(provider: &str) -> Result<TranslationProviderType, String> {
    match provider {
        "microsoft" => Ok(TranslationProviderType::Microsoft),
        "google" => Ok(TranslationProviderType::Google),
        "deepl" => Ok(TranslationProviderType::Deepl),
        "opus-mt" => Ok(TranslationProviderType::OpusMt),
        "llm" => Ok(TranslationProviderType::Llm),
        other => Err(format!("Unknown translation provider: {}", other)),
    }
}

/// Every translation key in the keychain. A non-empty `region` (sent by the
/// settings page) wins over the stored Microsoft region; otherwise the stored
/// one is used, so restoring the provider at startup keeps the user's region.
fn read_keys(state: &AppState, region: Option<String>) -> TranslationKeys {
    let mut keys = TranslationKeys::default();
    if let Some(ref cred_arc) = state.credentials {
        if let Ok(cred) = cred_arc.lock() {
            let read = |slot: &str| cred.get_key(slot).ok().flatten().filter(|v| !v.trim().is_empty());
            keys.microsoft = read("translation_microsoft");
            keys.google = read("translation_google");
            keys.deepl = read("translation_deepl");
            keys.microsoft_region = region
                .filter(|r| !r.trim().is_empty())
                .or_else(|| read("translation_microsoft_region"));
        }
    }
    keys
}

/// "Connection · model" of the LLM routed to `task`, for the result's provider field.
async fn llm_provider_label(app: &AppHandle, task: &LlmTask) -> String {
    match resolve_for_task(app, task).await {
        Ok(resolved) => format!("{} · {}", resolved.display_name, resolved.model),
        Err(_) => "LLM Translation".to_string(),
    }
}

/// `options` (service addresses, LLM prompts) is optional: missing parts keep
/// what the backend has, so older callers that send only the provider still work.
#[command]
pub async fn set_translation_provider(
    app: AppHandle,
    provider: String,
    region: Option<String>,
    options: Option<TranslationOptionsPatch>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let result = match parse_provider(&provider) {
        Ok(provider_type) => {
            // Keychain reads happen before the router lock is taken.
            let keys = read_keys(&state, region);
            let trans_arc = state.translation.as_ref()
                .ok_or("Translation router not initialized")?;
            let mut router = trans_arc.lock()
                .map_err(|_| "Translation lock poisoned".to_string())?;
            router.set_keys(keys);
            if let Some(patch) = options {
                router.apply_options(patch);
            }
            router.set_provider(provider_type).map_err(|e| e.to_string())
        }
        Err(e) => Err(e),
    };

    let _ = app.emit("translation_backend_status", BackendStatus {
        provider,
        ok: result.is_ok(),
        error: result.as_ref().err().cloned(),
    });
    result
}

/// Update the backend's default target/source language for translation.
/// Called by the frontend whenever the user changes language settings.
#[command]
pub async fn set_translation_languages(
    app: AppHandle,
    target_lang: String,
    source_lang: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let mut router = trans_arc.lock()
        .map_err(|_| "Translation lock poisoned".to_string())?;

    router.set_default_target_lang(target_lang.clone());
    router.set_default_source_lang(source_lang.clone());
    log::info!("Translation languages updated: target={}, source={:?}", target_lang, source_lang);
    Ok(())
}

#[command]
pub async fn translate_text(
    app: AppHandle,
    text: String,
    target_lang: String,
    source_lang: Option<String>,
) -> Result<TranslationResult, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;

    let target = target_lang;
    let source = source_lang.filter(|s| !s.is_empty() && s != "auto");

    // Clone Arc<dyn Provider> and what its answers depend on BEFORE dropping lock
    let (provider, llm_settings, fingerprint) = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        let p = router.get_provider().map_err(|e| e.to_string())?;
        // LLM translation goes through the LLM settings' task routing
        let llm = (router.active_type() == Some(&TranslationProviderType::Llm))
            .then(|| router.options().llm.clone());
        (p, llm, router.options_fingerprint())
        // Lock dropped here — safe to .await below
    };
    let provider_name = match &llm_settings {
        Some(_) => llm_provider_label(&app, &LlmTask::Translation).await,
        None => provider.provider_name().to_string(),
    };

    // Check the cache: same text, target, source, provider (and model), settings
    let scope = crate::translation::cache_scope(&target, source.as_deref(), &provider_name, fingerprint);
    let cached = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.cache().get(&text, &scope).map(str::to_string)
    };
    if let Some(cached) = cached {
        return Ok(TranslationResult {
            segment_id: None,
            original_text: text,
            translated_text: cached,
            source_lang: source.as_deref().unwrap_or("auto").to_string(),
            target_lang: target,
            provider: provider_name,
        });
    }

    // Translate — no lock held, using Arc clone
    let translated = if let Some(settings) = llm_settings {
        translate_with_llm(&app, &LlmTask::Translation, &settings, &text, source.as_deref(), &target, LIVE_LLM_TIMEOUT).await?
    } else {
        // Split long text if needed (>5000 chars for cloud providers)
        let chunks = crate::translation::TranslationRouter::split_long_text(&text, 5000);
        let mut parts = Vec::new();
        for chunk in &chunks {
            // Retry once on failure
            match provider.translate(chunk, source.as_deref(), &target).await {
                Ok(t) => parts.push(t),
                Err(_first_err) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    match provider.translate(chunk, source.as_deref(), &target).await {
                        Ok(t) => parts.push(t),
                        Err(e) => {
                            // Track consecutive failures
                            let mut router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
                            let count = router.record_failure();
                            if count >= 3 {
                                let _ = app.emit("translation_error", serde_json::json!({
                                    "error": "Translation paused — connection issue",
                                    "consecutive_failures": count,
                                }));
                            }
                            return Err(e.to_string());
                        }
                    }
                }
            }
        }
        // Reset failure counter on success
        {
            let mut router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
            router.reset_failures();
        }
        parts.join("")
    };

    // Cache the result
    {
        let mut router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.cache_mut().insert(&text, &scope, translated.clone());
    }

    Ok(TranslationResult {
        segment_id: None,
        original_text: text,
        translated_text: translated,
        source_lang: source.as_deref().unwrap_or("auto").to_string(),
        target_lang: target,
        provider: provider_name,
    })
}

#[command]
pub async fn translate_segments(
    app: AppHandle,
    segment_ids: Vec<String>,
    texts: Vec<String>,
    meeting_id: String,
    target_lang: Option<String>,
    source_lang: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let target = target_lang.ok_or("target_lang is required")?;
    let source = source_lang.filter(|s| !s.is_empty() && s != "auto");
    let source = source.as_deref();

    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;

    // Clone provider Arc out of lock scope — safe to .await
    let provider = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.get_provider().map(|p| {
            let name = p.provider_name().to_string();
            let llm = (router.active_type() == Some(&TranslationProviderType::Llm))
                .then(|| router.options().llm.clone());
            (p, name, llm)
        })
    };
    let (provider_arc, mut provider_name, llm_settings) = match provider {
        Ok(found) => found,
        Err(e) => {
            // Every requested line learns why it stays untranslated.
            let error = e.to_string();
            for (seg_id, text) in segment_ids.iter().zip(texts.iter()) {
                emit_segment_error(&app, seg_id, text, &error);
            }
            return Err(error);
        }
    };
    if llm_settings.is_some() {
        provider_name = llm_provider_label(&app, &LlmTask::Translation).await;
    }
    // Ids only (no text): one line per request shows a line is translated once.
    log::info!(
        "Translating segment(s) {} into {} via {}",
        segment_ids.join(", "), target, provider_name
    );

    for (seg_id, text) in segment_ids.iter().zip(texts.iter()) {
        let translated = match &llm_settings {
            Some(settings) => {
                translate_with_llm(&app, &LlmTask::Translation, settings, text, source, &target, LIVE_LLM_TIMEOUT).await
            }
            None => provider_arc.translate(text, source, &target).await.map_err(|e| e.to_string()),
        };
        let translated = match translated {
            Ok(translated) => translated,
            Err(error) => {
                emit_segment_error(&app, seg_id, text, &error);
                return Err(error);
            }
        };

        // Save to DB
        if let Some(ref db_arc) = state.database {
            if let Ok(db) = db_arc.lock() {
                let _ = crate::db::translation::save_translation(
                    db.connection(),
                    seg_id,
                    &meeting_id,
                    source.unwrap_or("auto"),
                    &target,
                    text,
                    &translated,
                    &provider_name,
                );
            }
        }

        // Emit result event
        let result = TranslationResult {
            segment_id: Some(seg_id.clone()),
            original_text: text.clone(),
            translated_text: translated,
            source_lang: source.unwrap_or("auto").to_string(),
            target_lang: target.clone(),
            provider: provider_name.clone(),
        };
        let _ = app.emit("translation_result", &result);
    }

    Ok(())
}

/// `translation_error` for one line; `original_text` lets the frontend ignore
/// the failure of a request it already replaced with a newer text.
fn emit_segment_error(app: &AppHandle, segment_id: &str, original_text: &str, error: &str) {
    let _ = app.emit("translation_error", serde_json::json!({
        "segment_id": segment_id,
        "original_text": original_text,
        "error": error,
    }));
}

/// `parties` limits the batch to "you" (the user's lines) and/or "them"
/// (everyone else); `None` translates every line.
#[command]
pub async fn translate_batch(
    app: AppHandle,
    meeting_id: String,
    target_lang: Option<String>,
    parties: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let target = target_lang.ok_or("target_lang is required")?;

    // Count total segments and load only untranslated ones (skip already-translated to save API calls)
    let (total, already_done, untranslated): (usize, usize, Vec<(String, String)>) = match speaker_filter(parties.as_deref()) {
        None => (0, 0, Vec::new()),
        Some(filter) => {
            let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
            let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

            let total: usize = db.connection().query_row(
                &format!("SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = ?1 AND ts.is_final = 1{filter}"),
                [&meeting_id],
                |row| row.get(0),
            ).map_err(|e| e.to_string())?;

            let mut stmt = db.connection().prepare(&format!(
                "SELECT ts.id, ts.text FROM transcript_segments ts
                 WHERE ts.meeting_id = ?1 AND ts.is_final = 1{filter}
                   AND ts.id NOT IN (
                     SELECT segment_id FROM transcript_translations
                     WHERE meeting_id = ?1 AND target_lang = ?2
                   )
                 ORDER BY ts.timestamp_ms"
            )).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&meeting_id, &target], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

            // Final lines of these parties that already have a translation.
            (total, total.saturating_sub(rows.len()), rows)
        }
    };

    // Nothing to translate — emit completed and return
    if untranslated.is_empty() {
        let _ = app.emit("batch_translation_progress", serde_json::json!({
            "meetingId": meeting_id,
            "completed": total,
            "total": total,
            "targetLang": target,
        }));
        return Ok(serde_json::json!({
            "total": total,
            "alreadyDone": already_done,
            "newlyTranslated": 0,
        }));
    }

    // Emit initial progress so UI shows the starting point (e.g. 10/24)
    if already_done > 0 {
        let _ = app.emit("batch_translation_progress", serde_json::json!({
            "meetingId": meeting_id,
            "completed": already_done,
            "total": total,
            "targetLang": target,
        }));
    }

    let (provider_arc, mut provider_name, llm_settings) = {
        let trans_arc = state.translation.as_ref()
            .ok_or("Translation router not initialized")?;
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        let p = router.get_provider().map_err(|e| e.to_string())?;
        let llm = (router.active_type() == Some(&TranslationProviderType::Llm))
            .then(|| router.options().llm.clone());
        (p, router.active_provider_name(), llm)
    };
    if llm_settings.is_some() {
        provider_name = llm_provider_label(&app, &LlmTask::TranslationBatch).await;
    }

    // Translate only untranslated segments in chunks of 10
    let mut completed = already_done;
    for chunk in untranslated.chunks(10) {
        let texts: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();

        let translations = if let Some(settings) = &llm_settings {
            let mut results = Vec::with_capacity(texts.len());
            for text in &texts {
                results.push(
                    translate_with_llm(&app, &LlmTask::TranslationBatch, settings, text, None, &target, BATCH_LLM_TIMEOUT)
                        .await?,
                );
            }
            results
        } else {
            provider_arc.translate_batch(&texts, None, &target).await
                .map_err(|e| e.to_string())?
        };

        // Save each translation
        for ((seg_id, orig_text), translated) in chunk.iter().zip(translations.iter()) {
            if let Some(ref db_arc) = state.database {
                if let Ok(db) = db_arc.lock() {
                    let _ = crate::db::translation::save_translation(
                        db.connection(), seg_id, &meeting_id,
                        "auto", &target, orig_text, translated, &provider_name,
                    );
                }
            }

            let result = TranslationResult {
                segment_id: Some(seg_id.clone()),
                original_text: orig_text.clone(),
                translated_text: translated.clone(),
                source_lang: "auto".to_string(),
                target_lang: target.clone(),
                provider: provider_name.clone(),
            };
            let _ = app.emit("translation_result", &result);
        }

        // Emit progress
        completed += chunk.len();
        let _ = app.emit("batch_translation_progress", serde_json::json!({
            "meetingId": meeting_id,
            "completed": completed.min(total),
            "total": total,
            "targetLang": target,
        }));
    }

    let newly_translated = completed - already_done;
    Ok(serde_json::json!({
        "total": total,
        "alreadyDone": already_done,
        "newlyTranslated": newly_translated,
    }))
}

/// SQL condition (on `ts.speaker`) for the parties a batch covers: `""` for
/// everyone, `None` when no party is selected.
fn speaker_filter(parties: Option<&[String]>) -> Option<&'static str> {
    let Some(parties) = parties else { return Some("") };
    let you = parties.iter().any(|p| p == "you");
    let them = parties.iter().any(|p| p == "them");
    match (you, them) {
        (true, true) => Some(""),
        (true, false) => Some(" AND ts.speaker = 'User'"),
        (false, true) => Some(" AND ts.speaker <> 'User'"),
        (false, false) => None,
    }
}

#[command]
pub async fn detect_language(
    app: AppHandle,
    text: String,
) -> Result<DetectedLanguage, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let provider_arc = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.get_provider().map_err(|e| e.to_string())?
        // lock dropped here
    };
    provider_arc.detect_language(&text).await.map_err(|e| e.to_string())
}

/// Tests `provider` with the stored keys and the given (possibly unsaved)
/// region and options, without changing the active provider. LLM translation
/// translates a real sentence with the model routed to translation.
#[command]
pub async fn test_translation_connection(
    app: AppHandle,
    provider: String,
    region: Option<String>,
    options: Option<TranslationOptionsPatch>,
) -> Result<ConnectionStatus, String> {
    let state = app.state::<AppState>();
    let provider_type = parse_provider(&provider)?;
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;

    if provider_type == TranslationProviderType::Llm {
        let (settings, target) = {
            let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
            (router.options().with(options).llm, router.default_target_lang().to_string())
        };
        let (sample, source) = test_sentence(&target);
        let start = Instant::now();
        let result = translate_with_llm(
            &app, &LlmTask::Translation, &settings, sample, Some(source), &target, TEST_LLM_TIMEOUT,
        ).await;
        let response_ms = start.elapsed().as_millis() as u64;
        return Ok(match result {
            Ok(translated) => ConnectionStatus {
                connected: true, language_count: 0, response_ms, error: None, sample: Some(translated),
            },
            Err(error) => ConnectionStatus {
                connected: false, language_count: 0, response_ms, error: Some(error), sample: None,
            },
        });
    }

    let keys = read_keys(&state, region);
    let built = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        let options = router.options().with(options);
        router.build_provider(&provider_type, &keys, &options)
        // lock dropped here
    };
    match built {
        Ok(provider) => provider.test_connection().await.map_err(|e| e.to_string()),
        Err(e) => Ok(ConnectionStatus {
            connected: false, language_count: 0, response_ms: 0, error: Some(e.to_string()), sample: None,
        }),
    }
}

/// A sentence to test translation into `target`, and its language.
fn test_sentence(target: &str) -> (&'static str, &'static str) {
    if crate::translation::lang_map::english_source_name(target) == "English" {
        ("Buenos días a todos, empecemos la reunión.", "es")
    } else {
        ("Good morning, everyone. Let's get started.", "en")
    }
}

#[command]
pub async fn get_translation_languages(
    app: AppHandle,
) -> Result<Vec<Language>, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let provider_arc = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.get_provider().map_err(|e| e.to_string())?
        // lock dropped here
    };
    provider_arc.supported_languages().await.map_err(|e| e.to_string())
}

#[command]
pub async fn get_meeting_translations(
    app: AppHandle,
    meeting_id: String,
    target_lang: String,
) -> Result<Vec<TranslationResult>, String> {
    let state = app.state::<AppState>();
    let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
    let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

    let rows = crate::db::translation::get_meeting_translations(
        db.connection(), &meeting_id, &target_lang
    ).map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|r| TranslationResult {
        segment_id: Some(r.segment_id),
        original_text: r.original_text,
        translated_text: r.translated_text,
        source_lang: r.source_lang,
        target_lang: r.target_lang,
        provider: r.provider,
    }).collect())
}

#[command]
pub async fn get_all_meeting_translations(
    app: AppHandle,
    meeting_id: String,
) -> Result<Vec<TranslationResult>, String> {
    let state = app.state::<AppState>();
    let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
    let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

    let rows = crate::db::translation::get_all_meeting_translations(
        db.connection(), &meeting_id
    ).map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|r| TranslationResult {
        segment_id: Some(r.segment_id),
        original_text: r.original_text,
        translated_text: r.translated_text,
        source_lang: r.source_lang,
        target_lang: r.target_lang,
        provider: r.provider,
    }).collect())
}

#[command]
pub async fn export_translated_transcript(
    app: AppHandle,
    meeting_id: String,
    target_lang: String,
    format: String,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
    let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

    // Load segments
    let mut seg_stmt = db.connection().prepare(
        "SELECT id, text, speaker, timestamp_ms FROM transcript_segments
         WHERE meeting_id = ?1 AND is_final = 1 ORDER BY timestamp_ms"
    ).map_err(|e| e.to_string())?;

    let segments: Vec<(String, String, String, i64)> = seg_stmt
        .query_map([&meeting_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Load translations
    let translations = crate::db::translation::get_meeting_translations(
        db.connection(), &meeting_id, &target_lang
    ).map_err(|e| e.to_string())?;

    let trans_map: std::collections::HashMap<String, String> = translations
        .into_iter()
        .map(|t| (t.segment_id, t.translated_text))
        .collect();

    let mut output = String::new();

    match format.as_str() {
        "translated_txt" => {
            for (seg_id, _orig, speaker, _ts) in &segments {
                let translated = trans_map.get(seg_id).cloned().unwrap_or_else(|| "[not translated]".into());
                output.push_str(&format!("{}: {}\n", speaker, translated));
            }
        }
        "bilingual_txt" => {
            for (seg_id, orig, speaker, _ts) in &segments {
                let translated = trans_map.get(seg_id).cloned().unwrap_or_else(|| "[not translated]".into());
                output.push_str(&format!("{}: {}\n", speaker, orig));
                output.push_str(&format!("  → {}\n\n", translated));
            }
        }
        "bilingual_md" => {
            output.push_str("# Translated Transcript\n\n");
            for (seg_id, orig, speaker, ts) in &segments {
                let minutes = ts / 60000;
                let seconds = (ts % 60000) / 1000;
                let translated = trans_map.get(seg_id).cloned().unwrap_or_else(|| "[not translated]".into());
                output.push_str(&format!("**{}** _{:02}:{:02}_\n", speaker, minutes, seconds));
                output.push_str(&format!("> {}\n", orig));
                output.push_str(&format!("> _{}_\n\n", translated));
            }
        }
        _ => return Err(format!("Unknown export format: {}", format)),
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_party_filter() {
        let parties = |list: &[&str]| list.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        assert_eq!(speaker_filter(None), Some(""));
        assert_eq!(speaker_filter(Some(&parties(&["you", "them"]))), Some(""));
        assert_eq!(speaker_filter(Some(&parties(&["you"]))), Some(" AND ts.speaker = 'User'"));
        assert_eq!(speaker_filter(Some(&parties(&["them"]))), Some(" AND ts.speaker <> 'User'"));
        assert_eq!(speaker_filter(Some(&parties(&[]))), None);
        assert_eq!(speaker_filter(Some(&parties(&["nobody"]))), None);
    }

    #[test]
    fn test_sentence_is_not_in_the_target_language() {
        assert_eq!(test_sentence("zh-CN").1, "en");
        assert_eq!(test_sentence("en").1, "es");
        assert_eq!(test_sentence("en-GB").1, "es");
    }

    #[test]
    fn provider_names() {
        assert_eq!(parse_provider("opus-mt"), Ok(TranslationProviderType::OpusMt));
        assert_eq!(parse_provider("llm"), Ok(TranslationProviderType::Llm));
        assert!(parse_provider("soniox").is_err());
    }
}
