pub mod downloader;
pub mod model_discovery;
pub mod model_registry;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use model_registry::{get_engines, get_model, get_models_for_engine, ModelDefinition};

type ModelKey = (&'static str, &'static str);
type DownloadJobs = Arc<Mutex<HashMap<ModelKey, ActiveDownload>>>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DownloadStatus {
    Downloading,
    Verifying,
    Extracting,
    Cancelling,
    Complete,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
struct ModelDownloadProgress {
    engine: &'static str,
    model_id: &'static str,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: f32,
    status: DownloadStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl ModelDownloadProgress {
    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("model_download_progress", self);
    }
}

struct ActiveDownload {
    cancel: watch::Sender<bool>,
    progress: ModelDownloadProgress,
    committed: bool,
}

/// A task owns its registration until staging files have been cleaned up.
struct DownloadJob {
    key: ModelKey,
    jobs: DownloadJobs,
    app: AppHandle,
    finished: bool,
}

impl DownloadJob {
    fn report(&self, status: DownloadStatus, downloaded_bytes: u64, total_bytes: u64) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let job = jobs
            .get_mut(&self.key)
            .expect("model download registration");
        if *job.cancel.borrow() {
            return;
        }
        job.progress.status = status;
        job.progress.downloaded_bytes = downloaded_bytes;
        job.progress.total_bytes = total_bytes;
        job.progress.percent = if status == DownloadStatus::Extracting {
            100.0
        } else if total_bytes > 0 {
            (downloaded_bytes as f32 / total_bytes as f32) * 100.0
        } else {
            0.0
        };
        job.progress.emit(&self.app);
    }

    fn commit(&self, staged_model: &Path, target: &Path, backup: &Path) -> Result<(), String> {
        // Publish only while holding the same lock that accepts cancellation.
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let job = jobs
            .get_mut(&self.key)
            .expect("model download registration");
        if *job.cancel.borrow() {
            return Err("Download cancelled".into());
        }

        replace_model(staged_model, target, backup)?;
        job.committed = true;
        Ok(())
    }

    fn finish(mut self, result: Result<(), String>) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let mut job = jobs.remove(&self.key).expect("model download registration");
        if *job.cancel.borrow() {
            job.progress.status = DownloadStatus::Cancelled;
        } else {
            match result {
                Ok(()) => {
                    job.progress.status = DownloadStatus::Complete;
                    job.progress.percent = 100.0;
                }
                Err(e) => {
                    log::error!("Model download failed ({}:{}): {e}", self.key.0, self.key.1);
                    job.progress.status = DownloadStatus::Error;
                    job.progress.detail = Some(e);
                }
            }
        }
        job.progress.emit(&self.app);
        self.finished = true;
    }
}

impl Drop for DownloadJob {
    fn drop(&mut self) {
        if !self.finished {
            let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut job) = jobs.remove(&self.key) {
                job.progress.status = DownloadStatus::Error;
                job.progress.detail = Some("The model download stopped unexpectedly".into());
                job.progress.emit(&self.app);
            }
        }
    }
}

/// Downloads and extracted files go in a unique directory on the target
/// filesystem, so publishing a fully installed model only takes a rename.
struct StagingDir(PathBuf);

impl StagingDir {
    fn create(engine_dir: &Path) -> Result<Self, String> {
        let dir = engine_dir.join(format!(".download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir)
            .map_err(|e| format!("Failed to create model staging directory: {e}"))?;
        Ok(Self(dir))
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.0) {
            log::warn!(
                "Could not clean up model staging directory {}: {e}",
                self.0.display()
            );
        }
    }
}

/// Only called with a verified staged copy. Keep any previous entry in place
/// if publishing fails.
fn replace_model(staged_model: &Path, target: &Path, backup: &Path) -> Result<(), String> {
    let had_previous = match std::fs::symlink_metadata(target) {
        Ok(_) => {
            std::fs::rename(target, backup)
                .map_err(|e| format!("Failed to move previous model aside: {e}"))?;
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("Failed to check model path: {e}")),
    };
    if let Err(e) = std::fs::rename(staged_model, target) {
        if had_previous {
            if let Err(restore) = std::fs::rename(backup, target) {
                return Err(format!(
                    "Failed to install model: {e}. Failed to restore previous files: {restore}"
                ));
            }
        }
        return Err(format!("Failed to install model: {e}"));
    }
    Ok(())
}

fn nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

fn model_is_ready(def: &ModelDefinition, path: &Path) -> bool {
    if !def.is_archive {
        return nonempty_file(path);
    }
    match (def.engine, def.model_id) {
        ("sherpa_onnx", "sense-voice-small") | ("parakeet_tdt", "parakeet-tdt-ctc-110m-int8") => {
            model_discovery::discover_offline_model_files(path).is_ok_and(|files| {
                [&files.model, &files.tokens]
                    .into_iter()
                    .all(|path| nonempty_file(path))
            })
        }
        _ => model_discovery::discover_model_files(path).is_ok_and(|files| {
            [&files.encoder, &files.decoder, &files.joiner, &files.tokens]
                .into_iter()
                .all(|path| nonempty_file(path))
        }),
    }
}

async fn run_download(
    def: &'static ModelDefinition,
    engine_dir: PathBuf,
    job: &DownloadJob,
    mut cancellation: watch::Receiver<bool>,
) -> Result<(), String> {
    let stage = Arc::new(StagingDir::create(&engine_dir)?);
    let result = async {
        let staged_model = stage.0.join(def.filename);
        let download_path = if def.is_archive {
            stage.0.join("model.tar.bz2")
        } else {
            staged_model.clone()
        };

        downloader::download_file(
            def.download_url,
            &download_path,
            def.sha256,
            &mut cancellation,
            |status, bytes, total| job.report(status, bytes, total),
        )
        .await?;

        if def.is_archive {
            job.report(DownloadStatus::Extracting, 0, 0);
            let staging_dir = Arc::clone(&stage);
            let cancellation = cancellation.clone();
            tokio::task::spawn_blocking(move || {
                downloader::extract_tar_bz2(
                    &download_path,
                    &staging_dir.0.join(def.filename),
                    &cancellation,
                )
            })
            .await
            .map_err(|e| format!("Model extraction task failed: {e}"))??;
        }

        if !model_is_ready(def, &staged_model) {
            return Err("Downloaded model is missing required files".into());
        }
        job.commit(
            &staged_model,
            &engine_dir.join(def.filename),
            &stage.0.join("previous"),
        )
    }
    .await;

    // Deletion can be slow on some filesystems. Keep the job registered until
    // the worker has released and removed all its temporary files.
    let _ = tokio::task::spawn_blocking(move || drop(stage)).await;
    result
}

/// Manages local STT models in `{app_data_dir}/models/{engine}/{filename}`.
pub struct ModelManager {
    models_dir: PathBuf,
    active_downloads: DownloadJobs,
}

impl ModelManager {
    pub fn new(models_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&models_dir) {
            log::error!("Failed to create models directory: {e}");
        }
        Self {
            models_dir,
            active_downloads: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    pub fn is_model_downloaded(&self, engine: &str, model_id: &str) -> bool {
        self.get_model_path(engine, model_id).is_some()
    }

    pub fn get_model_path(&self, engine: &str, model_id: &str) -> Option<PathBuf> {
        let def = get_model(engine, model_id)?;
        let path = self.models_dir.join(engine).join(def.filename);
        model_is_ready(def, &path).then_some(path)
    }

    pub fn download_model(
        &self,
        engine: &str,
        model_id: &str,
        app: AppHandle,
    ) -> Result<(), String> {
        let def = get_model(engine, model_id)
            .ok_or_else(|| format!("Unknown model: {engine}:{model_id}"))?;
        let key = (def.engine, def.model_id);
        let engine_dir = self.models_dir.join(def.engine);
        let mut jobs = self
            .active_downloads
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if jobs.contains_key(&key) {
            return Err("Download already in progress".into());
        }
        if model_is_ready(def, &engine_dir.join(def.filename)) {
            return Err("Model is already installed".into());
        }
        std::fs::create_dir_all(&engine_dir)
            .map_err(|e| format!("Failed to create engine directory: {e}"))?;

        let (cancel, cancellation) = watch::channel(false);
        let progress = ModelDownloadProgress {
            engine: def.engine,
            model_id: def.model_id,
            downloaded_bytes: 0,
            total_bytes: 0,
            percent: 0.0,
            status: DownloadStatus::Downloading,
            detail: None,
        };
        progress.emit(&app);
        jobs.insert(
            key,
            ActiveDownload {
                cancel,
                progress,
                committed: false,
            },
        );
        let job = DownloadJob {
            key,
            jobs: Arc::clone(&self.active_downloads),
            app,
            finished: false,
        };
        tokio::spawn(async move {
            let result = run_download(def, engine_dir, &job, cancellation).await;
            job.finish(result);
        });
        Ok(())
    }

    pub fn cancel_download(&self, engine: &str, model_id: &str, app: &AppHandle) {
        let Some(def) = get_model(engine, model_id) else {
            return;
        };
        let mut jobs = self
            .active_downloads
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.get_mut(&(def.engine, def.model_id)) {
            if !job.committed && !job.cancel.send_replace(true) {
                job.progress.status = DownloadStatus::Cancelling;
                job.progress.emit(app);
            }
        }
    }

    pub fn delete_model(&self, engine: &str, model_id: &str) -> Result<(), String> {
        let def = get_model(engine, model_id)
            .ok_or_else(|| format!("Unknown model: {engine}:{model_id}"))?;
        let jobs = self
            .active_downloads
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if jobs.contains_key(&(def.engine, def.model_id)) {
            return Err("Download already in progress".into());
        }

        let path = self.models_dir.join(engine).join(def.filename);
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed to delete model directory: {e}"))?;
        } else if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| format!("Failed to delete model file: {e}"))?;
        }
        log::info!("Deleted model: {engine}:{model_id} from {}", path.display());
        Ok(())
    }

    pub fn list_engines_with_status(&self) -> Vec<EngineWithStatus> {
        let jobs = self
            .active_downloads
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        get_engines()
            .into_iter()
            .map(|eng| {
                let models = get_models_for_engine(eng.engine)
                    .iter()
                    .map(|m| ModelWithStatus {
                        definition: m.clone(),
                        is_downloaded: self.is_model_downloaded(m.engine, m.model_id),
                        download_progress: jobs
                            .get(&(m.engine, m.model_id))
                            .map(|job| job.progress.clone()),
                    })
                    .collect();
                EngineWithStatus {
                    engine: eng.engine.to_string(),
                    name: eng.name.to_string(),
                    description: eng.description.to_string(),
                    models,
                }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelWithStatus {
    pub definition: ModelDefinition,
    pub is_downloaded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_progress: Option<ModelDownloadProgress>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineWithStatus {
    pub engine: String,
    pub name: String,
    pub description: String,
    pub models: Vec<ModelWithStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_archive_directory_is_not_a_downloaded_model() {
        let dir = std::env::temp_dir().join(format!("nexq-model-test-{}", uuid::Uuid::new_v4()));
        let manager = ModelManager::new(dir.clone());
        let def = get_model("sherpa_onnx", "sense-voice-small").unwrap();
        let model = dir.join(def.engine).join(def.filename);
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("tokens.txt"), "hello 0").unwrap();
        std::fs::File::create(model.join("model.onnx")).unwrap();

        assert!(manager.get_model_path(def.engine, def.model_id).is_none());
        std::fs::write(model.join("model.onnx"), [1]).unwrap();
        assert_eq!(
            manager.get_model_path(def.engine, def.model_id),
            Some(model)
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn staged_install_replaces_a_partial_directory_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("nexq-model-test-{}", uuid::Uuid::new_v4()));
        let model = dir.join("model");
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("partial"), []).unwrap();
        let stage = StagingDir::create(&dir).unwrap();
        let staged_model = stage.0.join("model");
        std::fs::create_dir(&staged_model).unwrap();
        std::fs::write(staged_model.join("complete"), []).unwrap();

        replace_model(&staged_model, &model, &stage.0.join("previous")).unwrap();
        let stage_path = stage.0.clone();
        drop(stage);

        assert!(model.join("complete").is_file());
        assert!(!model.join("partial").exists());
        assert!(!stage_path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
