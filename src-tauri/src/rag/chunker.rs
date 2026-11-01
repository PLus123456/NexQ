use super::cjk;

/// Bumped whenever the same text could split differently: documents indexed
/// with another version are re-chunked on the next rebuild.
pub const CHUNKER_VERSION: u32 = 2;

/// A single chunk produced by the text splitter.
#[derive(Debug, Clone)]
pub struct TextChunk {
    /// Zero-based index of this chunk in the sequence.
    pub index: usize,
    /// The chunk text content (overlap with the previous chunk included).
    pub text: String,
    /// Approximate token count for this chunk (CJK-aware, see `cjk::estimate_tokens`).
    pub token_count: usize,
    /// Start character offset in the (normalized) original text.
    pub start_char: usize,
    /// End character offset (exclusive) in the (normalized) original text.
    pub end_char: usize,
}

/// Separator levels, tried in order: paragraphs, lines, sentences, clauses,
/// phrases, words. A piece keeps its separator (a Chinese sentence keeps its
/// "。"). Text that no level can split is cut by length.
const SEPARATORS: &[&[&str]] = &[
    &["\n\n"],
    &["\n"],
    &["。", "！", "？", "…", ". ", "! ", "? "],
    &["；", "：", "; ", ": "],
    &["，", "、", ", "],
    &[" "],
];

/// Chars where an overlap may start (right after one of them).
fn is_boundary_char(c: char) -> bool {
    c.is_whitespace() || "。！？；：，、.!?;:,…".contains(c)
}

/// Line endings unified, control characters dropped, runs of blank lines
/// collapsed. Chunk offsets refer to this text.
pub fn normalize_text(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(unified.len());
    let mut newlines = 0usize;
    for c in unified.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push('\n');
            }
            continue;
        }
        if c.is_control() && c != '\t' {
            continue;
        }
        newlines = 0;
        out.push(if c == '\t' { ' ' } else { c });
    }
    out.trim().to_string()
}

/// Split text into chunks of about `chunk_size` estimated tokens, each
/// starting with about `chunk_overlap` tokens of the previous one.
///
/// The text is normalized first (`normalize_text`); chunks are contiguous
/// slices of it. `strategy` is accepted for compatibility: only the
/// recursive splitter exists.
///
/// Returns an empty Vec for empty input.
pub fn chunk_text(
    text: &str,
    chunk_size: usize,
    chunk_overlap: usize,
    _strategy: &str,
) -> Vec<TextChunk> {
    let text = normalize_text(text);
    if text.is_empty() {
        return Vec::new();
    }
    let chunk_size = chunk_size.max(16);
    let chunk_overlap = if chunk_overlap >= chunk_size {
        chunk_size / 4
    } else {
        chunk_overlap
    };

    let mut pieces = Vec::new();
    split_pieces(&text, 0, text.len(), 0, chunk_size, &mut pieces);

    // Greedy packing of consecutive pieces up to chunk_size.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut current: Option<(usize, usize, Counts)> = None;
    for (start, end) in pieces {
        let counts = Counts::of(&text[start..end]);
        current = match current {
            None => Some((start, end, counts)),
            Some((s, _, acc)) if acc.add(counts).tokens() <= chunk_size => Some((s, end, acc.add(counts))),
            Some((s, e, _)) => {
                spans.push((s, e));
                Some((start, end, counts))
            }
        };
    }
    if let Some((s, e, _)) = current {
        spans.push((s, e));
    }

    let mut chunks = Vec::new();
    let mut prev: Option<(usize, usize)> = None;
    for (start, end) in spans {
        let from = match prev {
            Some((ps, pe)) if chunk_overlap > 0 => overlap_start(&text, ps, pe, chunk_overlap).min(start),
            _ => start,
        };
        prev = Some((start, end));
        let raw = &text[from..end];
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lead = raw.len() - raw.trim_start().len();
        let byte_start = from + lead;
        let byte_end = byte_start + trimmed.len();
        chunks.push(TextChunk {
            index: chunks.len(),
            text: trimmed.to_string(),
            token_count: cjk::estimate_tokens(trimmed),
            start_char: text[..byte_start].chars().count(),
            end_char: text[..byte_end].chars().count(),
        });
    }
    chunks
}

/// Separate counts so the estimate of joined pieces is exact.
#[derive(Debug, Clone, Copy, Default)]
struct Counts {
    cjk: usize,
    other: usize,
}

impl Counts {
    fn of(s: &str) -> Self {
        let mut c = Counts::default();
        for ch in s.chars() {
            if cjk::is_cjk(ch) {
                c.cjk += 1;
            } else {
                c.other += 1;
            }
        }
        c
    }
    fn add(self, o: Counts) -> Self {
        Counts { cjk: self.cjk + o.cjk, other: self.other + o.other }
    }
    fn tokens(self) -> usize {
        self.cjk + self.other.div_ceil(4)
    }
}

/// Byte ranges of `text[start..end]` split into pieces of at most
/// `max_tokens`, trying separator `level` and deeper.
fn split_pieces(
    text: &str,
    start: usize,
    end: usize,
    level: usize,
    max_tokens: usize,
    out: &mut Vec<(usize, usize)>,
) {
    let slice = &text[start..end];
    if cjk::estimate_tokens(slice) <= max_tokens {
        out.push((start, end));
        return;
    }
    let Some(seps) = SEPARATORS.get(level) else {
        hard_split(text, start, end, max_tokens, out);
        return;
    };
    let cuts = split_after(slice, seps);
    if cuts.len() <= 1 {
        split_pieces(text, start, end, level + 1, max_tokens, out);
        return;
    }
    let mut from = start;
    for cut in cuts {
        let to = start + cut;
        split_pieces(text, from, to, level + 1, max_tokens, out);
        from = to;
    }
}

/// End offsets of the parts of `s` split right after each separator (the
/// last offset is `s.len()`).
fn split_after(s: &str, seps: &[&str]) -> Vec<usize> {
    let mut cuts = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if let Some(sep) = seps.iter().find(|sep| s[i..].starts_with(**sep)) {
            i += sep.len();
            if i < s.len() {
                cuts.push(i);
            }
            continue;
        }
        i += s[i..].chars().next().map_or(1, char::len_utf8);
    }
    cuts.push(s.len());
    cuts
}

/// Cut `text[start..end]` into pieces of at most `max_tokens`, preferring a
/// whitespace in the last fifth of each piece.
fn hard_split(text: &str, start: usize, end: usize, max_tokens: usize, out: &mut Vec<(usize, usize)>) {
    let mut from = start;
    while from < end {
        let rest = &text[from..end];
        let fit = cjk::truncate_to_tokens(rest, max_tokens);
        let mut len = fit.len();
        if len == 0 {
            // Always make progress, even if one character exceeds the budget.
            len = rest.chars().next().map_or(rest.len(), char::len_utf8);
        } else if len < rest.len() {
            let mut min = len * 4 / 5;
            while !fit.is_char_boundary(min) {
                min += 1;
            }
            if let Some(ws) = fit[min..].rfind(char::is_whitespace) {
                let cut = min + ws + fit[min + ws..].chars().next().map_or(1, char::len_utf8);
                if cut > 0 {
                    len = cut;
                }
            }
        }
        out.push((from, from + len));
        from += len;
    }
}

/// Where the overlap taken from the previous chunk `text[ps..pe]` starts:
/// about `overlap` tokens before `pe`, moved forward to just after a
/// sentence or word boundary when one is in the first half of that tail.
fn overlap_start(text: &str, ps: usize, pe: usize, overlap: usize) -> usize {
    let prev = &text[ps..pe];
    let mut counts = Counts::default();
    let mut start = pe;
    for (i, c) in prev.char_indices().rev() {
        let next = counts.add(if cjk::is_cjk(c) { Counts { cjk: 1, other: 0 } } else { Counts { cjk: 0, other: 1 } });
        if next.tokens() > overlap {
            break;
        }
        counts = next;
        start = ps + i;
    }
    if start >= pe {
        return pe;
    }
    let tail = &text[start..pe];
    let half = tail.len() / 2;
    let mut chars = tail.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if i > half {
            break;
        }
        if is_boundary_char(c) {
            if let Some(&(j, _)) = chars.peek() {
                return start + j;
            }
        }
    }
    start
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_input() {
        let chunks = chunk_text("", 100, 10, "recursive");
        assert!(chunks.is_empty());
        assert!(chunk_text(" \n\n \r\n", 100, 10, "recursive").is_empty());
    }

    #[test]
    fn test_small_text_single_chunk() {
        let chunks = chunk_text("Hello world", 100, 10, "recursive");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].index, 0);
        assert_eq!(chunks[0].text, "Hello world");
        assert_eq!(chunks[0].start_char, 0);
        assert_eq!(chunks[0].end_char, 11);
    }

    #[test]
    fn test_paragraph_splitting() {
        let text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
        let chunks = chunk_text(text, 8, 0, "recursive");
        assert!(chunks.len() >= 2);
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.index, i);
            assert!(!chunk.text.is_empty());
        }
    }

    #[test]
    fn test_chunk_indices_sequential() {
        let text = "A.\n\nB.\n\nC.\n\nD.\n\nE.";
        let chunks = chunk_text(text, 2, 0, "recursive");
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.index, i);
        }
    }

    #[test]
    fn chinese_splits_on_full_width_punctuation_within_budget() {
        let sentence = "个人知识库需要在文档很多时也能快速检索。";
        let text = sentence.repeat(30); // 19 CJK + "。" each = 20 tokens per sentence
        let chunks = chunk_text(&text, 64, 0, "recursive");
        assert!(chunks.len() >= 9, "got {}", chunks.len());
        for c in &chunks {
            assert!(c.token_count <= 64, "chunk of {} tokens", c.token_count);
            assert!(c.text.ends_with('。'), "{:?} should end at a sentence", c.text);
        }
        // Nothing lost: concatenating chunks without overlap gives the text back.
        let joined: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(joined, text);
    }

    #[test]
    fn unpunctuated_cjk_is_hard_split_by_tokens() {
        let text = "检".repeat(1000);
        let chunks = chunk_text(&text, 128, 0, "recursive");
        assert_eq!(chunks.len(), 8);
        assert!(chunks.iter().all(|c| c.token_count <= 128));
        assert_eq!(chunks.iter().map(|c| c.text.chars().count()).sum::<usize>(), 1000);
    }

    #[test]
    fn overlap_repeats_the_tail_of_the_previous_chunk() {
        let text = (0..40).map(|i| format!("第{i}句话说明一个事实。")).collect::<String>();
        let chunks = chunk_text(&text, 40, 10, "recursive");
        assert!(chunks.len() > 2);
        for pair in chunks.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            assert!(b.start_char < a.end_char, "chunks should overlap");
            let shared: String = text.chars().skip(b.start_char).take(a.end_char - b.start_char).collect();
            assert!(a.text.ends_with(&shared) && b.text.starts_with(&shared));
            assert!(cjk::estimate_tokens(&shared) <= 10);
        }
    }

    #[test]
    fn offsets_are_character_offsets_into_normalized_text() {
        let text = "中文。\r\nEnglish words here.\r\n\r\n\r\n\r\n结尾";
        let norm = normalize_text(text);
        assert_eq!(norm, "中文。\nEnglish words here.\n\n结尾");
        for c in chunk_text(text, 4, 0, "recursive") {
            let slice: String = norm.chars().skip(c.start_char).take(c.end_char - c.start_char).collect();
            assert_eq!(slice, c.text);
        }
    }

    #[test]
    fn english_keeps_sentence_boundaries() {
        let text = "The quick brown fox jumps. Over the lazy dog! Again and again? Yes. ".repeat(20);
        let chunks = chunk_text(&text, 30, 0, "recursive");
        assert!(chunks.len() > 3);
        for c in &chunks {
            assert!(c.token_count <= 30);
        }
    }

    #[test]
    fn oversized_overlap_is_clamped() {
        let text = "段落内容。".repeat(100);
        let chunks = chunk_text(&text, 32, 64, "recursive");
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| c.token_count <= 32 + 8));
    }
}
