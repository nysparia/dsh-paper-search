// d68 — five low-severity defects in `lib/peta.js`, all measured 24 Nov 2026 on
// 0.7.0 (HEAD ba4b580):
//
//   L1  `shortId('   ')` returned `'   '` — truthy, so a whitespace id became a
//       real map key and a cluster member.
//   L2  `coCitation` threw `a.id.localeCompare is not a function` on a
//       non-string seed reference.
//   L3  `coCitation` did not deduplicate `seedRefs`: an array with `r1` twice
//       produced 3 rows for 2 distinct references.
//   L5  `summarizeCluster.size` counted ids that are not in `works`: `size: 2`
//       with `top.length: 1`.
//   L6  `localeCompare` made every sort order ICU-locale-dependent:
//       `['w5','W5','W9','W10']` sorted to `W10 w5 W5 W9` under the default
//       locale and to `W10 W5 W9 w5` by code point, and under `LANG=sv_SE` the
//       same list started `W1 W10 W2 z ä` versus `ä W1 W10 W2 z` under `LANG=C`.
//       The doc comment promises a deterministic order, so the comparison is now
//       by code point everywhere.

import { shortId, referenceSets, coCitation, clusterWorks, closenessToSeed, findBridges, summarizeCluster } from '../lib/peta.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const W = (id, refs = [], extra = {}) => ({
  id: `https://openalex.org/${id}`, title: id,
  referenced_works: refs.map((r) => `https://openalex.org/${r}`), ...extra,
});

// ── L1: a whitespace id is not a key ────────────────────────────────────────
{
  const map = referenceSets([{ id: '   ', referenced_works: [] }, { id: 'W1', referenced_works: [] }]);
  check('a whitespace-only id does not become a map key', !map.has('   '), JSON.stringify([...map.keys()]));
  check('…and it is not a cluster member', clusterWorks([{ id: '   ' }, { id: 'W1' }]).clusters.every((c) => !c.includes('   ')),
    JSON.stringify(clusterWorks([{ id: '   ' }, { id: 'W1' }]).clusters));
  check('shortId still returns null for it', shortId('   ') === null);
}

// ── L2: a non-string seed reference does not crash ──────────────────────────
{
  let threw = null;
  let rows = null;
  try {
    rows = coCitation([], [1, 2]);
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  check('a non-string seed reference does not throw', threw === null, threw ?? '');
  check('…and still produces one row per reference', Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
}

// ── L3: seedRefs is deduplicated ────────────────────────────────────────────
{
  const rows = coCitation([W('A', ['r1', 'r2'])], ['r1', 'r1', 'r2']);
  check('a duplicated seed reference produces ONE row', rows.length === 2, JSON.stringify(rows));
  check('…and is counted once', rows.find((x) => x.id === 'r1')?.by === 1, JSON.stringify(rows));
}

// ── L5: size counts the works it can actually summarise ─────────────────────
{
  const r = summarizeCluster([W('W1', [], { cited_by_count: 5 })], ['W1', 'W2']);
  check('size is the number of real members, not the id list', r.size === 1, `got ${r.size}`);
  check('…and the ids with no work are reported', r.idsWithoutWork === 1, `got ${JSON.stringify(r.idsWithoutWork)}`);
}

// ── L6: every sort is by code point, not by ICU locale ──────────────────────
{
  const rows = coCitation([], ['w5', 'W5', 'W9', 'W10']);
  check('coCitation sorts by code point', rows.map((x) => x.id).join(' ') === 'W10 W5 W9 w5',
    rows.map((x) => x.id).join(' '));
}
{
  const clusters = clusterWorks([W('w5'), W('W5')]).clusters;
  check('clusterWorks orders equal-size clusters by code point',
    JSON.stringify(clusters) === JSON.stringify([['W5'], ['w5']]), JSON.stringify(clusters));
}
{
  const close = closenessToSeed([W('w5'), W('W5')], new Set(['r1']));
  check('closenessToSeed breaks ties by code point', close.map((d) => d.id).join(' ') === 'W5 w5',
    close.map((d) => d.id).join(' '));
}
{
  // Two independent bridges with the same otherClusters and degree, differing
  // only in the case of their id.
  const refs = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const A = refs('a', 50); const B = refs('b', 50); const C = refs('c', 50); const D = refs('d', 50);
  const works = [
    ...['A1', 'A2', 'A3'].map((i) => W(i, A)),
    ...['B1', 'B2', 'B3'].map((i) => W(i, B)),
    ...['C1', 'C2', 'C3'].map((i) => W(i, C)),
    ...['D1', 'D2', 'D3'].map((i) => W(i, D)),
    W('X1', [...A.slice(0, 3), ...B.slice(0, 3), ...refs('x', 44)]),
    W('x1', [...C.slice(0, 3), ...D.slice(0, 3), ...refs('y', 44)]),
  ];
  const ids = findBridges(works).bridges.map((b) => b.id);
  check('findBridges breaks ties by code point', ids.join(' ') === 'X1 x1', ids.join(' '));
}

done('D68 peta id hygiene and sort order');
