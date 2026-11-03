use serde::Serialize;
use std::collections::HashMap;

/// A search result with chunk text, score, and source metadata.
#[derive(Debug, Clone, Serialize)]
pub struct ScoredChunk {
    pub chunk_id: String,
    pub text: String,
    /// The score the results are ordered by: the reranker's relevance when
    /// they were reranked, else the search score (fusion, cosine or keyword).
    pub score: f64,
    /// `score` relative to the first result (1.0).
    pub normalized_score: f64,
    pub source_file: String,
    pub chunk_index: usize,
    pub source_type: String,
    /// Set when a reranker ordered the results: the position (from 1) and
    /// score this chunk had after fusion.
    pub fused_rank: Option<usize>,
    pub fused_score: Option<f64>,
    /// Heading path where the text starts ("第三章 研究方法 › 3.2 数据来源").
    pub heading: Option<String>,
    /// First and last chunk (`chunk_index`) of an expanded passage.
    pub chunk_range: Option<(usize, usize)>,
}

/// How a query is matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    /// Vector and keyword results fused by rank.
    Hybrid,
    /// Vectors only (keywords when vectors can't be used).
    Semantic,
    /// Keywords only.
    Keyword,
}

impl SearchMode {
    pub fn parse(mode: &str) -> Self {
        match mode {
            "semantic" => Self::Semantic,
            "keyword" => Self::Keyword,
            _ => Self::Hybrid,
        }
    }
}

/// Weighted reciprocal rank fusion: each list adds `weight / (k + rank)`
/// (rank from 1) to its ids. Sorted by score desc, ties by id asc.
pub fn rrf_fuse(lists: &[(&[i64], f64)], k: f64) -> Vec<(i64, f64)> {
    let mut scores: HashMap<i64, f64> = HashMap::new();
    for (ids, weight) in lists {
        for (rank, id) in ids.iter().enumerate() {
            *scores.entry(*id).or_insert(0.0) += weight / (k + (rank + 1) as f64);
        }
    }
    let mut merged: Vec<(i64, f64)> = scores.into_iter().collect();
    sort_desc(&mut merged);
    merged
}

/// Sorts (id, score) by score desc, ties by id asc.
pub fn sort_desc(items: &mut [(i64, f64)]) {
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_rewards_agreement_and_respects_weights() {
        let vector = [1, 2, 3];
        let keyword = [3, 4];
        let fused = rrf_fuse(&[(&vector, 0.7), (&keyword, 0.3)], 60.0);
        let ids: Vec<i64> = fused.iter().map(|(id, _)| *id).collect();
        // 3 is in both lists: it beats 1, the vector winner.
        assert_eq!(ids, vec![3, 1, 2, 4]);
        let s3 = fused.iter().find(|(id, _)| *id == 3).unwrap().1;
        let expected = 0.7 / 63.0 + 0.3 / 61.0;
        assert!((s3 - expected).abs() < 1e-12);
        // Pure keyword weight puts the keyword winner first.
        let fused = rrf_fuse(&[(&vector, 0.0), (&keyword, 1.0)], 60.0);
        assert_eq!(fused[0].0, 3);
    }

    #[test]
    fn ties_are_broken_by_id() {
        let fused = rrf_fuse(&[(&[5, 2], 1.0), (&[2, 5], 1.0)], 60.0);
        assert_eq!(fused.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![2, 5]);
    }

    #[test]
    fn modes_parse_with_hybrid_default() {
        assert_eq!(SearchMode::parse("semantic"), SearchMode::Semantic);
        assert_eq!(SearchMode::parse("keyword"), SearchMode::Keyword);
        assert_eq!(SearchMode::parse("hybrid"), SearchMode::Hybrid);
        assert_eq!(SearchMode::parse("?"), SearchMode::Hybrid);
    }
}
