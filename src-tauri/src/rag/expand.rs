//! Context expansion: a search hit brings its neighbouring chunks, or its
//! whole section when that is short enough, so the model reads paragraphs
//! instead of fragments. Hits that meet in a document become one passage.
//!
//! Pure functions over a document's chunk outline (`Store::document_outline`);
//! the engine fetches outlines and texts.

use std::collections::HashMap;

use super::headings::{split_path, PATH_SEPARATOR};

/// A chunk of a document, in reading order.
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineChunk {
    pub id: i64,
    pub ord: usize,
    pub tokens: usize,
    /// Heading path ("" without headings).
    pub heading: String,
    /// Character range in the document's normalized text.
    pub start_char: usize,
    pub end_char: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    /// Chunks taken on each side of a hit.
    pub neighbors: usize,
    /// Whole sections up to this many tokens (0: never).
    pub section_max_tokens: usize,
    /// All passages together.
    pub max_total_tokens: usize,
}

/// A hit: its document and position in that document's outline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitPos {
    pub doc: i64,
    pub pos: usize,
}

/// Outline positions `lo..=hi` of one document, and the hits (indexes into
/// the hit list) inside, best first.
#[derive(Debug, Clone, PartialEq)]
pub struct Passage {
    pub doc: i64,
    pub lo: usize,
    pub hi: usize,
    pub hits: Vec<usize>,
}

/// Tokens a chunk adds after the one before it (its overlap with it left out).
fn added_tokens(outline: &[OutlineChunk], i: usize) -> usize {
    let c = &outline[i];
    let chars = c.end_char.saturating_sub(c.start_char);
    let Some(prev) = i.checked_sub(1).map(|p| &outline[p]) else { return c.tokens };
    if chars == 0 || prev.end_char <= c.start_char {
        return c.tokens;
    }
    let fresh = c.end_char.saturating_sub(prev.end_char);
    (c.tokens * fresh).div_ceil(chars)
}

/// Tokens of the text of `outline[lo..=hi]`.
pub fn span_tokens(outline: &[OutlineChunk], lo: usize, hi: usize) -> usize {
    outline[lo].tokens + (lo + 1..=hi).map(|i| added_tokens(outline, i)).sum::<usize>()
}

/// Whether `path` starts with all of `prefix`.
fn under(path: &[&str], prefix: &[&str]) -> bool {
    path.len() >= prefix.len() && path[..prefix.len()] == *prefix
}

/// The largest section around `pos` (its own, then enclosing ones) of at
/// most `max_tokens`, as outline positions.
fn section_span(outline: &[OutlineChunk], pos: usize, max_tokens: usize) -> Option<(usize, usize)> {
    let path = split_path(&outline[pos].heading);
    let mut best = None;
    for depth in (1..=path.len()).rev() {
        let prefix = &path[..depth];
        let inside = |i: usize| under(&split_path(&outline[i].heading), prefix);
        let mut lo = pos;
        while lo > 0 && inside(lo - 1) {
            lo -= 1;
        }
        let mut hi = pos;
        while hi + 1 < outline.len() && inside(hi + 1) {
            hi += 1;
        }
        if span_tokens(outline, lo, hi) > max_tokens {
            break;
        }
        best = Some((lo, hi));
    }
    best
}

fn neighbor_span(outline: &[OutlineChunk], pos: usize, neighbors: usize) -> (usize, usize) {
    (pos.saturating_sub(neighbors), (pos + neighbors).min(outline.len() - 1))
}

/// What a hit at `pos` expands to: its whole section when one fits (the
/// largest that does, so a passage never spills into the next section),
/// else `neighbors` chunks on each side. A section of the hit alone adds
/// nothing: the neighbours are taken then.
pub fn span_for(outline: &[OutlineChunk], pos: usize, limits: Limits) -> (usize, usize) {
    let section = (limits.section_max_tokens > 0)
        .then(|| section_span(outline, pos, limits.section_max_tokens))
        .flatten();
    match section {
        Some((lo, hi)) if hi > lo => (lo, hi),
        _ => neighbor_span(outline, pos, limits.neighbors),
    }
}

/// Plans the passages for `hits` (best first): each hit takes its span
/// while the total stays within `limits.max_total_tokens` (else its
/// neighbours, else itself alone: a hit is never dropped), then the covered
/// chunks of each document are cut into contiguous passages. Passages are
/// ordered by their best hit.
pub fn plan(hits: &[HitPos], outlines: &HashMap<i64, Vec<OutlineChunk>>, limits: Limits) -> Vec<Passage> {
    let mut covered: HashMap<i64, Vec<bool>> = HashMap::new();
    let mut used = 0usize;
    for hit in hits {
        let Some(outline) = outlines.get(&hit.doc).filter(|o| hit.pos < o.len()) else { continue };
        let marks = covered.entry(hit.doc).or_insert_with(|| vec![false; outline.len()]);
        let cost = |marks: &[bool], (lo, hi): (usize, usize)| -> usize {
            (lo..=hi).filter(|i| !marks[*i]).map(|i| if i == lo { outline[i].tokens } else { added_tokens(outline, i) }).sum()
        };
        let candidates = [
            span_for(outline, hit.pos, limits),
            neighbor_span(outline, hit.pos, limits.neighbors),
            (hit.pos, hit.pos),
        ];
        let (lo, hi) = candidates
            .into_iter()
            .find(|span| used + cost(marks, *span) <= limits.max_total_tokens)
            .unwrap_or((hit.pos, hit.pos));
        used += cost(marks, (lo, hi));
        marks[lo..=hi].iter_mut().for_each(|m| *m = true);
    }

    let mut passages: Vec<Passage> = Vec::new();
    let mut docs: Vec<&i64> = covered.keys().collect();
    docs.sort();
    for doc in docs {
        let marks = &covered[doc];
        let mut i = 0;
        while i < marks.len() {
            if !marks[i] {
                i += 1;
                continue;
            }
            let lo = i;
            while i + 1 < marks.len() && marks[i + 1] {
                i += 1;
            }
            passages.push(Passage { doc: *doc, lo, hi: i, hits: Vec::new() });
            i += 1;
        }
    }
    for (n, hit) in hits.iter().enumerate() {
        if let Some(p) = passages.iter_mut().find(|p| p.doc == hit.doc && p.lo <= hit.pos && hit.pos <= p.hi) {
            p.hits.push(n);
        }
    }
    passages.retain(|p| !p.hits.is_empty());
    passages.sort_by_key(|p| p.hits[0]);
    passages
}

/// The text of `outline[lo..=hi]`: overlaps between chunks removed, and the
/// heading of each section the passage enters written on its own line.
pub fn join_text(outline: &[OutlineChunk], lo: usize, hi: usize, texts: &HashMap<i64, String>) -> String {
    let mut out = String::new();
    for i in lo..=hi {
        let c = &outline[i];
        let Some(text) = texts.get(&c.id) else { continue };
        let mut skip = 0;
        if i > lo {
            let prev = &outline[i - 1];
            if prev.heading != c.heading {
                let old = split_path(&prev.heading);
                let new = split_path(&c.heading);
                let same = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
                out.push_str("\n\n");
                for title in &new[same..] {
                    out.push_str(title);
                    out.push('\n');
                }
            } else if c.start_char < prev.end_char {
                skip = prev.end_char - c.start_char;
            } else {
                out.push('\n');
            }
        }
        match text.char_indices().nth(skip) {
            Some((at, _)) => out.push_str(&text[at..]),
            None if skip == 0 => out.push_str(text),
            None => {}
        }
    }
    out
}

/// "a › b": shown as the source of a passage starting at `outline[lo]`.
pub fn passage_heading(outline: &[OutlineChunk], lo: usize) -> Option<String> {
    let heading = &outline[lo].heading;
    (!heading.is_empty()).then(|| split_path(heading).join(PATH_SEPARATOR))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Chunks of `tokens` tokens (one char per token) under their headings,
    /// each overlapping the one before by `overlap` chars when they share a heading.
    fn outline(specs: &[(&str, usize)], overlap: usize) -> Vec<OutlineChunk> {
        let mut out: Vec<OutlineChunk> = Vec::new();
        for (i, (heading, tokens)) in specs.iter().enumerate() {
            let start = match out.last() {
                Some(prev) if prev.heading == *heading => prev.end_char - overlap,
                Some(prev) => prev.end_char + 10,
                None => 0,
            };
            out.push(OutlineChunk {
                id: 100 + i as i64,
                ord: i,
                tokens: *tokens,
                heading: heading.to_string(),
                start_char: start,
                end_char: start + tokens,
            });
        }
        out
    }

    const LIMITS: Limits = Limits { neighbors: 1, section_max_tokens: 250, max_total_tokens: 10_000 };

    #[test]
    fn a_short_section_is_taken_whole_else_neighbours() {
        let o = outline(
            &[("A › A.1", 100), ("A › A.1", 100), ("A › A.2", 100), ("A › A.2", 100), ("A › A.2", 100), ("B", 100), ("B", 100)],
            0,
        );
        // A.1 is 200 tokens: whole. A, 500 tokens, is too large.
        assert_eq!(span_for(&o, 0, LIMITS), (0, 1));
        // A.2 is 300 tokens: too large, so neighbours.
        assert_eq!(span_for(&o, 3, LIMITS), (2, 4));
        // B fits: all of it and nothing of A, though the neighbour window reaches into A.
        assert_eq!(span_for(&o, 5, LIMITS), (5, 6));
        // A section of the hit alone (A.2 here; A is too large): neighbours.
        let leaves = outline(&[("A › A.1", 100), ("A › A.2", 100), ("A › A.3", 100)], 0);
        assert_eq!(span_for(&leaves, 1, Limits { section_max_tokens: 150, ..LIMITS }), (0, 2));
        // No headings: neighbours only; at the edges the window is cut.
        let flat = outline(&[("", 100), ("", 100), ("", 100)], 0);
        assert_eq!(span_for(&flat, 0, LIMITS), (0, 1));
        assert_eq!(span_for(&flat, 2, Limits { neighbors: 0, ..LIMITS }), (2, 2));
        // Sections off: neighbours even where a section would fit.
        assert_eq!(span_for(&o, 0, Limits { section_max_tokens: 0, neighbors: 0, ..LIMITS }), (0, 0));
    }

    #[test]
    fn an_enclosing_section_is_taken_when_it_fits() {
        let o = outline(&[("A › A.1", 60), ("A › A.2", 60), ("A › A.2", 60), ("B", 60)], 0);
        assert_eq!(span_for(&o, 1, Limits { neighbors: 0, ..LIMITS }), (0, 2), "all of A (180 tokens)");
    }

    #[test]
    fn overlap_is_not_counted_twice() {
        let o = outline(&[("", 100), ("", 100), ("", 100)], 20);
        assert_eq!(span_tokens(&o, 0, 2), 260);
    }

    #[test]
    fn hits_that_meet_merge_and_order_follows_the_best_hit() {
        let doc1 = outline(&[("", 50); 10], 0);
        let doc2 = outline(&[("", 50), ("", 50), ("", 50)], 0);
        let outlines = HashMap::from([(1, doc1), (2, doc2)]);
        let hits = [HitPos { doc: 2, pos: 1 }, HitPos { doc: 1, pos: 2 }, HitPos { doc: 1, pos: 4 }, HitPos { doc: 1, pos: 8 }];
        let passages = plan(&hits, &outlines, Limits { section_max_tokens: 0, ..LIMITS });
        // 1..=3 and 3..=5 overlap; 7..=9 is apart (chunk 6 between).
        assert_eq!(
            passages,
            vec![
                Passage { doc: 2, lo: 0, hi: 2, hits: vec![0] },
                Passage { doc: 1, lo: 1, hi: 5, hits: vec![1, 2] },
                Passage { doc: 1, lo: 7, hi: 9, hits: vec![3] },
            ]
        );
        // Windows that only touch make one passage too: their text is contiguous.
        let touching = [HitPos { doc: 1, pos: 2 }, HitPos { doc: 1, pos: 5 }];
        assert_eq!(plan(&touching, &outlines, Limits { section_max_tokens: 0, ..LIMITS }).len(), 1);
    }

    #[test]
    fn the_budget_shrinks_later_hits_but_never_drops_them() {
        let doc = outline(&[("", 100), ("", 100), ("", 100), ("", 100), ("", 100), ("", 100), ("", 100), ("", 100)], 0);
        let outlines = HashMap::from([(1, doc)]);
        let hits = [HitPos { doc: 1, pos: 1 }, HitPos { doc: 1, pos: 6 }];
        let limits = Limits { neighbors: 1, section_max_tokens: 0, max_total_tokens: 350 };
        // The first takes 0..=2 (300), the second only fits alone… but 400 > 350: alone anyway.
        let passages = plan(&hits, &outlines, limits);
        assert_eq!(
            passages,
            vec![Passage { doc: 1, lo: 0, hi: 2, hits: vec![0] }, Passage { doc: 1, lo: 6, hi: 6, hits: vec![1] }]
        );
        // Unknown documents and positions are skipped.
        let missing = [HitPos { doc: 9, pos: 0 }, HitPos { doc: 1, pos: 99 }];
        assert!(plan(&missing, &outlines, limits).is_empty());
    }

    #[test]
    fn joined_text_drops_overlaps_and_names_entered_sections() {
        let o = vec![
            OutlineChunk { id: 1, ord: 0, tokens: 6, heading: "第一章 › 1.1".into(), start_char: 0, end_char: 6 },
            OutlineChunk { id: 2, ord: 1, tokens: 6, heading: "第一章 › 1.1".into(), start_char: 4, end_char: 10 },
            OutlineChunk { id: 3, ord: 2, tokens: 3, heading: "第一章 › 1.2".into(), start_char: 16, end_char: 19 },
            OutlineChunk { id: 4, ord: 3, tokens: 3, heading: "第二章".into(), start_char: 25, end_char: 28 },
            OutlineChunk { id: 5, ord: 4, tokens: 3, heading: "第二章".into(), start_char: 30, end_char: 33 },
        ];
        let texts = HashMap::from([
            (1, "甲乙丙丁戊己".to_string()),
            (2, "戊己庚辛壬癸".to_string()),
            (3, "子丑寅".to_string()),
            (4, "卯辰巳".to_string()),
            (5, "午未申".to_string()),
        ]);
        assert_eq!(join_text(&o, 0, 4, &texts), "甲乙丙丁戊己庚辛壬癸\n\n1.2\n子丑寅\n\n第二章\n卯辰巳\n午未申");
        assert_eq!(passage_heading(&o, 2).as_deref(), Some("第一章 › 1.2"));
        assert_eq!(join_text(&o, 1, 1, &texts), "戊己庚辛壬癸");
    }
}
