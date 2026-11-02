// Sub-PRD 6: Question detection
// Layer 1: Regex (sentences ending ?, interrogative words)
// Layer 2: Interview-specific contextual patterns

use serde::{Deserialize, Serialize};

/// A detected question from the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedQuestion {
    pub text: String,
    pub confidence: f64,
    pub timestamp_ms: u64,
    pub source: String,
}

/// Detects questions in transcript text using two layers:
/// - Layer 1: Regex patterns (question marks, interrogative words)
/// - Layer 2: Interview-specific contextual patterns
pub struct QuestionDetector;

/// Interrogative words that commonly start questions.
const INTERROGATIVE_STARTERS: &[&str] = &[
    "what", "why", "how", "when", "where", "who", "which",
    "can", "could", "would", "should",
    "do", "does", "is", "are", "will", "have", "has",
    "tell",
];

// Speech recognition does not always add punctuation. Cover common Chinese
// question forms in both simplified and traditional script as well.
const CHINESE_QUESTION_PATTERNS: &[&str] = &[
    "什么", "什麼", "为何", "為何", "为什么", "為什麼", "怎么", "怎麼", "怎样", "怎樣",
    "如何", "何时", "何時", "哪里", "哪裡", "哪儿", "哪兒", "哪个", "哪個", "哪些",
    "谁", "誰", "多少", "几时", "幾時", "几点", "幾點", "多久",
    "能不能", "可不可以", "会不会", "會不會", "是不是", "有没有", "有沒有",
    "要不要", "是否", "能否",
];

const CHINESE_INTERVIEW_PATTERNS: &[&str] = &[
    "请介绍", "請介紹", "请描述", "請描述", "请解释", "請解釋", "请举例", "請舉例",
    "介绍一下", "介紹一下", "描述一下", "解释一下", "解釋一下", "说说", "說說",
    "谈谈", "談談", "举个例子", "舉個例子",
];

/// Interview-specific patterns that indicate a question or prompt.
const INTERVIEW_PATTERNS: &[&str] = &[
    "walk me through",
    "describe a time",
    "tell me about",
    "what would you do",
    "how do you handle",
    "give me an example",
    "explain how",
    "what's your experience with",
    "what is your experience with",
    "can you walk me through",
    "can you describe",
    "can you explain",
    "can you tell me",
    "talk about a time",
    "share an example",
    "how would you",
    "how have you",
    "what approach would you",
    "what's your approach to",
    "what is your approach to",
];

impl QuestionDetector {
    pub fn new() -> Self {
        Self
    }

    /// Detect questions in the given text.
    /// Returns a list of detected questions with confidence scores.
    pub fn detect_questions(&self, text: &str, timestamp_ms: u64, source: &str) -> Vec<DetectedQuestion> {
        let mut questions: Vec<DetectedQuestion> = Vec::new();

        // Split text into sentences
        let sentences = split_sentences(text);

        for sentence in &sentences {
            let trimmed = sentence.trim();
            // Short questions ("谁？", "Why?") are valid. Use character
            // content instead of a UTF-8 byte-length threshold.
            if !trimmed.chars().any(char::is_alphanumeric) {
                continue;
            }

            let mut confidence: f64 = 0.0;

            // Layer 1: Check for question mark
            if trimmed.ends_with(['?', '？']) {
                confidence = 0.95;
            }

            let body = trimmed.trim_end_matches(['.', '!', '。', '！', '…']);
            if body.ends_with(['吗', '嗎', '呢'])
                || CHINESE_QUESTION_PATTERNS.iter().any(|pattern| body.contains(pattern))
            {
                confidence = confidence.max(0.6);
            }

            // Layer 1: Check for interrogative word starters
            if confidence < 0.5 {
                let lower = trimmed.to_lowercase();
                let first_word = lower.split_whitespace().next().unwrap_or("");
                if INTERROGATIVE_STARTERS.contains(&first_word) {
                    // Interrogative word at start without question mark
                    confidence = confidence.max(0.6);
                }
            }

            // Layer 2: Check for interview-specific patterns
            let lower = trimmed.to_lowercase();
            for pattern in INTERVIEW_PATTERNS {
                if lower.contains(pattern) {
                    // Interview patterns are strong signals
                    confidence = confidence.max(0.85);
                    break;
                }
            }
            if CHINESE_INTERVIEW_PATTERNS.iter().any(|pattern| body.contains(pattern)) {
                confidence = confidence.max(0.85);
            }

            // Only include if confidence is above threshold
            if confidence >= 0.5 {
                questions.push(DetectedQuestion {
                    text: trimmed.to_string(),
                    confidence,
                    timestamp_ms,
                    source: source.to_string(),
                });
            }
        }

        questions
    }
}

/// Split text into sentences using common sentence terminators.
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '?' | '!' | '。' | '？' | '！' | '\n') {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
            current.clear();
        }
    }

    // Don't forget the last sentence fragment (may not end with punctuation)
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        sentences.push(trimmed);
    }

    sentences
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_chinese_sentences_and_detects_short_questions() {
        let questions = QuestionDetector::new().detect_questions(
            "今天先讨论进度。谁？计划能按时完成吗？明天继续。", 42, "Them",
        );
        assert_eq!(questions.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            ["谁？", "计划能按时完成吗？"]);
        assert!(questions.iter().all(|q| q.confidence == 0.95 && q.timestamp_ms == 42 && q.source == "Them"));
    }

    #[test]
    fn detects_unpunctuated_chinese_questions_and_interview_prompts() {
        for text in ["你怎么看这个方案", "这个方案能不能完成", "你准备好了吗", "你的计划呢", "您為什麼選擇這份工作"] {
            let questions = QuestionDetector::new().detect_questions(text, 0, "Them");
            assert_eq!(questions.len(), 1, "{text}");
            assert!(questions[0].confidence >= 0.6);
        }
        let questions = QuestionDetector::new().detect_questions("请介绍一下你的项目经验", 0, "Them");
        assert_eq!(questions[0].confidence, 0.85);
    }

    #[test]
    fn preserves_english_and_ignores_statements_and_punctuation() {
        let detector = QuestionDetector::new();
        for text in ["Why?", "How can we ship", "Tell me about your last project"] {
            assert_eq!(detector.detect_questions(text, 0, "Them").len(), 1, "{text}");
        }
        assert!(detector.detect_questions("会议结束了。谢谢大家！\n！？", 0, "Them").is_empty());
        assert_eq!(detector.detect_questions("你好。Can we start?\n你准备好了吗", 0, "Them").len(), 2);
    }
}
