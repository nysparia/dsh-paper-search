// lib/peta.js — citation structure: bibliographic coupling, co-citation,
// clustering, and bridges between clusters (upstream issue #122).
//
// This ENTIRE file is PURE: no network, no files. Everything comes in as a list
// of works that already have `referenced_works`, everything goes out as
// numbers/lists. That is deliberate — the part most easily wrong here is the
// math, and the math must be testable without an API.
//
// TERMS, so they do not get mixed up:
//   • Bibliographic coupling = two works are SAID to be similar because they cite
//     the SAME references. Based on what they wrote.
//   • Co-citation = two references are named TOGETHER by another work. Based on who
//     cites them. It needs a third party, so it cannot be computed per work.
//   • Bridge = a work that connects two groups that would otherwise be separate.

/** Short OpenAlex id from a `referenced_works` entry (URL) or a bare id. */
export function shortId(x) {
  return String(x ?? '').split('/').pop() || null;
}

/**
 * Map of work id -> set of its reference ids.
 * Works without a reference list still enter with an EMPTY set — "has no
 * recorded references" differs from "is not in the map", and the difference must
 * stay visible to the caller.
 */
export function referenceSets(works) {
  const map = new Map();
  for (const w of works ?? []) {
    const id = shortId(w?.id);
    if (!id) continue;
    const refs = new Set((w?.referenced_works ?? []).map(shortId).filter(Boolean));
    map.set(id, refs);
  }
  return map;
}

/** Cosine similarity between two sets (0..1). Empty set -> 0. */
export function coupling(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let same = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) same++;
  return same / Math.sqrt(a.size * b.size);
}

/** How many references two sets share. */
export function sharedCount(a, b) {
  if (!a || !b) return 0;
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n++;
  return n;
}

/**
 * How close each candidate is to the SEED work (coupling to the seed's reference
 * list). Sorted descending. This is "who is most in the same field as this
 * paper", computed from references — not from keywords.
 */
export function closenessToSeed(works, seedRefs) {
  const map = referenceSets(works);
  return (works ?? [])
    .map((w) => {
      const id = shortId(w?.id);
      const refs = map.get(id) ?? new Set();
      return {
        id,
        title: w?.title ?? null,
        year: w?.publication_year ?? null,
        // `Number(null)` is 0, so the obvious guard reports "0 citations" for a
        // work whose count OpenAlex did not state. Same bug as in
        // `detailOfWork`; fixed 23 Nov 2026.
        citedBy: w?.cited_by_count === null || w?.cited_by_count === undefined || w?.cited_by_count === ''
          ? null
          : (Number.isFinite(Number(w.cited_by_count)) ? Number(w.cited_by_count) : null),
        refs: refs.size,
        shared: sharedCount(refs, seedRefs),
        coupling: coupling(refs, seedRefs),
      };
    })
    .sort((a, b) => (b.coupling - a.coupling) || (a.id ?? '').localeCompare(b.id ?? ''));
}

/**
 * Co-citation: for each seed reference, how many candidates CITE it.
 * The highest = the shared foundation of this field (most often named together).
 *
 * Deliberately returns ALL seed references (including the zero ones) so the caller
 * can tell "nothing cites it together" apart from "not counted".
 */
export function coCitation(works, seedRefs) {
  const count = new Map();
  const refArr = [...(seedRefs ?? [])];
  for (const r of refArr) count.set(r, 0);
  for (const w of works ?? []) {
    const refs = new Set((w?.referenced_works ?? []).map(shortId).filter(Boolean));
    for (const r of refArr) if (refs.has(r)) count.set(r, (count.get(r) ?? 0) + 1);
  }
  return refArr
    .map((id) => ({ id, by: count.get(id) ?? 0 }))
    .sort((a, b) => (b.by - a.by) || a.id.localeCompare(b.id));
}

/**
 * Group candidates into clusters: two candidates are considered connected when
 * they share >= `minShared` references AND their cosine is >= `threshold`.
 *
 * Two conditions, not one, because each has a hole: cosine alone
 * connects works with very short reference lists (1 shared reference
 * = high cosine), while shared-count alone connects large works
 * that happen to overlap in a long list. The thresholds are RETURNED so the
 * report can mention them — a number that is not mentioned is a number that
 * cannot be checked.
 *
 * Uses a simple union-find; the return is deterministic (clusters sorted
 * by size then smallest id) so outputs can be compared.
 */
export function clusterWorks(works, { threshold = 0.05, minShared = 2 } = {}) {
  const map = referenceSets(works);
  const ids = [...map.keys()].sort();
  const parent = new Map(ids.map((id) => [id, id]));

  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // path compression
    let k = x;
    while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  const neighbors = new Map(ids.map((id) => [id, new Set()]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = map.get(ids[i]);
      const b = map.get(ids[j]);
      if (sharedCount(a, b) < minShared) continue;
      if (coupling(a, b) < threshold) continue;
      union(ids[i], ids[j]);
      neighbors.get(ids[i]).add(ids[j]);
      neighbors.get(ids[j]).add(ids[i]);
    }
  }

  const byRoot = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(id);
  }
  const clusters = [...byRoot.values()].sort((a, b) => (b.length - a.length) || a[0].localeCompare(b[0]));
  const index = new Map();
  clusters.forEach((members, i) => members.forEach((id) => index.set(id, i)));
  return { clusters, neighbors, index, threshold, minShared };
}

/**
 * Bridge: a work that connects clusters that WOULD BE separate IF IT WERE NOT
 * THERE.
 *
 * ⚠️ This CANNOT be computed from a single clustering alone — and I once wrote
 * that wrong: with union-find, a bridge actually MERGES the two clusters,
 * so "a neighbor in another cluster" would never exist. The
 * `test-citation-map.mjs` test caught it. That is why **two levels** are used:
 *
 *   1. clusters are computed at the STRICT threshold (links must be strong);
 *   2. bridge = a work that at the LOOSE threshold connects to members of
 *      >= `minOtherClusters` DIFFERENT strict clusters.
 *
 * So a work is called a bridge only when it "almost" belongs to two fields
 * at once — not because it is genuinely a strong part of one of them.
 */
export function findBridges(works, {
  strongThreshold = 0.15, minSharedStrong = 3,
  weakThreshold = 0.05, minSharedWeak = 2,
  minOtherClusters = 2,
  reasonableRefLimit = 300,
} = {}) {
  const strict = clusterWorks(works, { threshold: strongThreshold, minShared: minSharedStrong });
  const map = referenceSets(works);
  const ids = [...map.keys()].sort();
  const out = [];

  for (const id of ids) {
    const ownRefs = map.get(id) ?? new Set();
    const otherClusters = new Set();
    let degree = 0;
    for (const other of ids) {
      if (other === id) continue;
      if (sharedCount(ownRefs, map.get(other)) < minSharedWeak) continue;
      if (coupling(ownRefs, map.get(other)) < weakThreshold) continue;
      degree++;
      const n = strict.index.get(other);
      if (n !== undefined && n !== strict.index.get(id)) otherClusters.add(n);
    }
    if (otherClusters.size >= minOtherClusters) {
      out.push({
        id,
        otherClusters: otherClusters.size,
        degree,
        refs: ownRefs.size,
        // CONTAINER records (proceedings, conference bundles) have very long
        // reference lists so they end up close to almost everything. Measured
        // 2 Oct 2026: one "Proceedings of the 43rd ACM SIGIR…" record appeared
        // as a bridge of 29 clusters — clearly not a finding, but an artifact.
        // Flagged, not silently dropped, so the reader can judge it.
        suspicious: ownRefs.size > reasonableRefLimit,
      });
    }
  }

  return {
    bridges: out.sort((a, b) => (b.otherClusters - a.otherClusters) || (b.degree - a.degree) || a.id.localeCompare(b.id)),
    strongClusters: strict,
    strongThreshold, minSharedStrong, weakThreshold, minSharedWeak, reasonableRefLimit,
  };
}

/**
 * Will this map be USEFUL, or only produce empty output?
 *
 * Real incident 2 Oct 2026: the map was run on a recently published Indonesian
 * journal article — OpenAlex recorded **0 references** for its seed and only **2
 * citing** works. The entire map section was empty, and output containing only "0"
 * made its user think the tool was broken.
 *
 * Two conditions, and the second matters: if the seed has NO references but the
 * candidates are many, clustering AMONG CANDIDATES is still meaningful — what is
 * lost is only closeness to the seed. So the map is called not useful only when the
 * seed references are empty **and** the candidates are also few.
 */
export function mapIsUseful({ seedRefs = 0, candidates = 0, minCandidates = 5 } = {}) {
  if (seedRefs > 0) return { useful: true };
  if (candidates >= minCandidates) return { useful: true };
  return { useful: false, seedRefs, candidates, minCandidates };
}

/** Numeric summary of one cluster, for reporting without flooding the output. */
export function summarizeCluster(works, cluster) {
  const byId = new Map((works ?? []).map((w) => [shortId(w?.id), w]));
  const members = cluster.map((id) => byId.get(id)).filter(Boolean);
  const citations = members.map((w) => Number(w?.cited_by_count) || 0);
  const years = members.map((w) => Number(w?.publication_year) || 0).filter((t) => t > 1500);
  return {
    size: cluster.length,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    totalCitations: citations.reduce((a, b) => a + b, 0),
    top: members
      .slice()
      .sort((a, b) => (Number(b?.cited_by_count) || 0) - (Number(a?.cited_by_count) || 0))
      .slice(0, 5),
  };
}
