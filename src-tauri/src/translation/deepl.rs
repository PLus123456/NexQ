// src-tauri/src/translation/deepl.rs
use super::*;
use super::lang_map::{deepl_code, LangRole};
use std::time::Instant;

pub const DEEPL_FREE_URL: &str = "https://api-free.deepl.com/v2";
pub const DEEPL_PRO_URL: &str = "https://api.deepl.com/v2";

pub struct DeepLTranslator {
    api_key: Option<String>,
    /// API prefix (`…/v2`) without a trailing `/`.
    base_url: String,
    client: reqwest::Client,
}

impl DeepLTranslator {
    /// A custom `endpoint` (an API prefix ending in `/v2`, e.g. a DeepLX
    /// server) is used as is and needs no key; otherwise the key picks the
    /// API: free-tier keys end with ":fx", all others use the pro endpoint.
    pub fn new(api_key: Option<String>, endpoint: Option<&str>) -> Result<Self, TranslationError> {
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        let base_url = match endpoint {
            Some(endpoint) => service_base(endpoint, &["/translate", "/languages"])?,
            None => {
                let key = api_key.as_deref().ok_or_else(|| TranslationError::NoApiKey("deepl".into()))?;
                if key.ends_with(":fx") { DEEPL_FREE_URL } else { DEEPL_PRO_URL }.to_string()
            }
        };
        Ok(Self {
            api_key,
            base_url,
            client: reqwest::Client::new(),
        })
    }

    fn post_translate(&self, params: &[(&str, String)]) -> Result<(reqwest::RequestBuilder, String), TranslationError> {
        let url = endpoint_url(&self.base_url, "/translate")?;
        let request = self.authorize(self.client.post(url.clone())).form(params);
        Ok((request, url.to_string()))
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => request.header("Authorization", format!("DeepL-Auth-Key {}", key)),
            None => request,
        }
    }

    /// Convert DeepL UPPERCASE codes back to lowercase for consistency.
    fn from_deepl_lang(code: &str) -> String {
        code.to_lowercase()
    }

    async fn send_translate(&self, params: Vec<(&str, String)>) -> Result<DeepLTranslateResponse, TranslationError> {
        let (request, url) = self.post_translate(&params)?;
        let resp = request
            .send()
            .await
            .map_err(|e| TranslationError::Http(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "DeepL API error {} ({}): {}",
                status, redact_url(&url), body
            )));
        }

        resp.json()
            .await
            .map_err(|e| TranslationError::Http(e.to_string()))
    }
}

// ── Response shapes ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct DeepLTranslation {
    text: String,
    #[serde(default)]
    detected_source_language: String,
}

#[derive(Debug, Deserialize)]
struct DeepLTranslateResponse {
    translations: Vec<DeepLTranslation>,
}

#[derive(Debug, Deserialize)]
struct DeepLLanguage {
    language: String,
    name: String,
}

// ── Trait impl ───────────────────────────────────────────────────────────────

#[async_trait]
impl TranslationProvider for DeepLTranslator {
    fn provider_name(&self) -> &str { "DeepL" }
    fn provider_type(&self) -> TranslationProviderType { TranslationProviderType::Deepl }
    fn is_local(&self) -> bool { false }

    async fn translate(
        &self,
        text: &str,
        source: Option<&str>,
        target: &str,
    ) -> Result<String, TranslationError> {
        let mut params = vec![
            ("text", text.to_string()),
            ("target_lang", deepl_code(target, LangRole::Target)),
        ];
        if let Some(src) = source {
            params.push(("source_lang", deepl_code(src, LangRole::Source)));
        }

        let data = self.send_translate(params).await?;
        data.translations
            .into_iter()
            .next()
            .map(|t| t.text)
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

        // DeepL accepts multiple `text` params in a single form-encoded body.
        let mut params: Vec<(&str, String)> = texts
            .iter()
            .map(|t| ("text", t.clone()))
            .collect();
        params.push(("target_lang", deepl_code(target, LangRole::Target)));
        if let Some(src) = source {
            params.push(("source_lang", deepl_code(src, LangRole::Source)));
        }

        let data = self.send_translate(params).await?;
        Ok(data.translations.into_iter().map(|t| t.text).collect())
    }

    async fn detect_language(&self, text: &str) -> Result<DetectedLanguage, TranslationError> {
        // DeepL has no standalone detect endpoint; use translate with a fixed
        // target and read back detected_source_language.
        let params = vec![
            ("text", text.to_string()),
            ("target_lang", "EN-US".to_string()),
        ];

        let data = self.send_translate(params).await?;
        let detected = data
            .translations
            .into_iter()
            .next()
            .map(|t| Self::from_deepl_lang(&t.detected_source_language))
            .ok_or_else(|| TranslationError::Failed("Empty translations array".into()))?;

        Ok(DetectedLanguage {
            lang: detected,
            confidence: 1.0,
        })
    }

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError> {
        let url = endpoint_url(&self.base_url, "/languages")?;

        let resp = self
            .authorize(self.client.get(url.clone()))
            .send()
            .await
            .map_err(|e| TranslationError::Http(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Http(format!(
                "DeepL API error {} ({}): {}",
                status, redact_url(url.as_str()), body
            )));
        }

        let languages: Vec<DeepLLanguage> = resp
            .json()
            .await
            .map_err(|e| TranslationError::Http(e.to_string()))?;

        Ok(languages
            .into_iter()
            .map(|l| Language {
                code: Self::from_deepl_lang(&l.language),
                name: l.name,
                native_name: None,
            })
            .collect())
    }

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError> {
        let start = Instant::now();
        // Translate a short test string to validate the API key
        match self.translate("hello", None, "es").await {
            Ok(sample) => {
                // Compatible servers (DeepLX…) may not list languages.
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
    fn endpoint_choice() {
        let free = DeepLTranslator::new(Some("abc:fx".into()), None).unwrap();
        assert_eq!(free.base_url, DEEPL_FREE_URL);
        let pro = DeepLTranslator::new(Some("abc".into()), None).unwrap();
        assert_eq!(pro.base_url, DEEPL_PRO_URL);
        let custom = DeepLTranslator::new(Some("abc:fx".into()), Some("http://deeplx.lan:1188/v2/")).unwrap();
        assert_eq!(custom.base_url, "http://deeplx.lan:1188/v2");
        let pasted = DeepLTranslator::new(None, Some("http://deeplx.lan:1188/v2/translate")).unwrap();
        assert_eq!(pasted.base_url, "http://deeplx.lan:1188/v2");
    }

    #[test]
    fn a_key_or_an_endpoint_is_required() {
        assert!(matches!(DeepLTranslator::new(None, None), Err(TranslationError::NoApiKey(_))));
        assert!(matches!(DeepLTranslator::new(Some("  ".into()), None), Err(TranslationError::NoApiKey(_))));
        assert!(matches!(DeepLTranslator::new(None, Some("deeplx.lan/v2")), Err(TranslationError::NotConfigured(_))));
    }

    #[tokio::test]
    async fn translate_sends_mapped_codes_to_the_custom_endpoint() {
        let server = FakeServer::start(vec![Reply::json(
            200,
            r#"{"translations":[{"detected_source_language":"EN","text":"你好"}]}"#,
        )])
        .await;
        let deepl = DeepLTranslator::new(Some("secret".into()), Some(&format!("{}/v2", server.url()))).unwrap();
        let out = deepl.translate("Hello", Some("en-US"), "zh-CN").await.unwrap();
        assert_eq!(out, "你好");

        let request = server.request(0);
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v2/translate");
        assert_eq!(request.header("authorization").as_deref(), Some("DeepL-Auth-Key secret"));
        let form = request.form();
        assert_eq!(form.get("text").map(String::as_str), Some("Hello"));
        assert_eq!(form.get("target_lang").map(String::as_str), Some("ZH-HANS"));
        assert_eq!(form.get("source_lang").map(String::as_str), Some("EN"));
    }

    #[tokio::test]
    async fn keyless_custom_endpoint_sends_no_auth_header() {
        let server = FakeServer::start(vec![Reply::json(200, r#"{"translations":[{"text":"Hallo"}]}"#)]).await;
        let deepl = DeepLTranslator::new(None, Some(&format!("{}/v2", server.url()))).unwrap();
        assert_eq!(deepl.translate("Hello", None, "de").await.unwrap(), "Hallo");
        let request = server.request(0);
        assert_eq!(request.header("authorization"), None);
        assert_eq!(request.form().get("source_lang"), None);
    }

    #[tokio::test]
    async fn http_errors_name_the_address() {
        let server = FakeServer::start(vec![Reply::json(403, r#"{"message":"Wrong key"}"#)]).await;
        let deepl = DeepLTranslator::new(Some("bad".into()), Some(&format!("{}/v2", server.url()))).unwrap();
        let err = deepl.translate("Hello", None, "de").await.unwrap_err().to_string();
        assert!(err.contains("403"), "{err}");
        assert!(err.contains("/v2/translate"), "{err}");
        assert!(err.contains("Wrong key"), "{err}");
    }

    #[tokio::test]
    async fn batch_sends_every_text() {
        let server = FakeServer::start(vec![Reply::json(
            200,
            r#"{"translations":[{"text":"Eins"},{"text":"Zwei"}]}"#,
        )])
        .await;
        let deepl = DeepLTranslator::new(Some("k:fx".into()), Some(&format!("{}/v2", server.url()))).unwrap();
        let out = deepl.translate_batch(&["One".into(), "Two".into()], None, "de").await.unwrap();
        assert_eq!(out, vec!["Eins", "Zwei"]);
        let body = server.request(0).body_text();
        assert_eq!(body.matches("text=").count(), 2, "{body}");
    }
}
