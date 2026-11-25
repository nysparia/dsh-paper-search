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

/**
 * Short OpenAlex id from a `referenced_works` entry (URL) or a bare id.
 *
 * Trailing slashes and surrounding whitespace are stripped BEFORE the last
 * segment is taken. Measured 24 Nov 2026: `shortId('https://openalex.org/W123/')`
 * returned `null`, so a candidate whose id came back with a trailing slash was
 * dropped from the map while the caller still counted it as "checked" — three of
 * four works vanished from a probe run with nothing said. `shortId('   ')`
 * returned `'   '`, a truthy value that became a real cluster member.
 */
export function shortId(x) {
  return String(x ?? '').trim().replace(/\/+$/, '').split('/').pop() || null;
}

/**
 * Code-point comparison — deliberately NOT `localeCompare`.
 *
 * `localeCompare` orders by the process's ICU locale: measured 24 Nov 2026,
 * `['W1','W10','W100','W2','w5','W5','W9'].sort(localeCompare)` gives
 * `W1 W10 W100 W2 w5 W5 W9` while code points give `W1 W10 W100 W2 W5 W9 w5`,
 * and under `LANG=sv_SE` the same list starts `W1 W10 W2 z ä` versus
 * `ä W1 W10 W2 z` under `LANG=C`. The doc comment below promises a deterministic
 * order; this is what makes that promise unconditional.
 */
function cmpId(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A count OpenAlex reported, or `null` when it did not report one. */
function workNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map of work id -> set of its reference ids, PLUS the records that could not be
 * mapped at all.
 *
 * Works without a reference list still enter with an EMPTY set — "has no
 * recorded references" differs from "is not in the map", and the difference must
 * stay visible to the caller. A work with NO usable id is a third case: it cannot
 * enter the map at all, so it is returned in `dropped` instead of disappearing.
 * Measured 24 Nov 2026: 4 works in, map size 1, and the reply still said
 * "candidates checked: 4".
 */
export function referenceSetsDetailed(works) {
  const map = new Map();
  const dropped = [];
  for (const w of works ?? []) {
    const id = shortId(w?.id);
    if (!id) { dropped.push(w?.id ?? null); continue; }
    const refs = new Set((w?.referenced_works ?? []).map(shortId).filter(Boolean));
    map.set(id, refs);
  }
  return { map, dropped };
}

/** Map of work id -> set of its reference ids. See `referenceSetsDetailed`. */
export function referenceSets(works) {
  return referenceSetsDetailed(works).map;
}

/**
 * The seed's reference list with the seed's OWN id removed.
 *
 * A work is not a reference of itself. Measured 24 Nov 2026: a seed whose
 * `referenced_works` contained its own id produced `[1.000] The seed (4 shared of
 * 4)` as the top "most in the same field" hit and `[2x]` for references only one
 * other work cites — tautologies presented as findings, and maximally confident
 * ones. The audit sampled 205 live OpenAlex works and found 0 self-citing
 * records, so this is rare; it is guarded because when it happens nothing else
 * in the output is trustworthy.
 */
function refsWithoutSeed(seedRefs, seedId) {
  const out = new Set();
  for (const r of seedRefs ?? []) {
    if (seedId !== null && seedId !== undefined && String(r) === String(seedId)) continue;
    out.add(r);
  }
  return out;
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
 *
 * `seedId` is the seed's own id. The seed is the thing being compared AGAINST,
 * not a candidate, so its own record is skipped when it appears in `works` (it
 * does in `direction: 'references'`, where the candidate list IS the seed's
 * reference list) and its own id is removed from `seedRefs`. Measured 24 Nov
 * 2026: without this, the seed ranked #1 at coupling 1.000 against itself.
 */
export function closenessToSeed(works, seedRefs, { seedId = null } = {}) {
  const map = referenceSets(works);
  const refs0 = refsWithoutSeed(seedRefs, seedId);
  return (works ?? [])
    .filter((w) => seedId === null || seedId === undefined || shortId(w?.id) !== String(seedId))
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
        shared: sharedCount(refs, refs0),
        coupling: coupling(refs, refs0),
      };
    })
    .sort((a, b) => (b.coupling - a.coupling) || cmpId(a.id, b.id));
}

/**
 * Co-citation: for each seed reference, how many candidates CITE it.
 * The highest = the shared foundation of this field (most often named together).
 *
 * Deliberately returns ALL seed references (including the zero ones) so the caller
 * can tell "nothing cites it together" apart from "not counted".
 *
 * `seedRefs` is DEDUPLICATED first (measured 24 Nov 2026: an array with `r1`
 * twice produced 3 rows for 2 distinct references), the seed's own id is removed
 * from it, and the seed's own record is skipped as a citer — see
 * `closenessToSeed`. The comparator stringifies the id, because `seedRefs` is
 * caller-supplied and a non-string entry used to throw
 * `a.id.localeCompare is not a function`.
 */
export function coCitation(works, seedRefs, { seedId = null } = {}) {
  const count = new Map();
  const refArr = [...refsWithoutSeed(new Set(seedRefs ?? []), seedId)];
  for (const r of refArr) count.set(r, 0);
  for (const w of works ?? []) {
    if (seedId !== null && seedId !== undefined && shortId(w?.id) === String(seedId)) continue;
    const refs = new Set((w?.referenced_works ?? []).map(shortId).filter(Boolean));
    for (const r of refArr) if (refs.has(r)) count.set(r, (count.get(r) ?? 0) + 1);
  }
  return refArr
    .map((id) => ({ id, by: count.get(id) ?? 0 }))
    .sort((a, b) => (b.by - a.by) || cmpId(a.id, b.id));
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
  const clusters = [...byRoot.values()].sort((a, b) => (b.length - a.length) || cmpId(a[0], b[0]));
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
 *
 * THE LOOSE LEVEL IS DERIVED FROM THE STRICT ONE, and that is not cosmetic.
 * Measured 24 Nov 2026 on two tight groups plus one work linking them at coupling
 * 0.06: with the defaults (`strong=0.15 minShared=3`) the strict level gave 3
 * clusters and 1 bridge; with `strong_threshold=0.05` — the loose level's own
 * cosine — the strict level became EQUAL to the loose one, every candidate landed
 * in one cluster, and the bridge list came back empty while the reply printed
 * both thresholds. A user who lowers the threshold to see MORE structure got
 * less, and the reply claimed "every candidate clearly sits in one field".
 *
 * So the loose level is capped at a third of the strict cosine and at one shared
 * reference fewer, which reproduces the old 0.05 / 2 defaults exactly at the old
 * 0.15 / 3 defaults and keeps the strict level strictly tighter everywhere else.
 * When the cap actually bites, `clamped` is true and the requested values are
 * returned alongside, so the caller can say so instead of printing two numbers
 * that contradict each other. When even the cap cannot make the strict level
 * tighter (a strict level already at the floor: cosine 0 with 1 shared
 * reference), `bridgesComputable` is false and the caller must say that bridges
 * cannot be computed at this setting rather than that there are none.
 */
export function findBridges(works, {
  strongThreshold = 0.15, minSharedStrong = 3,
  weakThreshold = 0.05, minSharedWeak = 2,
  minOtherClusters = 2,
  reasonableRefLimit = 300,
} = {}) {
  // Rounded to 4 decimals so the reply prints `0.0167`, not
  // `0.016666666666666666`; the strict level is printed raw, so the loose one has
  // to stay readable next to it.
  const derivedWeakThreshold = Math.round((strongThreshold / 3) * 1e4) / 1e4;
  const effWeakThreshold = Math.min(weakThreshold, derivedWeakThreshold);
  const effMinSharedWeak = Math.min(minSharedWeak, Math.max(1, minSharedStrong - 1));
  const bridgesComputable = effWeakThreshold < strongThreshold || effMinSharedWeak < minSharedStrong;

  const strict = clusterWorks(works, { threshold: strongThreshold, minShared: minSharedStrong });
  const map = referenceSets(works);
  // `referenced_works_count` is what OpenAlex says the work HAS, as opposed to
  // what it returned. Without it a truncated reference list is indistinguishable
  // from a short one. Measured 24 Nov 2026: a container record with 400 real
  // references came back with 100, `refs` was 100, and the container warning
  // stayed silent — the reply presented it as an ordinary finding.
  const reportedById = new Map((works ?? []).map((w) => [shortId(w?.id), workNumber(w?.referenced_works_count)]));
  const ids = [...map.keys()].sort();
  const out = [];

  for (const id of ids) {
    const ownRefs = map.get(id) ?? new Set();
    const otherClusters = new Set();
    let degree = 0;
    for (const other of ids) {
      if (other === id) continue;
      if (sharedCount(ownRefs, map.get(other)) < effMinSharedWeak) continue;
      if (coupling(ownRefs, map.get(other)) < effWeakThreshold) continue;
      degree++;
      const n = strict.index.get(other);
      if (n !== undefined && n !== strict.index.get(id)) otherClusters.add(n);
    }
    if (otherClusters.size >= minOtherClusters) {
      const refsReported = reportedById.get(id) ?? null;
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
        // A DIFFERENT artifact, and a different message: the list is not long,
        // it is INCOMPLETE, so the coupling was computed on a subset.
        refsReported,
        truncated: refsReported !== null && refsReported > ownRefs.size,
      });
    }
  }

  return {
    bridges: out.sort((a, b) => (b.otherClusters - a.otherClusters) || (b.degree - a.degree) || cmpId(a.id, b.id)),
    strongClusters: strict,
    strongThreshold, minSharedStrong,
    weakThreshold: effWeakThreshold, minSharedWeak: effMinSharedWeak,
    requestedWeakThreshold: weakThreshold, requestedMinSharedWeak: minSharedWeak,
    clamped: effWeakThreshold !== weakThreshold || effMinSharedWeak !== minSharedWeak,
    bridgesComputable,
    reasonableRefLimit,
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
  // `seedRefs > 0` is a NUMERIC comparison, and a Set — the natural thing to
  // pass, and the type the caller holds — compares as NaN. Measured 24 Nov 2026:
  // `mapIsUseful({seedRefs: new Set(['a']), candidates: 0})` returned
  // `{useful: false, seedRefs: {}}` — the seed HAS a reference, the map was
  // declared not useful, and the echoed `seedRefs: {}` was uninterpretable. Both
  // a number and a sized collection are accepted, and the count is echoed.
  const nRefs = typeof seedRefs === 'number' ? seedRefs : (seedRefs?.size ?? 0);
  if (nRefs > 0) return { useful: true };
  if (candidates >= minCandidates) return { useful: true };
  return { useful: false, seedRefs: nRefs, candidates, minCandidates };
}

/**
 * The window a `publication_year` must fall in to be used.
 *
 * The old guard was `t > 1500` alone, which is arbitrary in BOTH directions:
 * measured 24 Nov 2026, a cluster with `publication_year: 99999` reported
 * `yearMax: 99999` and one with `1e9` reported `yearMax: 1000000000`, so a single
 * bad record defined the cluster's upper bound, while a legitimate `1500` was
 * dropped. The upper bound is the current year plus two — a work can be
 * "in press" for a while, but not for a century.
 */
const YEAR_MIN = 1500;
const YEAR_MAX = new Date().getFullYear() + 2;

/** Numeric summary of one cluster, for reporting without flooding the output. */
export function summarizeCluster(works, cluster) {
  const byId = new Map((works ?? []).map((w) => [shortId(w?.id), w]));
  const members = (cluster ?? []).map((id) => byId.get(id)).filter(Boolean);
  // `Number(null)` is 0, so `Number(w?.cited_by_count) || 0` turned "the source
  // did not report a count" into "0 citations" — a claim the data does not
  // support. Measured 24 Nov 2026: a 2-member cluster whose members both had
  // `cited_by_count: null` reported `totalCitations: 0`. This is the same bug
  // already fixed in `detailOfWork`, `closenessToSeed` and `workNumber`; this
  // file was missed. `null` = UNKNOWN, and it must stay distinguishable from a
  // real 0 — so the sum is `null` only when NO member reports a number.
  //
  // A PARTIAL sum is not a total either. Measured 24 Nov 2026: a 3-work cluster
  // with one `cited_by_count: null` returned `totalCitations: 30` and the caller
  // printed "total 30 citations"; a 20-work cluster with 19 unknown printed
  // "total 5 citations". The sum stays, but it now travels with its coverage so
  // it cannot be read as the cluster total.
  const citations = members.map((w) => workNumber(w?.cited_by_count)).filter((n) => n !== null);
  // Same shape for years: `.filter(t => t > 1500)` dropped unknown years without
  // saying so, and a 3-work cluster with 2 unknown years printed "2020-2020",
  // which reads as "every work here is from 2020".
  const years = members
    .map((w) => workNumber(w?.publication_year))
    .filter((t) => t !== null && t >= YEAR_MIN && t <= YEAR_MAX);
  return {
    // `members.length`, not `cluster.length`: the id list can contain an id with
    // no matching work, and then `size` disagreed with `top`/`years`/`citations`,
    // which are all built from `members`. Measured 24 Nov 2026: `size: 2` with
    // `top.length: 1`.
    size: members.length,
    idsWithoutWork: (cluster ?? []).length - members.length,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    yearsKnown: years.length,
    yearsUnknown: members.length - years.length,
    totalCitations: citations.length ? citations.reduce((a, b) => a + b, 0) : null,
    citedByKnown: citations.length,
    citedByUnknown: members.length - citations.length,
    // The comparator must be TOTAL. `(Number(x) || 0)` mapped `null` and `0` to
    // the same key, so the stable sort broke the tie by INPUT ORDER: measured
    // 24 Nov 2026, the same five works in forward and reversed order produced
    // `ONE:1 N1:null Z0:0 N2:null Z1:0` and `ONE:1 Z1:0 N2:null Z0:0 N1:null`.
    // Unknown counts sort LAST (they are not zeros), and the tie-break is the id.
    top: members
      .slice()
      .sort((a, b) => {
        const av = workNumber(a?.cited_by_count);
        const bv = workNumber(b?.cited_by_count);
        if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
        if (av !== null && bv !== null && av !== bv) return bv - av;
        return cmpId(shortId(a?.id), shortId(b?.id));
      })
      .slice(0, 5),
  };
}
