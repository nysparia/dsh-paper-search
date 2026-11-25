// test/d107-ieee-doi-prefixes.mjs — the `ieee` doc comment claimed "every result
// carries a `10.1109/…` DOI". It does not, and the CODE is right.
//
// Measured over 100 `member:263` records on 25 Nov 2026:
//
//   {"10.1109": 93, "10.23919": 6, "10.36227": 1}
//
// The 10.23919 records are real IEEE conference papers and the 10.36227 one is a
// TechRxiv preprint — both published by IEEE, and `member:263` IS IEEE (verified:
// `GET /members/263` -> "Institute of Electrical and Electronics Engineers
// (IEEE)"). So the sentence was wrong, not the filter: adding a
// `prefix:10.1109` filter would DROP 7% of IEEE's output.
//
// A comment cannot be asserted on, so this test pins the BEHAVIOUR the corrected
// comment now describes: the connector filters on `member:263` alone and keeps
// every DOI prefix IEEE publishes under. A future "fix" that adds a prefix
// filter to match the old sentence fails here.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

const ITEMS = [
  { title: ['An IEEE journal article'], DOI: '10.1109/ACCESS.2024.1', type: 'journal-article', 'is-referenced-by-count': 3 },
  { title: ['An IEEE conference paper'], DOI: '10.23919/ACC.2024.2', type: 'proceedings-article', 'is-referenced-by-count': 1 },
  { title: ['A TechRxiv preprint'], DOI: '10.36227/techrxiv.3', type: 'posted-content' },
];

let requested = null;
globalThis.fetch = async (url) => {
  requested = String(url);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: { items: ITEMS } }),
  };
};

const h = await searchSource('ieee', 'control', { rows: 3 });

check('ieee reports no error', h.error === null, h.error ?? 'null');
check('all three records are kept', h.papers.length === 3, String(h.papers.length));
check('the 10.1109 record is kept', h.papers.some((p) => p.doi === '10.1109/access.2024.1'),
  JSON.stringify(h.papers.map((p) => p.doi)));
check('the 10.23919 record is kept', h.papers.some((p) => p.doi === '10.23919/acc.2024.2'),
  JSON.stringify(h.papers.map((p) => p.doi)));
check('the 10.36227 record is kept', h.papers.some((p) => p.doi === '10.36227/techrxiv.3'),
  JSON.stringify(h.papers.map((p) => p.doi)));

check('the request filters on member:263', /filter=member%3A263/.test(requested ?? ''), requested ?? '(none)');
check('the request adds NO DOI-prefix filter', !/prefix/i.test(requested ?? ''), requested ?? '(none)');

// A `kind` filter is still pushed down, and still does not touch the DOI prefix.
{
  await searchSource('ieee', 'control', { rows: 3, kind: ['article'] });
  check('a kind filter is still pushed down', /type%3Ajournal-article/.test(requested ?? ''), requested ?? '(none)');
  check('and still adds no DOI-prefix filter', !/prefix/i.test(requested ?? ''), requested ?? '(none)');
}

globalThis.fetch = realFetch;
console.log('\nD98 IEEE DOI prefixes: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
