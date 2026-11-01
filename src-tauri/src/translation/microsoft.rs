// src-tauri/src/translation/microsoft.rs
use super::*;
use super::lang_map::microsoft_code;
use reqwest::Client;
use serde_json::Value;
use std::time::Instant;

pub const MICROSOFT_DEFAULT_URL: &str = "https://api.cognitive.microsofttranslator.com";

pub struct MicrosoftTranslator {
    api_key: Option<String>,
    region: Option<String>,
    /// Service base without a trailing `/` (the default global endpoint, a
    /// resource endpoint `…/translator/text/v3.0`, or a regional cloud).
    base_url: String,
    client: Client,
}

impl MicrosoftTranslator {
    /// `endpoint` replaces the global endpoint and makes the key optional
    /// (e.g. a gateway that adds it). An empty `region` sends no region header.
    pub fn new(
        api_key: Option<String>,
        region: Option<String>,
        endpoint: Option<&str>,
    ) -> Result<Self, TranslationError> {
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        let base_url = match endpoint {
            Some(endpoint) => service_base(endpoint, &["/translate", "/detect", "/languages"])?,
            None => {
                if api_key.is_none() {
                    return Err(TranslationError::NoApiKey("microsoft".into()));
                }
                MICROSOFT_DEFAULT_URL.to_string()
            }
        };
        Ok(Self {
            api_key,
            region: region.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()),
            base_url,
            client: Client::new(),
        })
    }

    /// `{base}{path}` with `api-version=3.0` (unless the base already has one) and `query`.
    fn url(&self, path: &str, query: &[(&str, &str)]) -> Result<url::Url, TranslationError> {
        let mut url = endpoint_url(&self.base_url, path)?;
        let has_version = url.query_pairs().any(|(k, _)| k == "api-version");
        {
            let mut pairs = url.query_pairs_mut();
            if !has_version {
                pairs.append_pair("api-version", "3.0");
            }
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let request = match &self.api_key {
            Some(key) => request.header("Ocp-Apim-Subscription-Key", key),
            None => request,
        };
        match &self.region {
            Some(region) => request.header("Ocp-Apim-Subscription-Region", region),
            None => request,
        }
    }

    async fn post_texts(&self, url: url::Url, body: &Value, what: &str) -> Result<Value, TranslationError> {
        let resp = self
            .authorize(self.client.post(url.clone()))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| TranslationError::Http(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(TranslationError::Failed(format!(
                "Microsoft {} returned {} ({}): {}",
                what, status, redact_url(url.as_str()), body_text
            )));
        }

        resp.json().await.map_err(|e| TranslationError::Failed(e.to_string()))
    }

    fn translate_url(&self, source: Option<&str>, target: &str) -> Result<url::Url, TranslationError> {
        let to = microsoft_code(target);
        let from = source.map(microsoft_code);
        let mut query = vec![("to", to.as_str())];
        if let Some(from) = from.as_deref() {
            query.push(("from", from));
        }
        self.url("/translate", &query)
    }
}

#[async_trait]
impl TranslationProvider for MicrosoftTranslator {
    fn provider_name(&self) -> &str { "Microsoft Translator" }
    fn provider_type(&self) -> TranslationProviderType { TranslationProviderType::Microsoft }
    fn is_local(&self) -> bool { false }

    async fn translate(
        &self,
        text: &str,
        source: Option<&str>,
        target: &str,
    ) -> Result<String, TranslationError> {
        let url = self.translate_url(source, target)?;
        let json = self.post_texts(url, &serde_json::json!([{ "text": text }]), "API").await?;

        json[0]["translations"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| TranslationError::Failed("Unexpected response format".into()))
    }

    async fn translate_batch(
        &self,
        texts: &[String],
        source: Option<&str>,
        target: &str,
    ) -> Result<Vec<String>, TranslationError> {
        // Microsoft supports up to 100 texts / 10K chars per request
        let url = self.translate_url(source, target)?;
        let body: Vec<Value> = texts.iter()
            .map(|t| serde_json::json!({ "text": t }))
            .collect();
        let json = self.post_texts(url, &Value::Array(body), "batch API").await?;

        json.as_array()
            .ok_or_else(|| TranslationError::Failed("Unexpected batch response format".into()))?
            .iter()
            .map(|item| {
                item["translations"][0]["text"]
                    .as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| TranslationError::Failed("Unexpected batch response format".into()))
            })
            .collect()
    }

    async fn detect_language(&self, text: &str) -> Result<DetectedLanguage, TranslationError> {
        let url = self.url("/detect", &[])?;
        let json = self.post_texts(url, &serde_json::json!([{ "text": text }]), "detect API").await?;

        Ok(DetectedLanguage {
            lang: json[0]["language"].as_str().unwrap_or("unknown").to_string(),
            confidence: json[0]["score"].as_f64().unwrap_or(0.0),
        })
    }

    async fn supported_languages(&self) -> Result<Vec<Language>, TranslationError> {
        let url = self.url("/languages", &[("scope", "translation")])?;
        // Public on Microsoft's side; a gateway may still want the key.
        let resp = self.authorize(self.client.get(url))
            .send()
            .await
            .map_err(|e| TranslationError::Http(e.to_string()))?;

        let json: Value = resp.json().await
            .map_err(|e| TranslationError::Failed(e.to_string()))?;

        let translation_map = json["translation"].as_object()
            .ok_or_else(|| TranslationError::Failed("No translation languages".into()))?;

        Ok(translation_map.iter().map(|(code, info)| {
            Language {
                code: code.clone(),
                name: info["name"].as_str().unwrap_or(code).to_string(),
                native_name: info["nativeName"].as_str().map(|s| s.to_string()),
            }
        }).collect())
    }

    async fn test_connection(&self) -> Result<ConnectionStatus, TranslationError> {
        let start = Instant::now();

        // Translate a short test string to actually validate the API key.
        // The /languages endpoint is public and doesn't require auth.
        match self.translate("hello", None, "es").await {
            Ok(sample) => {
                // Key works — now get the language count
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

    fn translator(endpoint: &str, region: Option<&str>) -> MicrosoftTranslator {
        MicrosoftTranslator::new(Some("key".into()), region.map(String::from), Some(endpoint)).unwrap()
    }

    #[test]
    fn urls_for_each_kind_of_endpoint() {
        let global = MicrosoftTranslator::new(Some("k".into()), None, None).unwrap();
        assert_eq!(
            global.translate_url(None, "zh-CN").unwrap().as_str(),
            "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans"
        );
        let resource = translator("https://my-res.cognitiveservices.azure.com/translator/text/v3.0/", None);
        assert_eq!(
            resource.translate_url(Some("en-US"), "pt-PT").unwrap().as_str(),
            "https://my-res.cognitiveservices.azure.com/translator/text/v3.0/translate?api-version=3.0&to=pt-pt&from=en"
        );
        let china = translator("https://api.translator.azure.cn", None);
        assert_eq!(
            china.url("/detect", &[]).unwrap().as_str(),
            "https://api.translator.azure.cn/detect?api-version=3.0"
        );
        // A pasted full address, and an api-version the user already chose.
        let pasted = translator("https://gw.example.com/ms/translate?api-version=3.0", None);
        assert_eq!(
            pasted.url("/languages", &[("scope", "translation")]).unwrap().as_str(),
            "https://gw.example.com/ms/languages?api-version=3.0&scope=translation"
        );
    }

    #[test]
    fn the_default_endpoint_needs_a_key() {
        assert!(matches!(MicrosoftTranslator::new(None, None, None), Err(TranslationError::NoApiKey(_))));
        assert!(MicrosoftTranslator::new(None, None, Some("http://gateway.lan")).is_ok());
    }

    #[tokio::test]
    async fn translate_sends_key_region_and_mapped_codes() {
        let server = FakeServer::start(vec![Reply::json(200, r#"[{"translations":[{"text":"你好","to":"zh-Hant"}]}]"#)]).await;
        let ms = translator(&server.url(), Some("eastasia"));
        assert_eq!(ms.translate("Hello", Some("en"), "zh-TW").await.unwrap(), "你好");
        let request = server.request(0);
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/translate?api-version=3.0&to=zh-Hant&from=en");
        assert_eq!(request.header("ocp-apim-subscription-key").as_deref(), Some("key"));
        assert_eq!(request.header("ocp-apim-subscription-region").as_deref(), Some("eastasia"));
        assert_eq!(request.body_text(), r#"[{"text":"Hello"}]"#);
    }

    #[tokio::test]
    async fn blank_region_and_missing_key_send_no_headers() {
        let server = FakeServer::start(vec![Reply::json(200, r#"[{"translations":[{"text":"Hola"}]}]"#)]).await;
        let ms = MicrosoftTranslator::new(None, Some("  ".into()), Some(&server.url())).unwrap();
        assert_eq!(ms.translate("Hello", None, "es").await.unwrap(), "Hola");
        let request = server.request(0);
        assert_eq!(request.header("ocp-apim-subscription-key"), None);
        assert_eq!(request.header("ocp-apim-subscription-region"), None);
    }

    #[tokio::test]
    async fn errors_name_the_address() {
        let server = FakeServer::start(vec![Reply::json(401, r#"{"error":{"code":401000,"message":"bad key"}}"#)]).await;
        let ms = translator(&server.url(), None);
        let err = ms.translate("Hello", None, "es").await.unwrap_err().to_string();
        assert!(err.contains("401"), "{err}");
        assert!(err.contains("/translate?api-version=3.0"), "{err}");
        assert!(err.contains("bad key"), "{err}");
    }

    #[tokio::test]
    async fn batch_keeps_the_order() {
        let server = FakeServer::start(vec![Reply::json(
            200,
            r#"[{"translations":[{"text":"Uno"}]},{"translations":[{"text":"Dos"}]}]"#,
        )])
        .await;
        let ms = translator(&server.url(), None);
        let out = ms.translate_batch(&["One".into(), "Two".into()], None, "es").await.unwrap();
        assert_eq!(out, vec!["Uno", "Dos"]);
    }
}
