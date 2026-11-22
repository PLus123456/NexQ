//! Run with --model fake for a local smoke test. The real endpoint is supplied
//! by NEXQ_EVAL_BASE_URL, NEXQ_EVAL_API_KEY, NEXQ_EVAL_MODEL and optionally
//! NEXQ_EVAL_EXTRA_BODY. NEXQ_EVAL_DIR selects the input directory.
use nexq_lib::intelligence::question_replay as replay;

use nexq_lib::intelligence::question_core::{
    Failure, ModelInput, MAX_TOKENS, SYSTEM_PROMPT, TIMEOUT_MS,
};
use nexq_lib::llm::provider::{GenerationParams, LLMError};
use nexq_lib::llm::thinking::{self, ThinkingSetting};
use replay::{Fake, Interview, MeetingReport, Metrics, Model, Reply};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    env, fs,
    path::PathBuf,
    time::{Duration, Instant},
};

struct Endpoint {
    url: String,
    model: String,
    key: String,
    extra: Map<String, Value>,
    client: reqwest::Client,
}

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("Set {name} for the evaluation"))
}

impl Endpoint {
    fn from_env() -> Result<Self, String> {
        let base = required("NEXQ_EVAL_BASE_URL")?;
        let base = base.trim_end_matches('/');
        let url = if base.ends_with("/chat/completions") {
            base.to_owned()
        } else {
            format!("{base}/chat/completions")
        };
        let extra = env::var("NEXQ_EVAL_EXTRA_BODY")
            .ok()
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|e| format!("NEXQ_EVAL_EXTRA_BODY must be a JSON object: {e}"))?
            .unwrap_or_default();
        Ok(Self {
            url,
            model: required("NEXQ_EVAL_MODEL")?,
            key: required("NEXQ_EVAL_API_KEY")?,
            extra,
            client: reqwest::Client::new(),
        })
    }
}

#[async_trait::async_trait]
impl Model for Endpoint {
    async fn classify(&self, input: &ModelInput) -> Result<Reply, String> {
        let body = json!({ "model":self.model, "temperature":0, "max_tokens":MAX_TOKENS,
            "response_format":{"type":"json_object"}, "stream":false, "messages":[
                {"role":"system","content":SYSTEM_PROMPT},
                {"role":"user","content":serde_json::to_string(input).unwrap()}] });
        let start = Instant::now();
        let call = async {
            let off = ThinkingSetting::Off;
            let send_thinking = thinking::should_send("custom", &self.url, &self.model, off);
            let sent = thinking::send_with_fallback(
                "custom",
                &self.url,
                &self.model,
                send_thinking,
                &GenerationParams::default(),
                |with_thinking| {
                    let mut body = body.clone();
                    if with_thinking {
                        thinking::apply_openai_compat(&mut body, "custom", &self.model, off);
                    }
                    thinking::merge_extra_request(&mut body, &self.extra, false);
                    let request = self
                        .client
                        .post(&self.url)
                        .bearer_auth(&self.key)
                        .json(&body);
                    async move {
                        request
                            .send()
                            .await
                            .map_err(|e| LLMError::ConnectionFailed(e.to_string()))
                    }
                },
            )
            .await
            .map_err(|e| format!("Model request failed: {e}"))?;
            let response = match sent {
                thinking::Sent::Ok(response) => response,
                thinking::Sent::Failed { status, .. } => {
                    return Err(format!("Model endpoint returned HTTP {status}"))
                }
            };
            let value = response.json::<Value>().await.ok();
            Ok(value
                .as_ref()
                .and_then(|v| v["choices"][0]["message"]["content"].as_str())
                .map(str::to_owned)
                .ok_or(Failure::Invalid))
        };
        let raw = match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), call).await {
            Ok(result) => result?,
            Err(_) => Err(Failure::Timeout),
        };
        Ok(Reply {
            raw,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

#[derive(Serialize)]
struct Report {
    meetings: Vec<MeetingReport>,
    total: Metrics,
}

fn print_metrics(name: &str, m: &Metrics) {
    let ms = |v: Option<f64>| v.map_or_else(|| "-".into(), |n| format!("{n:.0}"));
    let recall = m
        .must_recall
        .map_or_else(|| "-".into(), |r| format!("{:.1}%", r * 100.0));
    let per_minute = if m.minutes > 0.0 { m.model_calls as f64 / m.minutes } else { 0.0 };
    println!(
        "{name}\t{}/{} ({recall})\t{}/{}\t{} (rules {}, model {})\t{}\t{}\t{}/{}\t{}/{}\t{} ({per_minute:.1}/min)",
        m.must_detected,
        m.must_total,
        m.must_detected_by_model,
        m.must_total,
        m.must_not_triggered,
        m.must_not_by_rules,
        m.must_not_by_model,
        m.must_not_standing,
        m.rules_vetoed,
        ms(m.latency_p50_ms),
        ms(m.latency_p90_ms),
        ms(m.model_latency_p50_ms),
        ms(m.model_latency_p90_ms),
        m.model_calls
    );
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let mut fake = false;
    let mut output = env::temp_dir().join(format!("qd-replay-{}.json", uuid::Uuid::new_v4()));
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => fake = args.next().ok_or("--model needs a value")? == "fake",
            "--out" => output = PathBuf::from(args.next().ok_or("--out needs a path")?),
            "-h" | "--help" => {
                println!("qd_replay [--model fake|remote] [--out report.json]\nInputs: NEXQ_EVAL_DIR. Remote: NEXQ_EVAL_BASE_URL, NEXQ_EVAL_API_KEY, NEXQ_EVAL_MODEL, NEXQ_EVAL_EXTRA_BODY (optional).");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument {arg}")),
        }
    }
    let model: Box<dyn Model> = if fake {
        Box::new(Fake)
    } else {
        Box::new(Endpoint::from_env()?)
    };
    let dir = match env::var_os("NEXQ_EVAL_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => env::home_dir()
            .ok_or("Set NEXQ_EVAL_DIR")?
            .join(".nexq/eval/interviews"),
    };
    let mut paths = Vec::new();
    for file in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let path = file.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") && path.is_file() {
            paths.push(path);
        }
    }
    paths.sort();
    if paths.is_empty() {
        return Err(format!("No evaluation JSON files in {}", dir.display()));
    }
    println!("Meeting\tmust recall\tby model\tmust_not triggered\tstanding\tvetoed\tp50/p90 ms\tmodel p50/p90 ms\tcalls");
    let mut meetings = Vec::new();
    for path in paths {
        let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let data: Interview =
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        let meeting = replay::replay(data, model.as_ref()).await?;
        print_metrics(&meeting.name, &meeting.metrics);
        for (kind, rows) in [
            ("miss", &meeting.missed),
            ("false_trigger", &meeting.false_triggers),
        ] {
            for d in rows {
                let how = match (d.origin, d.withdrawn) {
                    (Some(origin), true) => format!(" [{origin}, withdrawn]"),
                    (Some(origin), false) => format!(" [{origin}]"),
                    (None, _) => String::new(),
                };
                println!(
                    "  {kind} {} {}{how}  detected={}  expected={}",
                    d.label_id,
                    d.line_id,
                    d.detected_text.as_deref().unwrap_or("—"),
                    d.canonical
                );
            }
        }
        meetings.push(meeting);
    }
    let total = Metrics::aggregate(&meetings);
    print_metrics("Total", &total);
    let bytes =
        serde_json::to_vec_pretty(&Report { meetings, total }).map_err(|e| e.to_string())?;
    fs::write(&output, bytes).map_err(|e| format!("{}: {e}", output.display()))?;
    println!("Report: {}", output.display());
    Ok(())
}
