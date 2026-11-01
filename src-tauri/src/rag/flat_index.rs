//! Placeholder with the final API (brute force f32) until the int8 index lands.

use std::collections::HashMap;

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for (x, y) in a.iter().zip(b) {
        sum += x * y;
    }
    sum
}

pub fn l2_normalize(v: &mut [f32]) -> bool {
    if v.iter().any(|x| !x.is_finite()) {
        return false;
    }
    let norm = (v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>()).sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return false;
    }
    for x in v.iter_mut() {
        *x = (*x as f64 / norm) as f32;
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candidate {
    pub id: i64,
    pub approx: f64,
    pub lower: f64,
    pub upper: f64,
}

pub struct FlatIndex {
    dims: usize,
    rows: HashMap<i64, Vec<f32>>,
}

impl FlatIndex {
    pub fn new(dims: usize) -> Self {
        Self { dims, rows: HashMap::new() }
    }
    pub fn dims(&self) -> usize {
        self.dims
    }
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    pub fn memory_bytes(&self) -> usize {
        self.rows.len() * (self.dims * 4 + 32)
    }
    pub fn upsert(&mut self, id: i64, vector: &[f32]) {
        assert_eq!(vector.len(), self.dims);
        self.rows.insert(id, vector.to_vec());
    }
    pub fn remove(&mut self, id: i64) -> bool {
        self.rows.remove(&id).is_some()
    }
    pub fn contains(&self, id: i64) -> bool {
        self.rows.contains_key(&id)
    }
    pub fn clear(&mut self) {
        self.rows.clear();
    }
    pub fn candidates(&self, query: &[f32], n: usize) -> Vec<Candidate> {
        if n == 0 {
            return Vec::new();
        }
        let mut out: Vec<Candidate> = self
            .rows
            .iter()
            .map(|(id, v)| {
                let s = dot(query, v) as f64;
                Candidate { id: *id, approx: s, lower: s, upper: s }
            })
            .collect();
        out.sort_by(|a, b| b.upper.partial_cmp(&a.upper).unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id)));
        out.truncate(n);
        out
    }
    pub fn search<F>(&self, query: &[f32], n: usize, min_score: Option<f32>, fetch: F) -> Vec<(i64, f32)>
    where
        F: FnMut(&[i64]) -> Vec<(i64, Vec<f32>)>,
    {
        rescore_exact(query, &self.candidates(query, n), n, min_score, fetch)
    }
}

pub fn rescore_exact<F>(query: &[f32], candidates: &[Candidate], n: usize, min_score: Option<f32>, mut fetch: F) -> Vec<(i64, f32)>
where
    F: FnMut(&[i64]) -> Vec<(i64, Vec<f32>)>,
{
    let ids: Vec<i64> = candidates.iter().map(|c| c.id).collect();
    let mut out: Vec<(i64, f32)> = Vec::new();
    for batch in ids.chunks(64) {
        for (id, v) in fetch(batch) {
            let s = dot(query, &v);
            if min_score.is_none_or(|m| s >= m) {
                out.push((id, s));
            }
        }
    }
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    out.truncate(n);
    out
}
