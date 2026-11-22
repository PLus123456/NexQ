//! A discrete-event simulation. Model latency advances the clock while ASR
//! continues to deliver updates to the same single-flight core as the app.
use super::question_core::{
    DetectionMode, Failure, ModelInput, Origin, QuestionCore, QuestionEvent, RemoveReason, Request, Update, parse_response,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
pub struct Interview {
    pub name: String,
    lines: Vec<Line>,
    labels: Vec<Label>,
}

#[derive(Deserialize)]
struct Line {
    id: String,
    speaker: String,
    start_ms: u64,
    text: String,
}

#[derive(Deserialize)]
struct Anchor {
    line_id: String,
    end_char: usize,
}

#[derive(Deserialize, Copy, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Must,
    Optional,
    MustNot,
}

#[derive(Deserialize)]
struct Label {
    id: String,
    verdict: Verdict,
    #[serde(default)]
    canonical: String,
    #[serde(flatten)]
    anchor: Anchor,
    #[serde(default)]
    also: Vec<Anchor>,
}

#[derive(Copy, Clone)]
struct Tick {
    ms: u64,
    line: usize,
    bytes: usize,
    is_final: bool,
}

#[derive(Copy, Clone)]
struct Timing {
    start: u64,
    duration: u64,
    chars: usize,
}

impl Timing {
    fn appeared(&self, end_char: usize) -> u64 {
        let spoken =
            (self.duration * end_char.min(self.chars) as u64).div_ceil(self.chars.max(1) as u64);
        self.start + (spoken.div_ceil(300) * 300).min(self.duration)
    }
}

fn timeline(lines: &[Line]) -> (Vec<Tick>, HashMap<&str, Timing>) {
    let mut ticks = Vec::new();
    let mut times = HashMap::new();
    for (index, line) in lines.iter().enumerate() {
        let mut boundaries: Vec<_> = line.text.char_indices().map(|(i, _)| i).collect();
        let chars = boundaries.len();
        boundaries.push(line.text.len());
        let natural = (chars as u64 * 1000).div_ceil(15);
        let duration = lines.get(index + 1).map_or(natural, |next| {
            natural.min(next.start_ms.saturating_sub(line.start_ms))
        });
        times.insert(
            line.id.as_str(),
            Timing {
                start: line.start_ms,
                duration,
                chars,
            },
        );
        for elapsed in (300..duration).step_by(300) {
            let spoken = (elapsed * chars as u64 / duration) as usize;
            ticks.push(Tick {
                ms: line.start_ms + elapsed,
                line: index,
                bytes: boundaries[spoken],
                is_final: false,
            });
        }
        let end = line.start_ms + duration;
        ticks.push(Tick {
            ms: end,
            line: index,
            bytes: line.text.len(),
            is_final: false,
        });
        ticks.push(Tick {
            ms: end + 800,
            line: index,
            bytes: line.text.len(),
            is_final: true,
        });
    }
    ticks.sort_by_key(|t| t.ms);
    (ticks, times)
}

pub struct Reply {
    pub elapsed_ms: u64,
    pub raw: Result<String, Failure>,
}

#[async_trait::async_trait]
pub trait Model {
    async fn classify(&self, input: &ModelInput) -> Result<Reply, String>;
}

pub struct Fake;

#[async_trait::async_trait]
impl Model for Fake {
    async fn classify(&self, input: &ModelInput) -> Result<Reply, String> {
        let questions: Vec<_> = input.new_text.split_inclusive(['.', '?', '!', '。', '？', '！', '\n'])
            .map(str::trim).filter(|s| s.ends_with(['?', '？']))
            .map(|s| serde_json::json!({"text":s, "quote":s, "kind":"direct", "complete":true, "same_as":null}))
            .collect();
        Ok(Reply {
            elapsed_ms: 0,
            raw: Ok(serde_json::json!({ "questions": questions }).to_string()),
        })
    }
}

#[derive(Serialize)]
pub struct Detail {
    pub label_id: String,
    pub line_id: String,
    pub canonical: String,
    pub detected_text: Option<String>,
    /// For a false trigger: "rules" or "model", whoever published it first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<&'static str>,
    /// For a false trigger: the model took it back later (veto or merge).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
}

#[derive(Default, Serialize)]
pub struct Metrics {
    pub must_detected: usize,
    pub must_total: usize,
    pub must_recall: Option<f64>,
    pub must_not_triggered: usize,
    pub must_not_total: usize,
    pub rules_vetoed: usize,
    /// False triggers the rules published at a pause / the model published.
    pub must_not_by_rules: usize,
    pub must_not_by_model: usize,
    /// False triggers still standing at the end (never taken back).
    pub must_not_standing: usize,
    pub latency_p50_ms: Option<f64>,
    pub latency_p90_ms: Option<f64>,
    /// The same, counting only questions the model published.
    pub must_detected_by_model: usize,
    pub model_latency_p50_ms: Option<f64>,
    pub model_latency_p90_ms: Option<f64>,
    pub model_calls: usize,
    /// Length of the replayed meeting, to read the call rate.
    pub minutes: f64,
    #[serde(skip)]
    latencies: Vec<u64>,
    #[serde(skip)]
    model_latencies: Vec<u64>,
}

fn percentile(sorted: &[u64], p: f64) -> Option<f64> {
    let last = sorted.len().checked_sub(1)?;
    let rank = last as f64 * p;
    let low = sorted[rank.floor() as usize] as f64;
    let high = sorted[rank.ceil() as usize] as f64;
    Some(low + rank.fract() * (high - low))
}

impl Metrics {
    fn finish(&mut self) {
        self.latencies.sort_unstable();
        self.model_latencies.sort_unstable();
        self.latency_p50_ms = percentile(&self.latencies, 0.5);
        self.latency_p90_ms = percentile(&self.latencies, 0.9);
        self.model_latency_p50_ms = percentile(&self.model_latencies, 0.5);
        self.model_latency_p90_ms = percentile(&self.model_latencies, 0.9);
        self.must_recall =
            (self.must_total != 0).then(|| self.must_detected as f64 / self.must_total as f64);
    }
    pub fn aggregate(meetings: &[MeetingReport]) -> Self {
        let mut total = Self::default();
        for m in meetings {
            let s = &m.metrics;
            total.must_detected += s.must_detected;
            total.must_total += s.must_total;
            total.must_not_triggered += s.must_not_triggered;
            total.must_not_total += s.must_not_total;
            total.rules_vetoed += s.rules_vetoed;
            total.must_not_by_rules += s.must_not_by_rules;
            total.must_not_by_model += s.must_not_by_model;
            total.must_not_standing += s.must_not_standing;
            total.must_detected_by_model += s.must_detected_by_model;
            total.model_calls += s.model_calls;
            total.minutes += s.minutes;
            total.latencies.extend_from_slice(&s.latencies);
            total.model_latencies.extend_from_slice(&s.model_latencies);
        }
        total.finish();
        total
    }
}

#[derive(Serialize)]
pub struct MeetingReport {
    pub name: String,
    #[serde(flatten)]
    pub metrics: Metrics,
    pub missed: Vec<Detail>,
    pub false_triggers: Vec<Detail>,
}

/// Quote endings and annotations both use Unicode character offsets. A phrase
/// may occur again later in the line, beyond what was spoken by this tick.
fn match_label<'a>(
    labels: &'a [Label],
    line: &Line,
    quote: &str,
    timing: Timing,
    now: u64,
) -> Option<(usize, &'a Anchor)> {
    let end = line
        .text
        .rmatch_indices(quote)
        .map(|(i, s)| line.text[..i + s.len()].chars().count())
        .find(|&end| timing.appeared(end) <= now);
    // Two annotations can be within 60 characters of the same question.
    // Pick its closest ending (including alternate sites) and count it once.
    labels
        .iter()
        .enumerate()
        .flat_map(|(i, l)| {
            std::iter::once(&l.anchor)
                .chain(&l.also)
                .map(move |a| (i, a))
        })
        .filter(|(_, a)| a.line_id == line.id)
        .filter_map(|(i, a)| {
            let distance = end.map_or(0, |n| n.abs_diff(a.end_char));
            (distance <= 60).then_some((distance, i, a))
        })
        .min_by_key(|&(distance, i, _)| (distance, i))
        .map(|(_, i, a)| (i, a))
}

struct Scorer<'a> {
    data: &'a Interview,
    times: HashMap<&'a str, Timing>,
    hits: HashSet<usize>,
    model_hits: HashSet<usize>,
    /// Question id → its false trigger in `report.false_triggers`.
    false_ids: HashMap<String, usize>,
    report: MeetingReport,
}

impl Scorer<'_> {
    fn record(&mut self, now: u64, events: Vec<QuestionEvent>) {
        for event in events {
            let question = match event {
                QuestionEvent::Upsert { question } if question.complete => question,
                QuestionEvent::Remove { id, reason } => {
                    if reason == RemoveReason::Veto {
                        self.report.metrics.rules_vetoed += 1;
                    }
                    if reason != RemoveReason::Reset {
                        if let Some(&i) = self.false_ids.get(&id) {
                            self.report.false_triggers[i].withdrawn = true;
                        }
                    }
                    continue;
                }
                _ => continue,
            };
            let Some(line) = self.data.lines.iter().find(|l| l.id == question.line_id) else {
                continue;
            };
            let timing = self.times[line.id.as_str()];
            let Some((i, anchor)) =
                match_label(&self.data.labels, line, &question.quote, timing, now)
            else {
                continue;
            };
            let label = &self.data.labels[i];
            let by_model = question.origin == Origin::Model;
            let latency = now.saturating_sub(timing.appeared(anchor.end_char));
            if label.verdict == Verdict::Must && by_model && self.model_hits.insert(i) {
                self.report.metrics.must_detected_by_model += 1;
                self.report.metrics.model_latencies.push(latency);
            }
            if label.verdict == Verdict::MustNot {
                // A later revision of a withdrawn false trigger brings it back.
                if let Some(&j) = self.false_ids.get(&question.id) {
                    self.report.false_triggers[j].withdrawn = false;
                }
            }
            if !self.hits.insert(i) {
                continue;
            }
            match label.verdict {
                Verdict::Must => {
                    self.report.metrics.must_detected += 1;
                    self.report.metrics.latencies.push(latency);
                }
                Verdict::MustNot => {
                    self.report.metrics.must_not_triggered += 1;
                    if by_model {
                        self.report.metrics.must_not_by_model += 1;
                    } else {
                        self.report.metrics.must_not_by_rules += 1;
                    }
                    self.false_ids.insert(question.id.clone(), self.report.false_triggers.len());
                    self.report.false_triggers.push(Detail {
                        label_id: label.id.clone(),
                        line_id: line.id.clone(),
                        canonical: label.canonical.clone(),
                        detected_text: Some(question.text),
                        origin: Some(if by_model { "model" } else { "rules" }),
                        withdrawn: false,
                    });
                }
                Verdict::Optional => {}
            }
        }
    }
}

pub async fn replay(mut data: Interview, model: &dyn Model) -> Result<MeetingReport, String> {
    data.lines.sort_by_key(|l| l.start_ms);
    let (ticks, times) = timeline(&data.lines);
    let mut ticks = ticks.into_iter().peekable();
    let mut scorer = Scorer {
        data: &data,
        times,
        hits: HashSet::new(),
        model_hits: HashSet::new(),
        false_ids: HashMap::new(),
        report: MeetingReport {
            name: data.name.clone(),
            metrics: Metrics {
                must_total: data
                    .labels
                    .iter()
                    .filter(|l| l.verdict == Verdict::Must)
                    .count(),
                must_not_total: data
                    .labels
                    .iter()
                    .filter(|l| l.verdict == Verdict::MustNot)
                    .count(),
                ..Default::default()
            },
            missed: Vec::new(),
            false_triggers: Vec::new(),
        },
    };
    let mut now = 0;
    let mut core = QuestionCore::default();
    let mut completion: Option<(u64, Request, Reply)> = None;
    loop {
        let next = [
            ticks.peek().map(|t| t.ms),
            completion.as_ref().map(|c| c.0),
            core.next_start_ms(),
        ]
        .into_iter()
        .flatten()
        .min();
        let Some(next) = next else { break };
        now = now.max(next);
        while let Some(tick) = ticks.next_if(|t| t.ms <= now) {
            let line = &data.lines[tick.line];
            let observation = core.observe(
                Update {
                    line_id: &line.id,
                    source: &line.speaker,
                    timestamp_ms: line.start_ms,
                    text: &line.text[..tick.bytes],
                    is_final: tick.is_final,
                },
                now,
                Some(DetectionMode::Hybrid),
            );
            scorer.record(now, observation.events);
        }
        if completion.as_ref().is_some_and(|c| c.0 <= now) {
            let (_, req, reply) = completion.take().unwrap();
            let result = reply.raw.and_then(|raw| parse_response(&raw));
            scorer.record(now, core.finish(&req, result).events);
        }
        if let Some(req) = core.start_request(now) {
            let reply = model.classify(&req.input).await?;
            scorer.report.metrics.model_calls += 1;
            completion = Some((now + reply.elapsed_ms, req, reply));
        }
    }
    for (i, label) in data.labels.iter().enumerate() {
        if label.verdict == Verdict::Must && !scorer.hits.contains(&i) {
            scorer.report.missed.push(Detail {
                label_id: label.id.clone(),
                line_id: label.anchor.line_id.clone(),
                canonical: label.canonical.clone(),
                detected_text: None,
                origin: None,
                withdrawn: false,
            });
        }
    }
    scorer.report.metrics.must_not_standing =
        scorer.report.false_triggers.iter().filter(|d| !d.withdrawn).count();
    scorer.report.metrics.minutes = now as f64 / 60_000.0;
    scorer.report.metrics.finish();
    Ok(scorer.report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_unicode_offsets_alternates_and_missing_quotes() {
        let text = format!("{}怎么处理？", "很长的前文".repeat(20));
        let line = Line {
            id: "b".into(),
            speaker: "Them".into(),
            start_ms: 0,
            text,
        };
        let end = line.text.chars().count();
        let timing = Timing {
            start: 0,
            duration: 10_000,
            chars: end,
        };
        let labels: Vec<Label> = serde_json::from_value(serde_json::json!([
            {"id":"skip","verdict":"must_not","line_id":"b","end_char":5},
            {"id":"yes","verdict":"must","line_id":"a","end_char":10,"also":[{"line_id":"b","end_char":end}]}
        ])).unwrap();
        assert_eq!(
            match_label(&labels, &line, "怎么处理？", timing, 10_000)
                .unwrap()
                .0,
            1
        );
        assert!(match_label(&labels[..1], &line, "怎么处理？", timing, 10_000).is_none());
        assert_eq!(
            match_label(&labels[..1], &line, "unlocatable", timing, 10_000)
                .unwrap()
                .0,
            0
        );
    }

    #[tokio::test]
    async fn measured_model_latency_advances_the_clock_while_the_speaker_continues() {
        struct DelayedFake;
        #[async_trait::async_trait]
        impl Model for DelayedFake {
            async fn classify(&self, input: &ModelInput) -> Result<Reply, String> {
                let mut reply = Fake.classify(input).await?;
                reply.elapsed_ms = 700;
                Ok(reply)
            }
        }
        let input = serde_json::json!({"name":"delay","lines":[{
            "id":"a","speaker":"Them","start_ms":0,"text":"Have you used Redis? I can explain the project in much more detail later."
        }],"labels":[{"id":"q","verdict":"must","line_id":"a","end_char":20}]});
        let fast = replay(serde_json::from_value(input.clone()).unwrap(), &Fake)
            .await
            .unwrap();
        let slow = replay(serde_json::from_value(input).unwrap(), &DelayedFake)
            .await
            .unwrap();
        assert_eq!(slow.metrics.must_detected, 1);
        assert_eq!(
            slow.metrics.latency_p50_ms.unwrap() - fast.metrics.latency_p50_ms.unwrap(),
            700.0
        );
    }

    #[tokio::test]
    async fn sample_fake_report_and_total_are_consistent() {
        let data = serde_json::from_str(include_str!("testdata/qd_eval_sample.json")).unwrap();
        let report = replay(data, &Fake).await.unwrap();
        assert_eq!(report.name, "synthetic-sample");
        assert_eq!(
            (report.metrics.must_total, report.metrics.must_not_total),
            (7, 4)
        );
        assert!(report.metrics.model_calls > 0 && report.metrics.must_detected > 0);
        assert_eq!(report.metrics.must_detected + report.missed.len(), 7);
        assert_eq!(
            report.metrics.must_not_triggered,
            report.false_triggers.len()
        );
        assert!(report.metrics.latency_p90_ms >= report.metrics.latency_p50_ms);
        let total = Metrics::aggregate(std::slice::from_ref(&report));
        assert_eq!(
            serde_json::to_value(total).unwrap(),
            serde_json::to_value(report.metrics).unwrap()
        );
    }
}
