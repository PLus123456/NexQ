// src-tauri/src/translation/google.rs
use super::*;
use super::lang_map::google_code;
use std::time::Instant;

pub const GOOGLE_DEFAULT_URL: &str = "https://translation.googleapis.com/language/translate/v2";

pub struct GoogleTranslator {
    client: reqwest::Client,
    api_key: Option<String>,
    /// v2 base without a trailing `/`: translate is `POST {base}`, then
    /// `{base}/detect` and `{base}/languages`.
    base_url: String,
}

impl GoogleTranslator {
    /// `endpoint` replaces the official v2 address (e.g. a reverse proxy) and
    /// makes the key optional. The key goes in the `x-goog-api-key` header, so
    /// it never shows up in URLs or error messages.
    pub fn new(api_key: Option<String>, endpoint: Option<&str>) -> Result<Self, TranslationError> {
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        let base_url = match endpoint {
            Some(endpoint) => service_base(endpoint, &["/detect", "/languages"])?,
            None => {
                if api_key.is_none() {
                    return Err(TranslationError::NoApiKey("google".into()));
                }
                GOOGLE_DEFAULT_URL.to_string()
            }
        };
        Ok(Self {
            client: reqwest::Client::new(),
            api_key,
            base_url,
        })
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => request.header("x-goog-api-key", key),
            None => request,
        }
    }

    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        url: &url::Url,
    ) -> Result<T, TranslationError> {
        let resp = self.authorize(request).send().await.map_err(map_reqwest_err)?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "Google API returned {} ({}): {}",
                status, redact_url(url.as_str()), body_text
            )));
        }

        resp.json().await.map_err(map_reqwest_err)
    }
}

// ── Internal response shapes ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TranslateResponse {
    data: TranslateData,
}

#[derive(Deserialize)]
struct TranslateData {
    translations: Vec<TranslationItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationItem {
    translated_text: String,
    #[serde(default)]
    #[allow(dead_code)]
    detected_source_language: Option<String>,
}

#[derive(Deserialize)]
struct DetectResponse {
    data: DetectData,
}

#[derive(Deserialize)]
struct DetectData {
    detections: Vec<Vec<DetectionItem>>,
}

#[derive(Deserialize)]
struct DetectionItem {
    language: String,
    confidence: f64,
}

#[derive(Deserialize)]
struct LanguagesResponse {
    data: LanguagesData,
}

#[derive(Deserialize)]
struct LanguagesData {
    languages: Vec<LanguageItem>,
}

#[derive(Deserialize)]
struct LanguageItem {
    language: String,
    #[serde(default)]
    name: Option<String>,
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn map_reqwest_err(e: reqwest::Error) -> TranslationError {
    TranslationError::Http(e.to_string())
}

// ── Trait implementation ──────────────────────────────────────────────────────

#[async_trait]
impl TranslationProvider for GoogleTranslator {
    fn provider_name(&self) -> &str { "Google Cloud Translation" }
    fn provider_type(&self) -> TranslationProviderType { TranslationProviderType::Google }
    fn is_local(&self) -> bool { false }

    async fn translate(
        &self,
        text: &str,
        source: Option<&str>,
        target: &str,
    ) -> Result<String, TranslationError> {
        let mut body = serde_json::json!({
            "q": text,
            "target": google_code(target),
            "format": "text",
        });
        if let Some(src) = source {
            body["source"] = serde_json::Value::String(google_code(src));
        }

        let url = endpoint_url(&self.base_url, "")?;
        let parsed: TranslateResponse = self.send(self.client.post(url.clone()).json(&body), &url).await?;
        parsed
            .data
            .translations
            .into_iter()
            .next()
            .map(|t| t.translated_text)
            .ok_or_else(|| TranslationError::Failed("Empty translations array".into()))
    }

    async fn translate_batch(
        &self,
        texts: &[String],
        source: Option<&str>,
        target: &str,
    ) -> Result<Vec<String>, TranslationError> {
        if texts.is_empty() {
            return Ok(vec![]);
        }

        let mut body = serde_json::json!({
            "q": texts,
            "target": google_code(target),
            "format": "text",
        });
        if let Some(src) = source {
            body["source"] = serde_json::Value::String(google_code(src));
        }

        let url = endpoint_url(&self.base_url, "")?;
        let parsed: TranslateResponse = self.send(self.client.post(url.clone()).json(&body), &url).await?;
        Ok(parsed
            .data
            .translations
            .into_iter()
            .map(|t| t.translated_text)
            .collect())
    }

    async fn detect_language(&self, text: &str) -> Result<DetectedLanguage, TranslationError> {
        let body = serde_json::json!({ "q": text });

        let url = endpoint_url(&self.base_url, "/detect")?;
        let parsed: DetectResponse = self.send(self.client.post(url.clone()).json(&body), &url).await?;
        let item = parsed
            .data
            .detections
            .into_iter()
            .next()
            .and_then(|inner| inner.into_iter().next())
            .ok_or_else(|| TranslationError::Failed("Empty detections array".into()))?;

        Ok(DetectedLanguage {
            lang: item.language,
            confidence: item.confidence,
        })
    }

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError> {
        let url = endpoint_url(&self.base_url, "/languages")?;
        let request = self.client.get(url.clone()).query(&[("target", "en")]);
        let parsed: LanguagesResponse = self.send(request, &url).await?;
        Ok(parsed
            .data
            .languages
            .into_iter()
            .map(|l| Language {
                code: l.language.clone(),
                name: l.name.unwrap_or_else(|| l.language.clone()),
                native_name: None,
            })
            .collect())
    }

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError> {
        let start = Instant::now();
        // Translate a short test string to validate the API key
        match self.translate("hello", None, "es").await {
            Ok(sample) => {
                let lang_count = self.supported_languages().await
                    .map(|l| l.len())
                    .unwrap_or(0);
                Ok(ConnectionStatus {
                    connected: true,
                    language_count: lang_count,
                    response_ms: start.elapsed().as_millis() as u64,
                    error: None,
                    sample: Some(sample),
                })
            }
            Err(e) => Ok(ConnectionStatus {
                connected: false,
                language_count: 0,
                response_ms: start.elapsed().as_millis() as u64,
                error: Some(e.to_string()),
                sample: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translation::test_http::{FakeServer, Reply};

    #[test]
    fn endpoint_and_key_rules() {
        assert!(matches!(GoogleTranslator::new(None, None), Err(TranslationError::NoApiKey(_))));
        let official = GoogleTranslator::new(Some("k".into()), None).unwrap();
        assert_eq!(official.base_url, GOOGLE_DEFAULT_URL);
        let proxy = GoogleTranslator::new(None, Some("https://proxy.lan/google/v2/")).unwrap();
        assert_eq!(proxy.base_url, "https://proxy.lan/google/v2");
        let pasted = GoogleTranslator::new(None, Some("https://proxy.lan/google/v2/detect")).unwrap();
        assert_eq!(pasted.base_url, "https://proxy.lan/google/v2");
    }

    #[tokio::test]
    async fn translate_posts_to_the_base_with_the_key_in_a_header() {
        let server = FakeServer::start(vec![Reply::json(
            200,
            r#"{"data":{"translations":[{"translatedText":"你好","detectedSourceLanguage":"en"}]}}"#,
        )])
        .await;
        let google = GoogleTranslator::new(Some("gkey".into()), Some(&format!("{}/v2", server.url()))).unwrap();
        assert_eq!(google.translate("Hello", Some("en-US"), "zh-Hant").await.unwrap(), "你好");

        let request = server.request(0);
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v2");
        assert_eq!(request.header("x-goog-api-key").as_deref(), Some("gkey"));
        let body: serde_json::Value = serde_json::from_str(&request.body_text()).unwrap();
        assert_eq!(body["target"], "zh-TW");
        assert_eq!(body["source"], "en");
        assert_eq!(body["q"], "Hello");
    }

    #[tokio::test]
    async fn errors_name_the_address_without_the_key() {
        let server = FakeServer::start(vec![Reply::json(400, r#"{"error":{"message":"API key not valid"}}"#)]).await;
        let google = GoogleTranslator::new(Some("sekrit".into()), Some(&format!("{}/v2", server.url()))).unwrap();
        let err = google.translate("Hello", None, "es").await.unwrap_err().to_string();
        assert!(err.contains("400"), "{err}");
        assert!(err.contains("/v2"), "{err}");
        assert!(!err.contains("sekrit"), "{err}");
    }

    #[tokio::test]
    async fn detect_and_languages_use_their_paths() {
        let server = FakeServer::start(vec![
            Reply::json(200, r#"{"data":{"detections":[[{"language":"fr","confidence":0.9}]]}}"#),
            Reply::json(200, r#"{"data":{"languages":[{"language":"fr","name":"French"}]}}"#),
        ])
        .await;
        let google = GoogleTranslator::new(None, Some(&format!("{}/v2", server.url()))).unwrap();
        assert_eq!(google.detect_language("Bonjour").await.unwrap().lang, "fr");
        assert_eq!(google.supported_languages().await.unwrap().len(), 1);
        assert_eq!(server.request(0).path, "/v2/detect");
        assert_eq!(server.request(1).path, "/v2/languages?target=en");
        assert_eq!(server.request(1).header("x-goog-api-key"), None);
    }
}
