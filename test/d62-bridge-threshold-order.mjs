// d62 — the strict and loose clustering levels could invert, and the caller
// accepted thresholds that cannot mean anything.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580), on two tight groups plus one work
// linking them at coupling 0.06:
//
//   defaults (strong 0.15 / loose 0.05)   strict=[3,3,1]  bridges=["X"]
//   strong_threshold=0.05 (== loose)      strict=[7]      bridges=[]
//   strong_threshold=0.04 (< loose)       strict=[7]      bridges=[]
//
// The loose level was hardcoded at 0.05 / 2 shared references while the strict
// level came from the caller, so lowering `strong_threshold` to "see more
// structure" made the strict level EQUAL to the loose one: every loose link was
// also a strict link, `otherClusters` was always 0, and the reply printed both
// thresholds — two numbers that contradicted each other while neither explained
// the empty bridge list.
//
// The loose level is now derived from the strict one (a third of the cosine, one
// shared reference fewer), which reproduces the old 0.05 / 2 exactly at the old
// 0.15 / 3 defaults and keeps the strict level strictly tighter everywhere else.
// When the cap bites, `clamped` is true and the reply says so.
//
// Also measured: `strong_threshold: 2` — a cosine cannot exceed 1 — was accepted
// silently and produced "NOT ONE pair of candidates is close enough", and
// `min_shared_strong: 0` silently disabled the shared-reference fence. A rejected
// argument is stated here.

import { findBridges } from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

// Two tight groups of 50 identical references each, plus X, which shares 3
// references with each group: coupling(X, group) = 3 / sqrt(50*50) = 0.06 — above
// the loose level and below the strict one.
const refs = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const GROUP_A = refs('a', 50);
const GROUP_B = refs('b', 50);
const X_REFS = [...GROUP_A.slice(0, 3), ...GROUP_B.slice(0, 3), ...refs('x', 44)];
const W = (id, r) => ({ id: `https://openalex.org/${id}`, title: id, referenced_works: r });
const WORKS = [
  ...['A1', 'A2', 'A3'].map((i) => W(i, GROUP_A)),
  ...['B1', 'B2', 'B3'].map((i) => W(i, GROUP_B)),
  W('X', X_REFS),
];

// ── 1. the invariant holds inside findBridges ────────────────────────────────
{
  const d = findBridges(WORKS);
  check('defaults keep the documented loose level 0.05 / 2', d.weakThreshold === 0.05 && d.minSharedWeak === 2,
    `got ${d.weakThreshold} / ${d.minSharedWeak}`);
  check('defaults are NOT reported as clamped', d.clamped === false, `got ${JSON.stringify(d.clamped)}`);
  check('defaults still find the bridge', d.bridges.map((b) => b.id).join(',') === 'X',
    JSON.stringify(d.bridges.map((b) => b.id)));
}
{
  const d = findBridges(WORKS, { strongThreshold: 0.05, minSharedStrong: 3 });
  check('strong == the old loose cosine: the loose level drops below it', d.weakThreshold < d.strongThreshold,
    `strict ${d.strongThreshold} vs loose ${d.weakThreshold}`);
  check('…and the clamp is REPORTED', d.clamped === true, `got ${JSON.stringify(d.clamped)}`);
  check('…and the requested loose level is still available to the caller',
    d.requestedWeakThreshold === 0.05 && d.requestedMinSharedWeak === 2,
    `got ${d.requestedWeakThreshold} / ${d.requestedMinSharedWeak}`);
}
{
  const d = findBridges(WORKS, { strongThreshold: 0.15, minSharedStrong: 2 });
  check('min_shared_strong == the old loose count: the loose count drops below it', d.minSharedWeak < d.minSharedStrong,
    `strict ${d.minSharedStrong} vs loose ${d.minSharedWeak}`);
}
{
  // The strict level cannot be made tighter than the loose one here, so the
  // function must say so instead of returning an empty list that reads as a fact.
  const d = findBridges(WORKS, { strongThreshold: 0, minSharedStrong: 1 });
  check('a strict level at the floor is reported as NOT computable', d.bridgesComputable === false,
    `got ${JSON.stringify(d.bridgesComputable)}`);
}

// ── 2. the caller rejects out-of-range thresholds and says so ────────────────
const SEED = {
  id: 'https://openalex.org/W1000', title: 'Seed', publication_year: 2010,
  cited_by_count: 50, referenced_works: ['https://openalex.org/W1'],
};
const CANDS = WORKS.map((w) => ({ ...w, publication_year: 2015, cited_by_count: 10 }));

function mapFetch(candidates) {
  return installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works/W1000') return { body: SEED };
    const filter = u.searchParams.get('filter') ?? '';
    if (filter.startsWith('cites:')) return { body: { results: candidates, meta: { count: candidates.length } } };
    return { body: { results: [] } };
  });
}

async function run(args) {
  const tools = loadTools();
  const h = mapFetch(CANDS);
  const r = await tools.get('paper_citations').execute({ identifier: 'W1000', analysis: 'map', max_candidates: 10, ...args });
  h.restore();
  return r;
}

{
  const r = await run({ strong_threshold: 2 });
  check('strong_threshold 2 (a cosine cannot exceed 1) is REJECTED and stated',
    /NOTE: strong_threshold was 2 — a cosine threshold must be above 0 and at most 1, so the default 0\.15 was used\./.test(r),
    r.split('\n').find((l) => /strong_threshold/.test(l)));
  check('…and the default 0.15 is what the reply then uses',
    /clustering threshold: cosine >= 0\.15 AND >= 3 shared references/.test(r),
    r.split('\n').find((l) => /clustering threshold/.test(l)));
}
{
  const r = await run({ min_shared_strong: 0 });
  check('min_shared_strong 0 is REJECTED and stated',
    /NOTE: min_shared_strong was 0 — a link needs at least 1 shared reference, so the default 3 was used\./.test(r),
    r.split('\n').find((l) => /min_shared_strong/.test(l)));
}
{
  const r = await run({ strong_threshold: 0.05 });
  const strictCos = Number((r.match(/clustering threshold: cosine >= ([\d.]+)/) ?? [])[1]);
  const looseCos = Number((r.match(/condition: cosine >= ([\d.]+)/) ?? [])[1]);
  check('the reply prints a loose cosine STRICTLY below the strict one', looseCos < strictCos,
    `strict ${strictCos} vs loose ${looseCos}`);
  check('…and says the loose level was lowered, with both numbers',
    /NOTE: the loose level was lowered from cosine 0\.05 \/ 2 shared references to 0\.0167 \/ 2/.test(r),
    r.split('\n').find((l) => /loose level was lowered/.test(l)));
}

done('D62 bridge threshold ordering');
