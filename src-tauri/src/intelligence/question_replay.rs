//! A discrete-event simulation. Model latency advances the clock while ASR
//! continues to deliver updates to the same single-flight core as the app.
use super::question_core::{
    parse_response, DetectionMode, Failure, ModelInput, QuestionCore, QuestionEvent, RemoveReason,
    Request, Update,
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
}

#[derive(Default, Serialize)]
pub struct Metrics {
    pub must_detected: usize,
    pub must_total: usize,
    pub must_recall: Option<f64>,
    pub must_not_triggered: usize,
    pub must_not_total: usize,
    pub rules_vetoed: usize,
    pub latency_p50_ms: Option<f64>,
    pub latency_p90_ms: Option<f64>,
    pub model_calls: usize,
    #[serde(skip)]
    latencies: Vec<u64>,
}

impl Metrics {
    fn percentile(&self, p: f64) -> Option<f64> {
        let last = self.latencies.len().checked_sub(1)?;
        let rank = last as f64 * p;
        let low = self.latencies[rank.floor() as usize] as f64;
        let high = self.latencies[rank.ceil() as usize] as f64;
        Some(low + rank.fract() * (high - low))
    }
    fn finish(&mut self) {
        self.latencies.sort_unstable();
        self.latency_p50_ms = self.percentile(0.5);
        self.latency_p90_ms = self.percentile(0.9);
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
            total.model_calls += s.model_calls;
            total.latencies.extend_from_slice(&s.latencies);
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
    report: MeetingReport,
}

impl Scorer<'_> {
    fn record(&mut self, now: u64, events: Vec<QuestionEvent>) {
        for event in events {
            let question = match event {
                QuestionEvent::Upsert { question } if question.complete => question,
                QuestionEvent::Remove {
                    reason: RemoveReason::Veto,
                    ..
                } => {
                    self.report.metrics.rules_vetoed += 1;
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
            if !self.hits.insert(i) {
                continue;
            }
            let label = &self.data.labels[i];
            match label.verdict {
                Verdict::Must => {
                    self.report.metrics.must_detected += 1;
                    let uttered = timing.appeared(anchor.end_char);
                    self.report
                        .metrics
                        .latencies
                        .push(now.saturating_sub(uttered));
                }
                Verdict::MustNot => {
                    self.report.metrics.must_not_triggered += 1;
                    self.report.false_triggers.push(Detail {
                        label_id: label.id.clone(),
                        line_id: line.id.clone(),
                        canonical: label.canonical.clone(),
                        detected_text: Some(question.text),
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
            });
        }
    }
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
