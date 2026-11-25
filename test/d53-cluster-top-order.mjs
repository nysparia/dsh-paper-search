// d53 — `summarizeCluster`'s `top[]` was not deterministic.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580). The comparator was
// `(Number(b?.cited_by_count) || 0) - (Number(a?.cited_by_count) || 0)`, which maps
// `null` and `0` to the SAME sort key, so the stable sort broke the tie by input
// order:
//
//   forward  top: ONE:1 N1:null Z0:0 N2:null Z1:0
//   reversed top: ONE:1 Z1:0 N2:null Z0:0 N1:null
//   identical: false
//
// The caller prints `top.slice(0, 3)` as "the cluster's most cited works", so the
// same query could produce a different cluster summary depending on the order
// OpenAlex returned the works in. It also ranked "unknown" as if it were a real
// zero, and could put an unknown-count work above a genuine 0-count work.
//
// The comparator is now total: unknown counts sort LAST, then count descending,
// then the id by code point.

import { summarizeCluster } from '../lib/peta.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const W = (id, extra) => ({ id: `https://openalex.org/${id}`, title: id, ...extra });
const MIXED = [
  W('N1', { cited_by_count: null }),
  W('Z0', { cited_by_count: 0 }),
  W('N2', { cited_by_count: null }),
  W('Z1', { cited_by_count: 0 }),
  W('ONE', { cited_by_count: 1 }),
];
const IDS = ['N1', 'Z0', 'N2', 'Z1', 'ONE'];
const label = (w) => `${w.id.split('/').pop()}:${JSON.stringify(w.cited_by_count)}`;

const forward = summarizeCluster(MIXED, IDS).top.map(label).join(' ');
const reversed = summarizeCluster(MIXED.slice().reverse(), IDS.slice().reverse()).top.map(label).join(' ');
check('the same works in reversed order give the SAME top[]', forward === reversed, `${forward}  vs  ${reversed}`);
check('the highest count is still first', forward.startsWith('ONE:1'), forward);
check('unknown counts sort LAST, not as zeros', forward.endsWith('N1:null N2:null'), forward);

// A null count must not outrank a real 0.
{
  const t = summarizeCluster([W('NULL', { cited_by_count: null }), W('ZERO', { cited_by_count: 0 })], ['NULL', 'ZERO']).top;
  check('a real 0 outranks an unknown count', t[0].id.endsWith('/ZERO'), t.map(label).join(' '));
}

// Ties on the same count are broken by id, not by arrival order.
{
  const a = summarizeCluster([W('B', { cited_by_count: 5 }), W('A', { cited_by_count: 5 })], ['B', 'A']).top;
  const b = summarizeCluster([W('A', { cited_by_count: 5 }), W('B', { cited_by_count: 5 })], ['A', 'B']).top;
  check('equal counts are ordered by id, not by input order',
    a.map(label).join(' ') === b.map(label).join(' ') && a[0].id.endsWith('/A'),
    `${a.map(label).join(' ')}  vs  ${b.map(label).join(' ')}`);
}

// A non-numeric count is unknown, not zero.
{
  const t = summarizeCluster([W('BAD', { cited_by_count: 'n/a' }), W('Z', { cited_by_count: 0 })], ['BAD', 'Z']).top;
  check('a non-numeric count is treated as unknown and sorts last', t[0].id.endsWith('/Z'), t.map(label).join(' '));
}

done('D53 cluster top[] determinism');
