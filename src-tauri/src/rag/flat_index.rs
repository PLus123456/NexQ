//! Exact int8 flat vector index for the RAG engine.
//!
//! Every row keeps a symmetric per-row int8 copy of its vector: `s = max|x_i| / 127`,
//! `c_i = round(x_i / s)`, reconstruction `r = s * c`. A query is quantized the same way
//! (`q~ = sq * qc`) and each live row gets `approx = sq * s * (qc . c)`, the integer dot
//! product being exact in i32.
//!
//! Since `q.x - approx = q.(x - r) + (q - q~).r`, Cauchy-Schwarz gives
//! `|q.x - approx| <= |q| |x - r| + |q - q~| |r|`. The f32 [`dot`] adds at most about
//! `d u |q| |x|` of rounding (u = 2^-24, `|x| <= |r| + |x - r|`), covered by the margin
//! `2 d eps |q| (|r| + |x - r|) + 1e-9`. All norms are computed in f64 and rounded up, so
//! `lower <= dot(query, x) <= upper` holds for the score [`dot`] actually returns. Selecting
//! candidates on these bounds and re-scoring them with [`dot`] reproduces brute force exactly:
//! same ids, same order, bit-identical scores.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fmt;
use std::ops::Range;
use std::sync::OnceLock;

/// Rows per storage segment.
pub const SEGMENT_ROWS: usize = 4096;
/// Largest supported dimension; keeps the integer dot product inside i32 (127 * 127 * 100_000 < 2^31).
pub const MAX_DIMS: usize = 100_000;
/// Most ids `rescore_exact` passes to `fetch` in one call.
pub const FETCH_BATCH: usize = 64;
/// Scans over at least this many codes (`rows * dims`) are split across threads.
pub const PARALLEL_MIN_CODES: usize = 4_194_304;
/// Most threads one scan uses.
pub const MAX_SCAN_THREADS: usize = 8;

const COMPACT_MIN_TOMBSTONES: usize = 1024;
/// Below this value of `|q| (|r| + |x - r|)` the f32 `dot` cannot overflow; rows above it get infinite bounds.
const OVERFLOW_GUARD: f64 = 1e38;
const LANES: usize = 16;

/// Exact dot product used for every exact score (index re-scoring, brute force, the engine).
///
/// Sums 16 independent f32 lanes and combines them in a fixed order, so LLVM vectorizes it
/// without fast-math and every call site gets bit-identical results. Panics if the lengths differ.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "dot: length mismatch");
    let mut acc = [0.0f32; LANES];
    let (ca, ra) = a.as_chunks::<LANES>();
    let (cb, rb) = b.as_chunks::<LANES>();
    for (x, y) in ca.iter().zip(cb) {
        for ((s, &x), &y) in acc.iter_mut().zip(x).zip(y) {
            *s += x * y;
        }
    }
    let mut width = LANES;
    while width > 1 {
        width /= 2;
        let (lo, hi) = acc.split_at_mut(width);
        for (s, &t) in lo.iter_mut().zip(&hi[..width]) {
            *s += t;
        }
    }
    let mut sum = acc[0];
    for (&x, &y) in ra.iter().zip(rb) {
        sum += x * y;
    }
    sum
}

/// Integer dot product of two code rows; exact for codes in [-127, 127] and up to `MAX_DIMS` values.
pub fn dot_i8(a: &[i8], b: &[i8]) -> i32 {
    a.iter().zip(b).map(|(&x, &y)| i32::from(x) * i32::from(y)).sum()
}

/// Scales `v` to unit length in place; returns false (leaving `v` unchanged) if it is all zeros
/// or has a non-finite value.
pub fn l2_normalize(v: &mut [f32]) -> bool {
    let mut sum = 0.0f64;
    for &x in v.iter() {
        if !x.is_finite() {
            return false;
        }
        sum += f64::from(x) * f64::from(x);
    }
    if sum == 0.0 {
        return false;
    }
    let inv = 1.0 / sum.sqrt();
    for x in v.iter_mut() {
        *x = (f64::from(*x) * inv) as f32;
    }
    true
}

/// Result order shared by `rescore_exact` and brute force: score desc, ties by id asc
/// (-0.0 and 0.0 are equal). Scores are never NaN here.
pub fn result_order(a: &(i64, f32), b: &(i64, f32)) -> Ordering {
    (b.1 + 0.0).total_cmp(&(a.1 + 0.0)).then(a.0.cmp(&b.0))
}

/// One row of the int8 scan: `lower <= dot(query, x) <= upper`, `approx` is the int8 estimate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candidate {
    pub id: i64,
    pub approx: f64,
    pub lower: f64,
    pub upper: f64,
}

/// Exact flat index over int8 copies of L2-normalized vectors; see the module docs for the bound.
pub struct FlatIndex {
    dims: usize,
    segments: Vec<Segment>,
    slots: HashMap<i64, (u32, u32)>,
    live: usize,
    tombstones: usize,
}

#[derive(Default)]
struct Segment {
    codes: Vec<i8>,
    ids: Vec<i64>,
    scale: Vec<f32>,
    err_norm: Vec<f32>,
    rec_norm: Vec<f32>,
    live: Vec<bool>,
}

impl Segment {
    fn rows(&self) -> usize {
        self.ids.len()
    }

    fn heap_bytes(&self) -> usize {
        self.codes.capacity()
            + self.ids.capacity() * 8
            + (self.scale.capacity() + self.err_norm.capacity() + self.rec_norm.capacity()) * 4
            + self.live.capacity()
    }
}

impl FlatIndex {
    /// Empty index for `dims`-dimensional vectors; panics unless `1 <= dims <= MAX_DIMS`.
    pub fn new(dims: usize) -> Self {
        assert!(
            (1..=MAX_DIMS).contains(&dims),
            "FlatIndex: dims must be in 1..={MAX_DIMS}, got {dims}"
        );
        Self {
            dims,
            segments: Vec::new(),
            slots: HashMap::new(),
            live: 0,
            tombstones: 0,
        }
    }

    /// Vector dimension.
    pub fn dims(&self) -> usize {
        self.dims
    }

    /// Number of live rows.
    pub fn len(&self) -> usize {
        self.live
    }

    /// True when there are no live rows.
    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// Removed rows not yet reclaimed by compaction.
    pub fn tombstones(&self) -> usize {
        self.tombstones
    }

    /// Approximate heap usage in bytes.
    pub fn memory_bytes(&self) -> usize {
        let segments: usize = self.segments.iter().map(Segment::heap_bytes).sum();
        let slots = self.slots.capacity() * (std::mem::size_of::<(i64, (u32, u32))>() + 1);
        std::mem::size_of::<Self>()
            + self.segments.capacity() * std::mem::size_of::<Segment>()
            + segments
            + slots
    }

    /// True if `id` is a live row.
    pub fn contains(&self, id: i64) -> bool {
        self.slots.contains_key(&id)
    }

    /// Inserts or replaces (in place) the vector for `id`. Panics if `vector.len() != dims`.
    /// Expects an L2-normalized vector, but results stay exact for any vector; rows with
    /// non-finite values simply become a candidate for every query.
    pub fn upsert(&mut self, id: i64, vector: &[f32]) {
        assert_eq!(
            vector.len(),
            self.dims,
            "FlatIndex::upsert: vector length must equal dims"
        );
        let d = self.dims;
        let slot = self.slots.get(&id).copied();
        let (si, row) = match slot {
            Some((si, row)) => (si as usize, row as usize),
            None => self.push_row(id),
        };
        let seg = &mut self.segments[si];
        let q = quantize(vector, &mut seg.codes[row * d..(row + 1) * d]);
        seg.scale[row] = q.scale;
        seg.err_norm[row] = round_up(q.err_norm) as f32;
        seg.rec_norm[row] = round_up(q.rec_norm) as f32;
    }

    /// Tombstones `id`; returns false if it is absent. Compacts once tombstones exceed 25% of
    /// the rows (and number at least 1024).
    pub fn remove(&mut self, id: i64) -> bool {
        let Some((si, row)) = self.slots.remove(&id) else {
            return false;
        };
        self.segments[si as usize].live[row as usize] = false;
        self.live -= 1;
        self.tombstones += 1;
        if self.live == 0 {
            self.clear();
        } else if self.tombstones >= COMPACT_MIN_TOMBSTONES
            && self.tombstones * 4 > self.live + self.tombstones
        {
            self.compact();
        }
        true
    }

    /// Drops every row and releases the memory.
    pub fn clear(&mut self) {
        self.segments = Vec::new();
        self.slots = HashMap::new();
        self.live = 0;
        self.tombstones = 0;
    }

    /// Rebuilds the segments without tombstones. Rows keep their codes and norms bit for bit,
    /// so results do not change.
    pub fn compact(&mut self) {
        if self.tombstones == 0 {
            return;
        }
        let d = self.dims;
        let old = std::mem::take(&mut self.segments);
        self.slots.clear();
        self.live = 0;
        self.tombstones = 0;
        for seg in old {
            for r in (0..seg.rows()).filter(|&r| seg.live[r]) {
                let (si, row) = self.push_row(seg.ids[r]);
                let dst = &mut self.segments[si];
                dst.codes[row * d..(row + 1) * d].copy_from_slice(&seg.codes[r * d..(r + 1) * d]);
                dst.scale[row] = seg.scale[r];
                dst.err_norm[row] = seg.err_norm[r];
                dst.rec_norm[row] = seg.rec_norm[r];
            }
        }
    }

    /// Ids whose exact score could be among the top `n`: a guaranteed superset of the exact
    /// top `n` (ties at the cut included), sorted by `upper` desc, ties by id asc. Empty when
    /// `n == 0`, the index is empty, or the query has a NaN (every score would be NaN).
    /// Panics if `query.len() != dims`.
    ///
    /// Every live row gets `lower <= dot(query, x) <= upper` (infinite bounds when the row is not
    /// finite or its f32 score could overflow). With τ the n-th largest `lower`,
    /// at least n rows score `>= τ`, so the n-th best exact score is `>= τ` and every row of the
    /// exact top n has `upper >= score >= τ`. Only rows with `upper < τ` are dropped.
    pub fn candidates(&self, query: &[f32], n: usize) -> Vec<Candidate> {
        let codes = (self.live + self.tombstones).saturating_mul(self.dims);
        let threads = if codes >= PARALLEL_MIN_CODES { scan_threads() } else { 1 };
        self.candidates_with(query, n, threads)
    }

    /// `candidates()` followed by `rescore_exact()`.
    pub fn search<F>(&self, query: &[f32], n: usize, min_score: Option<f32>, fetch: F) -> Vec<(i64, f32)>
    where
        F: FnMut(&[i64]) -> Vec<(i64, Vec<f32>)>,
    {
        let candidates = self.candidates(query, n);
        rescore_exact(query, &candidates, n, min_score, fetch)
    }

    fn candidates_with(&self, query: &[f32], n: usize, threads: usize) -> Vec<Candidate> {
        assert_eq!(
            query.len(),
            self.dims,
            "FlatIndex::candidates: query length must equal dims"
        );
        if n == 0 || self.live == 0 || query.iter().any(|x| x.is_nan()) {
            return Vec::new();
        }
        let q = QueryCode::new(query);
        let keep_all = n >= self.live;
        let tasks = self.split(threads.max(1));
        let mut out = match tasks.split_first() {
            None => Vec::new(),
            Some((first, [])) => self.scan_task(first, &q, n, keep_all),
            Some((first, rest)) => {
                let parts: Vec<Vec<Candidate>> = std::thread::scope(|scope| {
                    let q = &q;
                    let handles: Vec<_> = rest
                        .iter()
                        .map(|task| scope.spawn(move || self.scan_task(task, q, n, keep_all)))
                        .collect();
                    let mut parts = vec![self.scan_task(first, q, n, keep_all)];
                    for handle in handles {
                        parts.push(handle.join().unwrap_or_else(|e| std::panic::resume_unwind(e)));
                    }
                    parts
                });
                let mut merged = Collector::new(n, keep_all);
                for c in parts.into_iter().flatten() {
                    merged.offer(c);
                }
                merged.finish()
            }
        };
        out.sort_unstable_by(|a, b| desc(a.upper, b.upper).then(a.id.cmp(&b.id)));
        out
    }

    /// Splits the physical rows into at most `parts` contiguous runs of near-equal length.
    fn split(&self, parts: usize) -> Vec<Vec<(usize, Range<usize>)>> {
        let total: usize = self.segments.iter().map(Segment::rows).sum();
        let per = total.div_ceil(parts).max(1);
        let mut tasks = Vec::with_capacity(parts);
        let mut current = Vec::new();
        let mut taken = 0;
        for (si, seg) in self.segments.iter().enumerate() {
            let mut start = 0;
            while start < seg.rows() {
                let take = (per - taken).min(seg.rows() - start);
                current.push((si, start..start + take));
                start += take;
                taken += take;
                if taken == per {
                    tasks.push(std::mem::take(&mut current));
                    taken = 0;
                }
            }
        }
        if !current.is_empty() {
            tasks.push(current);
        }
        tasks
    }

    /// Scores the rows of one task; partial pruning is exact (see `Collector`).
    fn scan_task(&self, task: &[(usize, Range<usize>)], q: &QueryCode, n: usize, keep_all: bool) -> Vec<Candidate> {
        let d = self.dims;
        let mut col = Collector::new(n, keep_all);
        for (si, rows) in task {
            let seg = &self.segments[*si];
            for r in rows.clone() {
                if !seg.live[r] {
                    continue;
                }
                let dot = dot_i8(&q.codes, &seg.codes[r * d..(r + 1) * d]);
                let approx = q.scale * f64::from(seg.scale[r]) * f64::from(dot);
                let (lower, upper) = q.bounds(approx, f64::from(seg.err_norm[r]), f64::from(seg.rec_norm[r]));
                col.offer(Candidate {
                    id: seg.ids[r],
                    approx,
                    lower,
                    upper,
                });
            }
        }
        col.finish()
    }

    /// Appends a zeroed live row for `id`, registers it and returns its location.
    fn push_row(&mut self, id: i64) -> (usize, usize) {
        let d = self.dims;
        if self.segments.last().is_none_or(|s| s.rows() == SEGMENT_ROWS) {
            self.segments.push(Segment::default());
        }
        let si = self.segments.len() - 1;
        let seg = &mut self.segments[si];
        let row = seg.rows();
        let needed = (row + 1) * d;
        if seg.codes.capacity() < needed {
            // Geometric growth, capped at one full segment.
            let target = (seg.codes.capacity() * 2).clamp(needed, SEGMENT_ROWS * d);
            seg.codes.reserve_exact(target - seg.codes.len());
        }
        seg.codes.resize(needed, 0);
        seg.ids.push(id);
        seg.scale.push(0.0);
        seg.err_norm.push(0.0);
        seg.rec_norm.push(0.0);
        seg.live.push(true);
        self.slots.insert(id, (si as u32, row as u32));
        self.live += 1;
        (si, row)
    }
}

impl fmt::Debug for FlatIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FlatIndex")
            .field("dims", &self.dims)
            .field("len", &self.live)
            .field("tombstones", &self.tombstones)
            .field("segments", &self.segments.len())
            .finish()
    }
}

/// Exact phase, separate so the engine can drop its index lock before fetching from SQLite.
///
/// Walks `candidates` in order (upper desc), calling `fetch` with at most 64 ids at a time (the
/// first call asks for only `n`), and scores what comes back with `dot(query, v)`. Ids that are
/// not returned (deleted meanwhile), ids that were not asked for and vectors of the wrong length
/// are skipped. Keeps the best `n` with `score >= min_score`; NaN scores are dropped. A candidate
/// is no longer fetched once its `upper` is strictly below the n-th best score held (it can
/// neither beat nor tie it) or below `min_score`. Returns at most `n` `(id, score)` sorted by
/// score desc, ties by id asc.
pub fn rescore_exact<F>(
    query: &[f32],
    candidates: &[Candidate],
    n: usize,
    min_score: Option<f32>,
    mut fetch: F,
) -> Vec<(i64, f32)>
where
    F: FnMut(&[i64]) -> Vec<(i64, Vec<f32>)>,
{
    if n == 0 || candidates.is_empty() {
        return Vec::new();
    }
    let mut top: BinaryHeap<Worst> = BinaryHeap::with_capacity(n.min(candidates.len()));
    let mut requested: HashSet<i64> = HashSet::new();
    let mut batch: Vec<i64> = Vec::with_capacity(FETCH_BATCH);
    let mut limit = n.min(FETCH_BATCH);
    let mut next = 0;
    loop {
        batch.clear();
        while batch.len() < limit && next < candidates.len() {
            let c = &candidates[next];
            next += 1;
            if !is_pruned(c.upper, &top, n, min_score) && requested.insert(c.id) {
                batch.push(c.id);
            }
        }
        if batch.is_empty() {
            break;
        }
        let mut done = [false; FETCH_BATCH];
        for (id, v) in fetch(&batch) {
            let Some(pos) = batch.iter().position(|&b| b == id) else {
                continue;
            };
            if done[pos] || v.len() != query.len() {
                continue;
            }
            done[pos] = true;
            let score = dot(query, &v);
            if score.is_nan() || min_score.is_some_and(|m| m.is_nan() || score < m) {
                continue;
            }
            if top.len() < n {
                top.push(Worst((id, score)));
            } else if let Some(mut worst) = top.peek_mut() {
                if result_order(&(id, score), &worst.0) == Ordering::Less {
                    *worst = Worst((id, score));
                }
            }
        }
        limit = FETCH_BATCH;
    }
    let mut out: Vec<(i64, f32)> = top.into_iter().map(|w| w.0).collect();
    out.sort_unstable_by(result_order);
    out
}

/// True when a candidate with this `upper` cannot enter the result.
fn is_pruned(upper: f64, top: &BinaryHeap<Worst>, n: usize, min_score: Option<f32>) -> bool {
    if min_score.is_some_and(|m| upper < f64::from(m)) {
        return true;
    }
    top.len() >= n && top.peek().is_some_and(|w| upper < f64::from(w.0 .1))
}

/// Heap entry ordered so that the worst result is the maximum.
struct Worst((i64, f32));

impl Ord for Worst {
    fn cmp(&self, other: &Self) -> Ordering {
        result_order(&self.0, &other.0)
    }
}

impl PartialOrd for Worst {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Worst {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Worst {}

/// Threads for a large scan, looked up once (`available_parallelism` can hit the filesystem).
fn scan_threads() -> usize {
    static THREADS: OnceLock<usize> = OnceLock::new();
    *THREADS.get_or_init(|| {
        std::thread::available_parallelism()
            .map_or(1, |p| p.get())
            .min(MAX_SCAN_THREADS)
    })
}

/// Descending f64 order in which -0.0 equals 0.0 (bounds are never NaN).
fn desc(a: f64, b: f64) -> Ordering {
    (b + 0.0).total_cmp(&(a + 0.0))
}

/// Rounds a non-negative f64 up a little, so its f32 copy is never below the true value.
fn round_up(v: f64) -> f64 {
    v * (1.0 + 1e-6) + 1e-12
}

struct Quantized {
    scale: f32,
    err_norm: f64,
    rec_norm: f64,
    norm: f64,
}

/// Symmetric int8 quantization of `v` into `codes`. The norms are computed in f64 from the
/// stored scale and codes, so they describe exactly the reconstruction the bound uses.
fn quantize(v: &[f32], codes: &mut [i8]) -> Quantized {
    let max = v.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    let mut scale = max / 127.0;
    if scale > 0.0 {
        let inv = 1.0 / f64::from(scale);
        for (c, &x) in codes.iter_mut().zip(v) {
            *c = (f64::from(x) * inv).round().clamp(-127.0, 127.0) as i8;
        }
    } else {
        scale = 0.0;
        codes.fill(0);
    }
    let s = f64::from(scale);
    let (mut err2, mut rec2, mut norm2) = (0.0f64, 0.0f64, 0.0f64);
    for (&c, &x) in codes.iter().zip(v) {
        let (x, r) = (f64::from(x), s * f64::from(c));
        err2 += (x - r) * (x - r);
        rec2 += r * r;
        norm2 += x * x;
    }
    Quantized {
        scale,
        err_norm: err2.sqrt(),
        rec_norm: rec2.sqrt(),
        norm: norm2.sqrt(),
    }
}

/// Quantized query plus the per-query parts of the bound.
struct QueryCode {
    codes: Vec<i8>,
    scale: f64,
    /// |q|, rounded up.
    norm: f64,
    /// Multiplies a row's `err_norm`: |q| (1 + m), with m = 2 d eps.
    err_coef: f64,
    /// Multiplies a row's `rec_norm`: |q - q~| + |q| m.
    rec_coef: f64,
}

impl QueryCode {
    fn new(query: &[f32]) -> Self {
        let mut codes = vec![0; query.len()];
        let qz = quantize(query, &mut codes);
        let norm = round_up(qz.norm);
        let err = round_up(qz.err_norm);
        // Rounding of the f32 dot: |fl(q.x) - q.x| <= d u |q| |x| <= m |q| (|r| + |x - r|).
        let m = 2.0 * query.len() as f64 * f64::from(f32::EPSILON);
        Self {
            codes,
            scale: f64::from(qz.scale),
            norm,
            err_coef: norm * (1.0 + m),
            rec_coef: err + norm * m,
        }
    }

    /// `(lower, upper)` around `approx` for a row with these stored norms.
    fn bounds(&self, approx: f64, err_norm: f64, rec_norm: f64) -> (f64, f64) {
        // NaN here means a non-finite input; such rows are unbounded too.
        let size = self.norm * (err_norm + rec_norm);
        if size.is_nan() || size >= OVERFLOW_GUARD {
            return (f64::NEG_INFINITY, f64::INFINITY);
        }
        let b = err_norm * self.err_coef + rec_norm * self.rec_coef + 1e-9;
        (approx - b, approx + b)
    }
}

/// Streams scored rows, keeping those with `upper >= τ`, where τ is the n-th largest `lower`
/// offered so far (raised with `select_nth_unstable_by` whenever the buffer fills up).
///
/// A dropped row has `lower <= upper < τ` while at least n kept rows have `lower >= τ`, so the
/// kept rows always contain the n largest lowers and the final τ is exact. Running a collector
/// per thread and another over their outputs gives the same set as one global pass.
struct Collector {
    n: usize,
    keep_all: bool,
    tau: f64,
    cap: usize,
    out: Vec<Candidate>,
}

impl Collector {
    fn new(n: usize, keep_all: bool) -> Self {
        Self {
            n,
            keep_all,
            tau: f64::NEG_INFINITY,
            cap: if keep_all { usize::MAX } else { n.saturating_mul(2).max(4096) },
            out: Vec::new(),
        }
    }

    fn offer(&mut self, c: Candidate) {
        if c.upper >= self.tau {
            self.out.push(c);
            if self.out.len() >= self.cap {
                self.prune();
            }
        }
    }

    fn prune(&mut self) {
        if self.keep_all || self.out.len() <= self.n {
            return;
        }
        let (_, nth, _) = self
            .out
            .select_nth_unstable_by(self.n - 1, |a, b| desc(a.lower, b.lower));
        let tau = nth.lower;
        self.tau = tau;
        self.out.retain(|c| c.upper >= tau);
        self.cap = self.cap.max(self.out.len() * 2);
    }

    fn finish(mut self) -> Vec<Candidate> {
        self.prune();
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    type Store = HashMap<i64, Vec<f32>>;

    /// splitmix64: small and deterministic.
    struct Rng(u64);

    impl Rng {
        fn new(seed: u64) -> Self {
            Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03)
        }

        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next_u64() % n as u64) as usize
        }

        /// Uniform in [0, 1).
        fn uniform(&mut self) -> f64 {
            (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
        }

        /// Standard normal (Box-Muller).
        fn gauss(&mut self) -> f64 {
            let u1 = 1.0 - self.uniform();
            let u2 = self.uniform();
            (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
        }
    }

    fn random_unit(rng: &mut Rng, dims: usize) -> Vec<f32> {
        loop {
            let mut v: Vec<f32> = (0..dims).map(|_| rng.gauss() as f32).collect();
            if l2_normalize(&mut v) {
                return v;
            }
        }
    }

    /// `base` plus Gaussian noise of total norm about `spread`, normalized.
    fn near(rng: &mut Rng, base: &[f32], spread: f64) -> Vec<f32> {
        let sigma = spread / (base.len() as f64).sqrt();
        loop {
            let mut v: Vec<f32> = base.iter().map(|&x| x + (sigma * rng.gauss()) as f32).collect();
            if l2_normalize(&mut v) {
                return v;
            }
        }
    }

    /// Distinct ids over the whole i64 range, extremes first.
    fn distinct_ids(rng: &mut Rng, count: usize) -> Vec<i64> {
        let mut seen = HashSet::new();
        let mut out = Vec::with_capacity(count);
        for id in [i64::MIN, i64::MAX, 0, -1, 1] {
            if out.len() < count && seen.insert(id) {
                out.push(id);
            }
        }
        while out.len() < count {
            let shift = rng.below(63) as u32;
            let id = (rng.next_u64() as i64) >> shift;
            if seen.insert(id) {
                out.push(id);
            }
        }
        out
    }

    /// Random unit vectors, tight clusters, near-duplicates and exact duplicates.
    fn dataset(rng: &mut Rng, dims: usize, count: usize) -> Vec<(i64, Vec<f32>)> {
        let centers: Vec<Vec<f32>> = (0..6).map(|_| random_unit(rng, dims)).collect();
        let mut rows: Vec<(i64, Vec<f32>)> = Vec::with_capacity(count);
        for id in distinct_ids(rng, count) {
            let v = match rng.below(10) {
                _ if rows.is_empty() => random_unit(rng, dims),
                0..=3 => random_unit(rng, dims),
                4..=6 => {
                    let c = rng.below(centers.len());
                    near(rng, &centers[c], 0.15)
                }
                7 | 8 => {
                    let i = rng.below(rows.len());
                    near(rng, &rows[i].1, 1e-4)
                }
                _ => rows[rng.below(rows.len())].1.clone(),
            };
            rows.push((id, v));
        }
        rows
    }

    fn queries(rng: &mut Rng, rows: &[(i64, Vec<f32>)], dims: usize) -> Vec<Vec<f32>> {
        let pick = |rng: &mut Rng| rows[rng.below(rows.len())].1.clone();
        let mut qs = vec![random_unit(rng, dims), random_unit(rng, dims)];
        for _ in 0..3 {
            qs.push(pick(rng));
        }
        let base = pick(rng);
        qs.push(near(rng, &base, 0.05));
        qs.push(pick(rng).iter().map(|x| -x).collect());
        qs
    }

    fn build(dims: usize, rows: &[(i64, Vec<f32>)]) -> (FlatIndex, Store) {
        let mut index = FlatIndex::new(dims);
        let mut store = Store::new();
        for (id, v) in rows {
            index.upsert(*id, v);
            store.insert(*id, v.clone());
        }
        (index, store)
    }

    /// Reference answer: exact `dot` over every stored vector, full sort, NaN dropped.
    fn brute(store: &Store, query: &[f32], n: usize, min: Option<f32>) -> Vec<(i64, f32)> {
        let mut all: Vec<(i64, f32)> = store
            .iter()
            .map(|(&id, v)| (id, dot(query, v)))
            .filter(|&(_, s)| !s.is_nan() && min.is_none_or(|m| s >= m))
            .collect();
        all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
        all.truncate(n);
        all
    }

    fn fetch_from(store: &Store, ids: &[i64]) -> Vec<(i64, Vec<f32>)> {
        assert!(!ids.is_empty() && ids.len() <= FETCH_BATCH, "fetch batch of {}", ids.len());
        ids.iter().filter_map(|&id| store.get(&id).map(|v| (id, v.clone()))).collect()
    }

    fn assert_same(got: &[(i64, f32)], want: &[(i64, f32)], ctx: &str) {
        let bits = |r: &[(i64, f32)]| r.iter().map(|&(id, s)| (id, s.to_bits())).collect::<Vec<_>>();
        assert_eq!(bits(got), bits(want), "{ctx}");
    }

    fn assert_sorted(cands: &[Candidate]) {
        for w in cands.windows(2) {
            let ok = w[0].upper > w[1].upper || (w[0].upper == w[1].upper && w[0].id < w[1].id);
            assert!(ok, "candidates out of order: {:?} then {:?}", w[0], w[1]);
        }
    }

    /// `search` equals brute force for every n, and `candidates` is a sorted superset of the top n.
    fn check(index: &FlatIndex, store: &Store, query: &[f32], ns: &[usize], min: Option<f32>, ctx: &str) {
        let full = brute(store, query, usize::MAX, min);
        let unfiltered = if min.is_none() { full.clone() } else { brute(store, query, usize::MAX, None) };
        for &n in ns {
            let got = index.search(query, n, min, |ids| fetch_from(store, ids));
            assert_same(&got, &full[..n.min(full.len())], &format!("{ctx} n={n} min={min:?}"));
            let cands = index.candidates(query, n);
            assert_sorted(&cands);
            let ids: HashSet<i64> = cands.iter().map(|c| c.id).collect();
            for (id, _) in unfiltered.iter().take(n) {
                assert!(ids.contains(id), "{ctx} n={n}: top id {id} missing from candidates");
            }
        }
    }

    #[test]
    fn matches_brute_force() {
        for (dims, count) in [(1, 300), (3, 1500), (64, 3000), (384, 1500), (1024, 1200)] {
            let mut rng = Rng::new(dims as u64);
            let rows = dataset(&mut rng, dims, count);
            let (index, store) = build(dims, &rows);
            assert_eq!(index.len(), count);
            for (qi, q) in queries(&mut rng, &rows, dims).iter().enumerate() {
                check(&index, &store, q, &[1, 5, 10, 100], None, &format!("dims={dims} q={qi}"));
            }
        }
    }

    #[test]
    fn matches_brute_force_after_mutations_and_compaction() {
        let dims = 48;
        let ns = [1, 5, 10, 100];
        let mut rng = Rng::new(7);
        let rows = dataset(&mut rng, dims, 6000);
        let (mut index, mut store) = build(dims, &rows);
        let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
        let qs = queries(&mut rng, &rows, dims);

        // Replace existing ids with new vectors, half of them pulled next to other rows.
        for i in 0..1500 {
            let id = ids[rng.below(ids.len())];
            let v = if i % 2 == 0 {
                random_unit(&mut rng, dims)
            } else {
                let other = rng.below(rows.len());
                near(&mut rng, &rows[other].1, 0.05)
            };
            index.upsert(id, &v);
            store.insert(id, v);
        }
        // Removes, repeated and absent ids included.
        for _ in 0..800 {
            let id = ids[rng.below(ids.len())];
            assert_eq!(index.remove(id), store.remove(&id).is_some());
        }
        let absent = (0..).find(|id| !store.contains_key(id)).unwrap();
        assert!(!index.remove(absent));
        // Fresh ids.
        for id in distinct_ids(&mut Rng::new(99), 500) {
            let v = random_unit(&mut rng, dims);
            index.upsert(id, &v);
            store.insert(id, v);
        }
        assert_eq!(index.len(), store.len());
        assert!(index.tombstones() > 0 && index.tombstones() < COMPACT_MIN_TOMBSTONES);
        for (qi, q) in qs.iter().enumerate() {
            check(&index, &store, q, &ns, None, &format!("mutated q={qi}"));
        }

        // Keep removing until compaction runs.
        let mut live: Vec<i64> = store.keys().copied().collect();
        live.sort_unstable();
        let mut compacted = false;
        while !compacted {
            let id = live.swap_remove(rng.below(live.len()));
            let before = index.tombstones();
            assert!(index.remove(id));
            store.remove(&id);
            compacted = index.tombstones() < before;
        }
        assert_eq!(index.tombstones(), 0);
        assert_eq!(index.len(), store.len());
        assert!(store.keys().all(|&id| index.contains(id)));
        for (qi, q) in qs.iter().enumerate() {
            check(&index, &store, q, &ns, None, &format!("compacted q={qi}"));
        }

        // More churn on the compacted layout.
        for i in 0..400 {
            let id = live[rng.below(live.len())];
            if i % 3 == 0 {
                assert_eq!(index.remove(id), store.remove(&id).is_some());
            } else {
                let v = random_unit(&mut rng, dims);
                index.upsert(id, &v);
                store.insert(id, v);
            }
        }
        assert_eq!(index.len(), store.len());
        for (qi, q) in qs.iter().enumerate() {
            check(&index, &store, q, &ns, None, &format!("churned q={qi}"));
        }

        // An explicit compaction changes nothing.
        let before: Vec<_> = qs.iter().map(|q| index.search(q, 10, None, |ids| fetch_from(&store, ids))).collect();
        assert!(index.tombstones() > 0);
        index.compact();
        assert_eq!(index.tombstones(), 0);
        for (q, b) in qs.iter().zip(&before) {
            assert_same(&index.search(q, 10, None, |ids| fetch_from(&store, ids)), b, "explicit compact");
        }
    }

    #[test]
    fn candidates_are_a_sorted_superset_and_bounds_hold() {
        let dims = 256;
        let mut rng = Rng::new(11);
        let centers: Vec<Vec<f32>> = (0..4).map(|_| random_unit(&mut rng, dims)).collect();
        let rows: Vec<(i64, Vec<f32>)> = (0..3000)
            .map(|i| (i as i64 * 3 - 4000, near(&mut rng, &centers[i % 4], 0.02)))
            .collect();
        let (index, store) = build(dims, &rows);
        let mut qs: Vec<Vec<f32>> = centers.iter().map(|c| near(&mut rng, c, 0.01)).collect();
        qs.extend((0..2).map(|_| random_unit(&mut rng, dims)));
        for (qi, q) in qs.iter().enumerate() {
            // n >= len returns every live row, which lets us check the bound on all of them.
            let every = index.candidates(q, usize::MAX);
            assert_eq!(every.len(), store.len());
            assert_sorted(&every);
            for c in &every {
                let s = f64::from(dot(q, &store[&c.id]));
                assert!(c.lower <= s && s <= c.upper, "bound broken for {c:?}: exact {s}");
                assert!(c.lower <= c.approx && c.approx <= c.upper);
            }
            let mut lowers: Vec<f64> = every.iter().map(|c| c.lower).collect();
            lowers.sort_by(|a, b| b.partial_cmp(a).unwrap());
            let exact = brute(&store, q, usize::MAX, None);
            for n in [1, 10, 50, 500] {
                let cands = index.candidates(q, n);
                assert_sorted(&cands);
                let ids: HashSet<i64> = cands.iter().map(|c| c.id).collect();
                assert!(exact[..n].iter().all(|(id, _)| ids.contains(id)), "q={qi} n={n}: not a superset");
                // Exactly the documented set: upper >= n-th largest lower.
                let tau = lowers[n - 1];
                let expected: HashSet<i64> = every.iter().filter(|c| c.upper >= tau).map(|c| c.id).collect();
                assert_eq!(ids, expected, "q={qi} n={n}");
            }
        }
    }

    /// Checks `lower <= dot <= upper` on every row, and that the error uses most of the bound.
    fn assert_bounds_tight(rows: &[(i64, Vec<f32>)], query: &[f32], ctx: &str) {
        let (index, store) = build(query.len(), rows);
        for c in index.candidates(query, usize::MAX) {
            let s = f64::from(dot(query, &store[&c.id]));
            assert!(c.lower <= s && s <= c.upper, "{ctx}: bound broken for {c:?}: exact {s}");
            let used = (s - c.approx).abs() / (c.upper - c.approx);
            assert!(used > 0.85, "{ctx}: only {used:.3} of the bound used, the case is not adversarial");
        }
    }

    #[test]
    fn bound_holds_where_cauchy_schwarz_is_attained() {
        for dims in [16usize, 384, 1024] {
            let mut rng = Rng::new(300 + dims as u64);
            // Integer direction k: quantizes without error (scale exactly 1).
            let mut k: Vec<f32> = (0..dims).map(|_| rng.below(255) as f32 - 127.0).collect();
            k[0] = 0.0;
            k[1] = 127.0;
            // A vector with int8 codes c and quantization error (almost exactly) sign * d * k:
            // v[0] = 0.9 pins the scale at s = 0.9 / 127 and |d * k_i| <= 0.45 s keeps the codes.
            // The values use the full f32 mantissa, so the f32 `dot` really rounds.
            let tilted = |rng: &mut Rng, max: usize, sign: f64| -> Vec<f32> {
                let s = f64::from(0.9f32 / 127.0);
                let d = s * 0.45 / 127.0;
                (0..dims)
                    .map(|i| {
                        if i == 0 {
                            return 0.9;
                        }
                        let c = rng.below(2 * max + 1) as f64 - max as f64;
                        (s * c + sign * d * f64::from(k[i])) as f32
                    })
                    .collect()
            };

            // x - r is parallel to the query k, which quantizes without error.
            let rows: Vec<(i64, Vec<f32>)> = (0..40)
                .map(|i| (i, tilted(&mut rng, 126, if i % 2 == 0 { 1.0 } else { -1.0 })))
                .collect();
            assert_bounds_tight(&rows, &k, &format!("dims={dims} row error"));

            // q - q~ is parallel to the rows ±k, which quantize without error.
            let rows: Vec<(i64, Vec<f32>)> = vec![(0, k.clone()), (1, k.iter().map(|x| -x).collect())];
            for i in 0..20 {
                let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
                let q = tilted(&mut rng, 100, sign);
                assert_bounds_tight(&rows, &q, &format!("dims={dims} query error i={i}"));
            }
        }
    }

    #[test]
    fn min_score_matches_brute_force() {
        let dims = 128;
        let mut rng = Rng::new(5);
        let rows = dataset(&mut rng, dims, 2500);
        let (index, store) = build(dims, &rows);
        for (qi, q) in queries(&mut rng, &rows, dims).iter().enumerate() {
            let exact = brute(&store, q, usize::MAX, None);
            // Thresholds equal to real scores check that score == min is kept.
            let mut mins = vec![-2.0, -0.5, 0.0, 0.3, 0.9, 0.999, 1.0, 2.0, f32::NAN];
            mins.extend([exact[2].1, exact[19].1, exact[200].1]);
            for min in mins {
                check(&index, &store, q, &[1, 5, 10, 100], Some(min), &format!("q={qi}"));
            }
            let got = index.search(q, 10, Some(2.0), |_| panic!("fetch despite an unreachable min_score"));
            assert!(got.is_empty());
        }
    }

    #[test]
    fn empty_index_and_zero_n() {
        let mut index = FlatIndex::new(4);
        let q = [0.5f32, 0.5, 0.5, 0.5];
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
        assert_eq!(index.dims(), 4);
        assert!(index.candidates(&q, 5).is_empty());
        assert!(index.search(&q, 5, None, |_| panic!("fetch on an empty index")).is_empty());
        assert!(rescore_exact(&q, &[], 5, None, |_| panic!("fetch without candidates")).is_empty());
        index.upsert(1, &q);
        assert!(index.candidates(&q, 0).is_empty());
        assert!(index.search(&q, 0, None, |_| panic!("fetch with n = 0")).is_empty());
        let cands = index.candidates(&q, 1);
        assert_eq!(cands.len(), 1);
        assert!(rescore_exact(&q, &cands, 0, None, |_| panic!("fetch with n = 0")).is_empty());
    }

    #[test]
    fn n_larger_than_len_returns_everything_in_order() {
        let dims = 10;
        let mut rng = Rng::new(3);
        let rows = dataset(&mut rng, dims, 40);
        let (index, store) = build(dims, &rows);
        let q = random_unit(&mut rng, dims);
        let got = index.search(&q, 1000, None, |ids| fetch_from(&store, ids));
        assert_eq!(got.len(), 40);
        assert_same(&got, &brute(&store, &q, usize::MAX, None), "n > len");
        assert_eq!(index.candidates(&q, 1000).len(), 40);
    }

    #[test]
    fn dims_one() {
        let mut rng = Rng::new(1);
        let rows: Vec<(i64, Vec<f32>)> = (0..200i64)
            .map(|i| {
                let x = match i % 7 {
                    0 => 0.0,
                    1 | 2 => 1.0,
                    3 => -1.0,
                    _ => (rng.gauss() * 10.0) as f32,
                };
                (i - 100, vec![x])
            })
            .collect();
        let (index, store) = build(1, &rows);
        for q in [1.0f32, -1.0, 0.25, 0.0, -3.5, 1e-30] {
            for min in [None, Some(0.0), Some(1.0)] {
                check(&index, &store, &[q], &[1, 5, 10, 100, 500], min, &format!("q={q}"));
            }
        }
    }

    #[test]
    fn zero_and_tiny_vectors_stay_exact() {
        let dims = 24;
        let mut rng = Rng::new(9);
        let mut rows = dataset(&mut rng, dims, 60);
        rows.extend((0..10).map(|i| (10_000 + i, vec![0.0; dims])));
        // Subnormal values: from_bits(7) makes the f32 scale underflow to 0, from_bits(700) does not.
        for i in 0..6 {
            let mut v = vec![0.0f32; dims];
            v[i] = f32::from_bits(if i % 2 == 0 { 7 } else { 700 });
            v[i + 1] = -f32::from_bits(5);
            rows.push((20_000 + i as i64, v));
        }
        let (index, store) = build(dims, &rows);
        let mut qs = queries(&mut rng, &rows, dims);
        qs.push(vec![0.0; dims]);
        qs.push(rows[rows.len() - 1].1.clone());
        let mut tiny = vec![0.0f32; dims];
        tiny[0] = f32::from_bits(9);
        qs.push(tiny);
        for (qi, q) in qs.iter().enumerate() {
            for min in [None, Some(0.0)] {
                check(&index, &store, q, &[1, 5, 10, 100], min, &format!("q={qi}"));
            }
        }
        // A zero query scores every row 0.0, so the smallest ids win.
        let got = index.search(&vec![0.0; dims], 5, None, |ids| fetch_from(&store, ids));
        let mut all_ids: Vec<i64> = store.keys().copied().collect();
        all_ids.sort_unstable();
        assert_eq!(got.iter().map(|r| r.0).collect::<Vec<_>>(), all_ids[..5]);
        assert!(got.iter().all(|r| r.1.to_bits() == 0));
    }

    #[test]
    fn non_normalized_vectors_stay_exact() {
        let mags = [1e-40f64, 1e-30, 1e-12, 1e-3, 0.5, 1.0, 3.0, 1e3, 1e6, 1e12, 1e15];
        for dims in [2, 7, 33, 200] {
            let mut rng = Rng::new(100 + dims as u64);
            let rows: Vec<(i64, Vec<f32>)> = distinct_ids(&mut rng, 600)
                .into_iter()
                .enumerate()
                .map(|(i, id)| {
                    let mut v = random_unit(&mut rng, dims);
                    match i % 4 {
                        0 => {}
                        1 => v.iter_mut().skip(1).for_each(|x| *x *= 1e-3),
                        2 => v.iter_mut().enumerate().for_each(|(j, x)| {
                            if j % 3 != 0 {
                                *x = 0.0
                            }
                        }),
                        _ => v.iter_mut().for_each(|x| *x = (*x * 8.0).round() / 8.0),
                    }
                    let mag = mags[i % mags.len()];
                    (id, v.iter().map(|&x| (f64::from(x) * mag) as f32).collect())
                })
                .collect();
            let (index, store) = build(dims, &rows);
            let mut qs: Vec<Vec<f32>> = [1e-6f32, 1.0, 1e4]
                .iter()
                .map(|&m| random_unit(&mut rng, dims).iter().map(|x| x * m).collect())
                .collect();
            qs.push(rows[8].1.clone());
            qs.push(rows[9].1.clone());
            qs.push(vec![0.0; dims]);
            for (qi, q) in qs.iter().enumerate() {
                for min in [None, Some(0.0)] {
                    check(&index, &store, q, &[1, 5, 10, 100], min, &format!("dims={dims} q={qi}"));
                }
            }
        }
    }

    #[test]
    fn overflowing_and_non_finite_values_stay_exact() {
        let dims = 8;
        let mut rng = Rng::new(31);
        let mut rows: Vec<(i64, Vec<f32>)> = (0..300i64)
            .map(|id| {
                let mag = [1.0f32, 1e17, 1e18, 1e19, 1e20, 3e37][id as usize % 6];
                (id, random_unit(&mut rng, dims).iter().map(|x| x * mag).collect())
            })
            .collect();
        rows.push((1000, vec![f32::INFINITY; dims]));
        let mut with_nan = vec![0.5; dims];
        with_nan[3] = f32::NAN;
        rows.push((1001, with_nan));
        let mut with_neg_inf = vec![0.0; dims];
        with_neg_inf[0] = f32::NEG_INFINITY;
        rows.push((1002, with_neg_inf));
        rows.push((1003, vec![f32::MAX; dims]));
        let (index, store) = build(dims, &rows);

        let mut qs: Vec<Vec<f32>> = [1e20f32, 1.0, 1e-3]
            .iter()
            .map(|&m| random_unit(&mut rng, dims).iter().map(|x| x * m).collect())
            .collect();
        qs.push(rows[4].1.clone());
        let mut inf_query = random_unit(&mut rng, dims);
        inf_query[2] = f32::INFINITY;
        qs.push(inf_query);
        for (qi, q) in qs.iter().enumerate() {
            for min in [None, Some(0.0), Some(f32::INFINITY), Some(f32::NEG_INFINITY)] {
                check(&index, &store, q, &[1, 3, 10, 50, 400], min, &format!("q={qi}"));
            }
        }
        // A NaN in the query makes every score NaN: nothing comes back and nothing is fetched.
        let mut nan_query = random_unit(&mut rng, dims);
        nan_query[0] = f32::NAN;
        assert!(index.candidates(&nan_query, 10).is_empty());
        assert!(index.search(&nan_query, 10, None, |_| panic!("fetch for a NaN query")).is_empty());
        assert!(brute(&store, &nan_query, 10, None).is_empty());
    }

    #[test]
    fn ids_missing_from_fetch_are_skipped() {
        let dims = 32;
        let mut rng = Rng::new(13);
        let rows = dataset(&mut rng, dims, 1000);
        let (index, store) = build(dims, &rows);
        let q = rows[17].1.clone();
        let cands = index.candidates(&q, 10);

        // The three best rows were deleted between candidates() and the fetch.
        let gone: HashSet<i64> = brute(&store, &q, 3, None).iter().map(|r| r.0).collect();
        let got = rescore_exact(&q, &cands, 10, None, |ids| {
            fetch_from(&store, ids).into_iter().filter(|(id, _)| !gone.contains(id)).collect()
        });
        assert_eq!(got.len(), 10);
        assert!(got.iter().all(|(id, _)| !gone.contains(id)));
        let survivors: Store = cands
            .iter()
            .filter(|c| !gone.contains(&c.id))
            .map(|c| (c.id, store[&c.id].clone()))
            .collect();
        assert_same(&got, &brute(&survivors, &q, 10, None), "deleted rows skipped");
        assert!(rescore_exact(&q, &cands, 10, None, |_| Vec::new()).is_empty());

        // Unknown ids, duplicates and wrong-length vectors are ignored.
        let unknown = (0..).find(|id| !store.contains_key(id)).unwrap();
        let messy = rescore_exact(&q, &cands, 10, None, |ids| {
            let mut out = vec![(ids[0], vec![0.5; 3]), (unknown, vec![1.0; dims])];
            out.extend(fetch_from(&store, ids));
            out.extend(fetch_from(&store, ids));
            out
        });
        assert_same(&messy, &brute(&store, &q, 10, None), "messy fetch");
    }

    #[test]
    fn early_termination_prunes_fetches() {
        let dims = 384;
        let mut rng = Rng::new(21);
        let target = random_unit(&mut rng, dims);
        let mut rows: Vec<(i64, Vec<f32>)> = (0..5).map(|i| (i, near(&mut rng, &target, 0.05))).collect();
        rows.extend((5..4000).map(|i| (i, random_unit(&mut rng, dims))));
        let (index, store) = build(dims, &rows);
        let want = brute(&store, &target, 5, None);

        // Every row as a candidate: only the early stop keeps rescore_exact from fetching them all.
        let every = index.candidates(&target, usize::MAX);
        assert_eq!(every.len(), 4000);
        let mut asked = 0;
        let got = rescore_exact(&target, &every, 5, None, |ids| {
            asked += ids.len();
            fetch_from(&store, ids)
        });
        assert_same(&got, &want, "rescore over every row");
        assert!(asked <= FETCH_BATCH, "asked for {asked} of 4000 ids");

        let mut asked = 0;
        let got = index.search(&target, 5, None, |ids| {
            asked += ids.len();
            fetch_from(&store, ids)
        });
        assert_same(&got, &want, "search");
        assert!(asked <= FETCH_BATCH, "search asked for {asked} ids");
        assert!(index.candidates(&target, 5).len() < 40);
    }

    #[test]
    fn exact_ties_break_by_id() {
        let dims = 16;
        let mut rng = Rng::new(17);
        let v = random_unit(&mut rng, dims);
        let ids = distinct_ids(&mut rng, 400);
        let mut rows: Vec<(i64, Vec<f32>)> = ids[..300].iter().map(|&id| (id, v.clone())).collect();
        rows.extend(ids[300..].iter().map(|&id| (id, random_unit(&mut rng, dims))));
        let (index, store) = build(dims, &rows);
        let got = index.search(&v, 10, None, |ids| fetch_from(&store, ids));
        let mut dup_ids = ids[..300].to_vec();
        dup_ids.sort_unstable();
        assert_eq!(got.iter().map(|r| r.0).collect::<Vec<_>>(), dup_ids[..10]);
        let s = dot(&v, &v);
        assert!(got.iter().all(|r| r.1.to_bits() == s.to_bits()));
        check(&index, &store, &v, &[1, 10, 299, 300, 301], None, "ties");
    }

    #[test]
    fn parallel_scan_matches_single_thread() {
        let dims = 512;
        let count = PARALLEL_MIN_CODES / dims + 1500;
        let mut rng = Rng::new(41);
        let rows = dataset(&mut rng, dims, count);
        let (mut index, mut store) = build(dims, &rows);
        for (id, _) in rows.iter().step_by(37) {
            assert!(index.remove(*id));
            store.remove(id);
        }
        assert!(index.tombstones() > 0);
        for (qi, q) in queries(&mut rng, &rows, dims).iter().take(4).enumerate() {
            for n in [1, 10, 100] {
                let single = index.candidates_with(q, n, 1);
                for threads in [2, 3, 8] {
                    assert_eq!(index.candidates_with(q, n, threads), single, "q={qi} n={n} threads={threads}");
                }
                assert_eq!(index.candidates(q, n), single);
            }
            check(&index, &store, q, &[10], None, &format!("parallel q={qi}"));
        }
    }

    #[test]
    fn upsert_replaces_in_place_and_remove_reports_presence() {
        let mut index = FlatIndex::new(3);
        index.upsert(7, &[1.0, 0.0, 0.0]);
        index.upsert(7, &[0.0, 1.0, 0.0]);
        assert_eq!(index.len(), 1);
        assert_eq!(index.tombstones(), 0);
        assert!(index.contains(7));
        assert!(index.candidates(&[0.0, 1.0, 0.0], 1)[0].approx > 0.99);
        let store: Store = [(7, vec![0.0, 1.0, 0.0])].into_iter().collect();
        let got = index.search(&[0.0, 1.0, 0.0], 3, None, |ids| fetch_from(&store, ids));
        assert_eq!(got, vec![(7, 1.0)]);
        assert!(!index.remove(8));
        assert!(index.remove(7));
        assert!(!index.remove(7));
        assert!(!index.contains(7));
        assert!(index.is_empty());
        assert_eq!(format!("{index:?}"), "FlatIndex { dims: 3, len: 0, tombstones: 0, segments: 0 }");
    }

    #[test]
    fn clear_resets_and_the_index_stays_usable() {
        let dims = 20;
        let mut rng = Rng::new(47);
        let rows = dataset(&mut rng, dims, 500);
        let (mut index, _) = build(dims, &rows);
        index.clear();
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
        assert_eq!(index.tombstones(), 0);
        assert!(!index.contains(rows[0].0));
        let q = random_unit(&mut rng, dims);
        assert!(index.candidates(&q, 10).is_empty());
        let mut store = Store::new();
        for (id, v) in dataset(&mut rng, dims, 300) {
            index.upsert(id, &v);
            store.insert(id, v);
        }
        check(&index, &store, &q, &[1, 10, 100], None, "after clear");
    }

    #[test]
    fn memory_accounting_tracks_rows() {
        let dims = 256;
        let mut rng = Rng::new(43);
        let mut index = FlatIndex::new(dims);
        let empty = index.memory_bytes();
        let v = random_unit(&mut rng, dims);
        for id in 0..5000 {
            index.upsert(id, &v);
        }
        let used = index.memory_bytes();
        assert!(used >= 5000 * dims, "{used}");
        assert!(used <= 5000 * dims * 3 / 2 + 5000 * 64, "{used}");
        index.clear();
        assert_eq!(index.memory_bytes(), empty);
    }

    #[test]
    fn l2_normalize_cases() {
        let mut zero = vec![0.0f32; 4];
        assert!(!l2_normalize(&mut zero));
        assert_eq!(zero, vec![0.0; 4]);
        let mut nan = vec![1.0, f32::NAN, 2.0];
        assert!(!l2_normalize(&mut nan));
        assert!(nan[0] == 1.0 && nan[1].is_nan() && nan[2] == 2.0);
        let mut inf = vec![1.0, f32::INFINITY];
        assert!(!l2_normalize(&mut inf));
        assert_eq!(inf, vec![1.0, f32::INFINITY]);
        assert!(!l2_normalize(&mut []));

        let mut v = vec![3.0f32, 4.0];
        assert!(l2_normalize(&mut v));
        assert!((v[0] - 0.6).abs() < 1e-7 && (v[1] - 0.8).abs() < 1e-7);
        let mut rng = Rng::new(53);
        for dims in [1, 5, 384, 1024] {
            let mut v: Vec<f32> = (0..dims).map(|_| (rng.gauss() * 1e3) as f32).collect();
            assert!(l2_normalize(&mut v));
            let norm = v.iter().map(|&x| f64::from(x) * f64::from(x)).sum::<f64>().sqrt();
            assert!((norm - 1.0).abs() < 1e-6, "dims={dims} norm={norm}");
        }
        let mut tiny = vec![f32::from_bits(3), 0.0, 0.0];
        assert!(l2_normalize(&mut tiny));
        assert_eq!(tiny, vec![1.0, 0.0, 0.0]);
        let mut huge = vec![f32::MAX, -f32::MAX];
        assert!(l2_normalize(&mut huge));
        assert!((huge[0] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6 && huge[1] == -huge[0]);
    }

    #[test]
    fn dot_matches_an_f64_reference() {
        let mut rng = Rng::new(59);
        for len in (0..70).chain([255, 256, 257, 1023, 1024, 1025]) {
            let a: Vec<f32> = (0..len).map(|_| rng.gauss() as f32).collect();
            let b: Vec<f32> = (0..len).map(|_| rng.gauss() as f32).collect();
            let exact: f64 = a.iter().zip(&b).map(|(&x, &y)| f64::from(x) * f64::from(y)).sum();
            let abs: f64 = a.iter().zip(&b).map(|(&x, &y)| (f64::from(x) * f64::from(y)).abs()).sum();
            let err = (f64::from(dot(&a, &b)) - exact).abs();
            assert!(err <= len as f64 * f64::from(f32::EPSILON) * abs, "len={len} err={err}");
        }
        assert_eq!(dot(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]), 14.0);
        assert_eq!(dot(&[], &[]), 0.0);
        assert_eq!(dot_i8(&vec![127; MAX_DIMS], &vec![-127; MAX_DIMS]), -127 * 127 * MAX_DIMS as i32);
    }

    fn timing(samples: &[Duration]) -> String {
        let mut ms: Vec<f64> = samples.iter().map(|d| d.as_secs_f64() * 1e3).collect();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        format!("median {:.2} ms, max {:.2} ms", ms[ms.len() / 2], ms[ms.len() - 1])
    }

    /// Release timings for 100k x 1024: `--ignored --nocapture perf`.
    #[test]
    #[ignore]
    fn perf_100k_x_1024() {
        let (count, dims) = (100_000usize, 1024usize);
        let mut rng = Rng::new(2024);
        let centers: Vec<Vec<f32>> = (0..2000).map(|_| random_unit(&mut rng, dims)).collect();
        let mut data = vec![0f32; count * dims];
        for (i, row) in data.chunks_exact_mut(dims).enumerate() {
            row.copy_from_slice(&near(&mut rng, &centers[i % centers.len()], 1.0));
        }
        let t = Instant::now();
        let mut index = FlatIndex::new(dims);
        for (i, row) in data.chunks_exact(dims).enumerate() {
            index.upsert(i as i64, row);
        }
        println!(
            "build: {count} x {dims} in {:?}, index ~{} MiB",
            t.elapsed(),
            index.memory_bytes() >> 20
        );

        let fetch = |ids: &[i64]| -> Vec<(i64, Vec<f32>)> {
            ids.iter().map(|&id| (id, data[id as usize * dims..(id as usize + 1) * dims].to_vec())).collect()
        };
        let queries: Vec<Vec<f32>> = (0..20)
            .map(|i| if i % 2 == 0 { near(&mut rng, &centers[i * 37], 0.8) } else { random_unit(&mut rng, dims) })
            .collect();
        for n in [10, 100] {
            let (mut scan, mut scan_one, mut search) = (Vec::new(), Vec::new(), Vec::new());
            let (mut cands, mut fetched) = (0, 0);
            for q in &queries {
                let t = Instant::now();
                cands += index.candidates(q, n).len();
                scan.push(t.elapsed());
                let t = Instant::now();
                let one = index.candidates_with(q, n, 1);
                scan_one.push(t.elapsed());
                assert!(one.len() >= n);
                let t = Instant::now();
                let got = index.search(q, n, None, |ids| {
                    fetched += ids.len();
                    fetch(ids)
                });
                search.push(t.elapsed());
                assert_eq!(got.len(), n);
            }
            let per_query = |x: usize| x as f64 / queries.len() as f64;
            println!("n={n}: scan {} | scan 1 thread {}", timing(&scan), timing(&scan_one));
            println!(
                "n={n}: search {} | avg candidates {:.1}, avg fetched {:.1}",
                timing(&search),
                per_query(cands),
                per_query(fetched)
            );
        }

        let q = &queries[0];
        let t = Instant::now();
        let mut all: Vec<(i64, f32)> = data.chunks_exact(dims).enumerate().map(|(i, row)| (i as i64, dot(q, row))).collect();
        all.sort_unstable_by(result_order);
        all.truncate(10);
        println!("brute force, 1 thread incl. sort: {:?}", t.elapsed());
        assert_same(&index.search(q, 10, None, fetch), &all, "perf brute force");
    }
}
