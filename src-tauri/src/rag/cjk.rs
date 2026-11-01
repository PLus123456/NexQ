//! CJK-aware text helpers: token estimates and the bigram text written to and
//! queried from the FTS5 index.
//!
//! The FTS table uses SQLite's `unicode61` tokenizer, which treats a run of
//! Han characters as one token. So the text is pre-split here: runs of CJK
//! characters become overlapping bigrams ("向量检索" → "向量 量检 检索"),
//! everything else stays as words. Two-character words (the most common in
//! Chinese) then match exactly, longer ones match through their bigrams, and
//! no dictionary is needed.

use std::collections::HashSet;

/// Han, kana and Hangul characters: one estimated token each, bigrams in FTS.
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x309F // Hiragana
        | 0x30A0..=0x30FF // Katakana
        | 0x31F0..=0x31FF // Katakana phonetic extensions
        | 0x3400..=0x4DBF // CJK Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xAC00..=0xD7AF // Hangul syllables
        | 0x1100..=0x11FF // Hangul Jamo
        | 0x3130..=0x318F // Hangul compatibility Jamo
        | 0xF900..=0xFAFF // CJK compatibility ideographs
        | 0xFF66..=0xFF9F // Half-width katakana
        | 0x20000..=0x2FA1F // CJK Extensions B–F, compatibility supplement
    )
}

/// Rough token count: each CJK character counts 1, every other 4 characters
/// count 1 (the old `chars / 4` underestimated Chinese about 4×).
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
}

/// The longest prefix of `text` whose estimate is at most `max_tokens`,
/// cut on a character boundary.
pub fn truncate_to_tokens(text: &str, max_tokens: usize) -> &str {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for (i, c) in text.char_indices() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
        if cjk + other.div_ceil(4) > max_tokens {
            return &text[..i];
        }
    }
    text
}

/// One token of the FTS text.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    /// A run of letters/digits outside CJK, lowercased.
    Word(String),
    /// Two adjacent CJK characters.
    Bigram(String),
    /// A lone CJK character between non-CJK text.
    Single(String),
}

impl Token {
    fn text(&self) -> &str {
        match self {
            Self::Word(s) | Self::Bigram(s) | Self::Single(s) => s,
        }
    }
}

fn tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut run: Vec<char> = Vec::new();

    fn flush_run(run: &mut Vec<char>, out: &mut Vec<Token>) {
        match run.len() {
            0 => {}
            1 => out.push(Token::Single(run[0].to_string())),
            _ => {
                for pair in run.windows(2) {
                    out.push(Token::Bigram(pair.iter().collect()));
                }
            }
        }
        run.clear();
    }

    for c in text.chars() {
        if is_cjk(c) {
            if !word.is_empty() {
                out.push(Token::Word(std::mem::take(&mut word)));
            }
            run.push(c);
        } else if c.is_alphanumeric() {
            flush_run(&mut run, &mut out);
            word.extend(c.to_lowercase());
        } else {
            flush_run(&mut run, &mut out);
            if !word.is_empty() {
                out.push(Token::Word(std::mem::take(&mut word)));
            }
        }
    }
    flush_run(&mut run, &mut out);
    if !word.is_empty() {
        out.push(Token::Word(word));
    }
    out
}

/// The body written to the FTS table for a chunk: space-separated tokens.
pub fn fts_document_text(text: &str) -> String {
    let toks = tokens(text);
    let mut out = String::with_capacity(text.len() * 2);
    for t in &toks {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t.text());
    }
    out
}

/// Frequent words that only cost lookups: bm25 already gives them little weight.
const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "he",
    "her", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "not", "of",
    "on", "or", "our", "she", "so", "than", "that", "the", "their", "them", "then", "there",
    "these", "they", "this", "to", "us", "was", "we", "were", "what", "when", "which", "who",
    "will", "with", "would", "you", "your",
    "我们", "你们", "他们", "她们", "这个", "那个", "一个", "什么", "怎么", "没有", "可以",
    "就是", "因为", "所以", "但是", "如果", "已经", "还是", "自己", "这样", "那么", "然后",
    "现在", "时候", "这些", "那些", "一些", "不是", "也是", "都是", "还有", "而且", "或者",
    "的话", "一下", "觉得", "知道", "是不", "不会", "的是", "了一", "是一", "有一", "我的",
    "你的", "他的",
];

/// An FTS5 `MATCH` expression for a search query: the query's tokens
/// (stop words dropped, duplicates removed, the first `max_terms` kept so the
/// question at the start of a long query wins), quoted and joined with OR.
/// A lone CJK character becomes a prefix term so it still matches the
/// bigrams that start with it. `None` when nothing searchable is left.
pub fn fts_match_query(query: &str, max_terms: usize) -> Option<String> {
    let stop: HashSet<&str> = STOP_WORDS.iter().copied().collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    for tok in tokens(query) {
        if terms.len() >= max_terms {
            break;
        }
        let text = tok.text();
        if stop.contains(text) || !seen.insert(text.to_string()) {
            continue;
        }
        let quoted = format!("\"{}\"", text.replace('"', "\"\""));
        terms.push(match tok {
            Token::Single(_) => format!("{quoted}*"),
            _ => quoted,
        });
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_cjk_scripts() {
        for c in ['中', '文', 'ひ', 'カ', '한', '𠀀'] {
            assert!(is_cjk(c), "{c}");
        }
        for c in ['a', 'Z', '1', '，', '。', ' ', 'é'] {
            assert!(!is_cjk(c), "{c}");
        }
    }

    #[test]
    fn estimates_chinese_per_character_and_latin_per_four() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("hello"), 2);
        assert_eq!(estimate_tokens("向量检索"), 4);
        // 4 CJK + "abcd" (1) + "，" (counted with the others: 1 more char → 2)
        assert_eq!(estimate_tokens("向量abcd检索，"), 4 + 2);
        let long_zh = "知".repeat(512);
        assert_eq!(estimate_tokens(&long_zh), 512);
    }

    #[test]
    fn truncates_on_char_boundaries_by_estimate() {
        assert_eq!(truncate_to_tokens("向量检索系统", 4), "向量检索");
        assert_eq!(truncate_to_tokens("abcdefgh", 1), "abcd");
        assert_eq!(truncate_to_tokens("abc", 10), "abc");
        assert_eq!(truncate_to_tokens("向量", 0), "");
        let t = truncate_to_tokens("ab向量cd", 2);
        assert_eq!(t, "ab向");
        assert!(estimate_tokens(t) <= 2);
    }

    #[test]
    fn splits_cjk_runs_into_bigrams_and_keeps_words() {
        assert_eq!(fts_document_text("向量检索"), "向量 量检 检索");
        assert_eq!(
            fts_document_text("NexQ支持向量检索。Hello, World!"),
            "nexq 支持 持向 向量 量检 检索 hello world"
        );
        assert_eq!(fts_document_text("GPT4o模型 2024年"), "gpt4o 模型 2024 年");
        assert_eq!(fts_document_text("东京タワー"), "东京 京タ タワ ワー");
        assert_eq!(fts_document_text(""), "");
        assert_eq!(fts_document_text("，。！"), "");
    }

    #[test]
    fn builds_or_queries_with_bigrams_prefix_singles_and_no_stop_words() {
        assert_eq!(
            fts_match_query("向量检索", 48).unwrap(),
            "\"向量\" OR \"量检\" OR \"检索\""
        );
        assert_eq!(
            fts_match_query("What is the 预算 for Q3?", 48).unwrap(),
            "\"预算\" OR \"q3\""
        );
        assert_eq!(fts_match_query("猫 and dogs", 48).unwrap(), "\"猫\"* OR \"dogs\"");
        assert_eq!(fts_match_query("the and of", 48), None);
        assert_eq!(fts_match_query("  ", 48), None);
    }

    #[test]
    fn query_terms_are_deduplicated_and_capped_in_order() {
        let q = fts_match_query("预算 预算 预算 增长", 48).unwrap();
        assert_eq!(q, "\"预算\" OR \"增长\"");
        let long = "甲乙丙丁戊己庚辛壬癸".repeat(20);
        let capped = fts_match_query(&long, 5).unwrap();
        assert_eq!(capped.matches(" OR ").count(), 4);
        assert!(capped.starts_with("\"甲乙\""));
    }

    #[test]
    fn quotes_are_escaped() {
        assert_eq!(fts_match_query("say\"hi", 48).unwrap(), "\"say\" OR \"hi\"");
    }
}
