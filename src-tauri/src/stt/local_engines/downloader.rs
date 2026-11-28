// HTTP download with streaming progress and SHA256 verification.

use std::io::{self, Read};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;

use super::DownloadStatus;

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub engine: String,
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub status: String,
}

pub(super) async fn download_file(
    url: &str,
    dest: &Path,
    sha256_expected: &str,
    cancellation: &mut watch::Receiver<bool>,
    mut report: impl FnMut(DownloadStatus, u64, u64),
) -> Result<(), String> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build download client: {e}"))?;
    let response = tokio::select! {
        biased;
        _ = cancellation.wait_for(|cancelled| *cancelled) => return Err("Download cancelled".into()),
        response = client.get(url).send() => response.map_err(|e| format!("Download request failed: {}", e.without_url()))?,
    };
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut downloaded = 0;
    let mut hasher = (!sha256_expected.is_empty()).then(Sha256::new);
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Failed to create temporary model file: {e}"))?;
    report(DownloadStatus::Downloading, 0, total_size);

    loop {
        let next = tokio::select! {
            biased;
            _ = cancellation.wait_for(|cancelled| *cancelled) => return Err("Download cancelled".into()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e.without_url()))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write model file: {e}"))?;
        if let Some(hasher) = &mut hasher {
            hasher.update(&chunk);
        }
        downloaded += chunk.len() as u64;

        if downloaded % 102_400 < chunk.len() as u64 || downloaded == total_size {
            report(DownloadStatus::Downloading, downloaded, total_size);
        }
    }

    if downloaded == 0 || (total_size > 0 && downloaded != total_size) {
        return Err(format!(
            "Incomplete model download ({downloaded} of {total_size} bytes)"
        ));
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush model file: {e}"))?;

    if let Some(hasher) = hasher {
        report(DownloadStatus::Verifying, downloaded, total_size);
        let hash = hex(&hasher.finalize());
        if hash != sha256_expected {
            return Err(format!(
                "SHA256 mismatch: expected {sha256_expected}, got {hash}"
            ));
        }
    }
    Ok(())
}

/// Check cancellation during reads so a single large tar entry can be interrupted.
struct CancellableReader<'a, R> {
    inner: R,
    cancellation: &'a watch::Receiver<bool>,
}

impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if *self.cancellation.borrow() || self.cancellation.has_changed().is_err() {
            return Err(io::Error::other("Extraction cancelled"));
        }
        self.inner.read(buf)
    }
}

/// Extract the registry's expected directory inside an empty staging directory.
pub fn extract_tar_bz2(
    archive_path: &Path,
    model_dir: &Path,
    cancellation: &watch::Receiver<bool>,
) -> Result<(), String> {
    use bzip2::read::BzDecoder;
    use std::fs::File;

    let root = model_dir.file_name().ok_or("Invalid model directory")?;
    let staging = model_dir.parent().ok_or("Invalid staging directory")?;
    let file = File::open(archive_path).map_err(|e| format!("Failed to open archive: {e}"))?;
    let mut archive = tar::Archive::new(CancellableReader {
        inner: BzDecoder::new(file),
        cancellation,
    });

    for entry in archive
        .entries()
        .map_err(|e| format!("Invalid model archive: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Invalid model archive entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Invalid archive path: {e}"))?;
        if !path.strip_prefix(".").unwrap_or(&path).starts_with(root) {
            return Err(format!(
                "Unexpected item in model archive: {}",
                path.display()
            ));
        }
        let kind = entry.header().entry_type();
        if kind.is_file() || kind.is_dir() {
            if !entry
                .unpack_in(staging)
                .map_err(|e| format!("Failed to extract model: {e}"))?
            {
                return Err("Model archive entry escaped its staging directory".into());
            }
        }
    }

    // Read through the bzip2 trailer to detect a truncated or corrupt archive.
    io::copy(&mut archive.into_inner(), &mut io::sink())
        .map_err(|e| format!("Failed to read model archive: {e}"))?;
    Ok(())
}

/// Lowercase hex of a digest (sha2 0.11's output type has no `{:x}`).
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn sha256_hex_matches_the_standard_test_vector() {
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// A sherpa-onnx style archive (one top-level folder) made with the
    /// reference C bzip2 1.0.8, the tool sherpa-onnx's archives are built with.
    const MODEL_TAR_BZ2: &[u8] = &[
        0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x30, 0xc8, 0xb7, 0xf5, 0x00,
        0x00, 0xab, 0x7d, 0x80, 0xca, 0x90, 0x40, 0x00, 0x40, 0x03, 0xff, 0x80, 0x80, 0x20, 0x66,
        0x4f, 0xde, 0xc0, 0x08, 0x08, 0x20, 0x00, 0x92, 0x09, 0x52, 0x4f, 0xd4, 0xc5, 0x3f, 0x54,
        0xf5, 0x06, 0x04, 0x19, 0x30, 0x18, 0x82, 0x49, 0x20, 0x65, 0x32, 0x68, 0xf4, 0x43, 0x04,
        0xd3, 0x13, 0x11, 0xfb, 0xed, 0x35, 0x45, 0x89, 0x52, 0x02, 0x13, 0xa4, 0x84, 0x5b, 0x1d,
        0x8b, 0x5f, 0x48, 0x40, 0xea, 0xc9, 0xe2, 0x10, 0xc2, 0xb1, 0x9c, 0x6b, 0x8b, 0xbb, 0x18,
        0x9c, 0x9b, 0xea, 0x7a, 0x81, 0x59, 0x83, 0x80, 0x92, 0x03, 0x80, 0x32, 0xf7, 0x20, 0x13,
        0x93, 0x4d, 0x11, 0xa5, 0x2f, 0xf1, 0x15, 0xd0, 0x78, 0xf0, 0x4f, 0xea, 0x88, 0x20, 0xd3,
        0xdb, 0xd7, 0xb0, 0xfe, 0x8c, 0x38, 0x2c, 0x3d, 0x5c, 0x5c, 0x6b, 0xb5, 0x03, 0x49, 0xde,
        0x3b, 0x73, 0x1a, 0x17, 0x52, 0x91, 0x22, 0x53, 0x11, 0x5c, 0x4f, 0xa9, 0x90, 0xaa, 0x2f,
        0x1d, 0xd0, 0x99, 0xa7, 0x90, 0x81, 0x19, 0x4c, 0x94, 0x0a, 0xbe, 0x0c, 0x60, 0x72, 0x2e,
        0xe4, 0x8a, 0x70, 0xa1, 0x20, 0x61, 0x91, 0x6f, 0xea,
    ];

    #[test]
    fn extracts_a_sherpa_style_tar_bz2_into_its_model_folder() {
        let dir = std::env::temp_dir().join(format!("nexq-bz2-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("model.tar.bz2");
        std::fs::write(&archive, MODEL_TAR_BZ2).unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();

        let (cancel, cancellation) = watch::channel(false);
        let model_dir = out.join("sherpa-onnx-test-model");
        extract_tar_bz2(&archive, &model_dir, &cancellation).unwrap();

        assert_eq!(
            std::fs::read_to_string(model_dir.join("tokens.txt")).unwrap(),
            "hello 0
world 1
"
        );
        cancel.send_replace(true);
        let cancelled = dir.join("cancelled");
        assert!(extract_tar_bz2(&archive, &cancelled, &cancellation).is_err());
        assert!(!cancelled.exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn cancellation_wakes_a_download_waiting_for_the_body() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model", server.local_addr().unwrap());
        let hold_body = tokio::spawn(async move {
            let (mut connection, _) = server.accept().await.unwrap();
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n")
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let dir = std::env::temp_dir().join(format!("nexq-model-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (cancel, mut cancellation) = watch::channel(false);

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            download_file(
                &url,
                &dir.join("model"),
                "",
                &mut cancellation,
                |_, _, _| {
                    // Headers arrived and the download is waiting for body bytes.
                    cancel.send_replace(true);
                },
            ),
        )
        .await
        .expect("cancellation should wake the downloader");
        assert_eq!(result.unwrap_err(), "Download cancelled");
        hold_body.abort();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn truncated_archive_cannot_be_installed() {
        let dir = std::env::temp_dir().join(format!("nexq-bz2-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("model.tar.bz2");
        std::fs::write(&archive, &MODEL_TAR_BZ2[..MODEL_TAR_BZ2.len() - 5]).unwrap();
        let (_cancel, cancellation) = watch::channel(false);

        assert!(
            extract_tar_bz2(&archive, &dir.join("sherpa-onnx-test-model"), &cancellation,).is_err()
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
