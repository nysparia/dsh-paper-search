// test/d25-dedup-title-prefix.mjs — `dedup` merges two DIFFERENT papers whose
// titles share a 120-character prefix.
//
// THE DEFECT. `titleKey` normalized the title and then truncated it to 120
// characters. Two records whose titles differ only AFTER character 120 got the
// same key and were merged into one, with the second record's URL discarded.
//
// Measured on two real Crossref records — different peer-review reports for
// different versions of the same paper:
//
//   "Peer Review Report For: Data extraction methods for systematic review
//    (semi)automation: A living systematic review [version 1; peer review: 3 approved]"
//   "… [version 2; peer review: 2 approved]"
//
//   keys equal? true  ->  two DIFFERENT papers -> 1 record, one URL kept
//
// Not a contrived shape: 30 of 298 sampled real titles have a normalized key
// longer than 120 characters.
//
// WHAT MUST STILL WORK. Genuinely identical titles must still merge — that is
// the whole point of the title key, and it is what makes a paper found by two
// databases appear once with both sources listed.

import { dedup } from '../lib/sources.js';
import { check } from './harness.mjs';

// ── 1. The defect: two titles that differ only after 120 characters ─────────
const reportV1 = {
  title: 'Peer Review Report For: Data extraction methods for systematic review (semi)automation: A living systematic review [version 1; peer review: 3 approved]',
  doi: null,
  source: 'crossref',
  url: 'https://doi.org/10.5256/f1000research.54235.r89347',
  authors: [],
};
const reportV2 = {
  title: 'Peer Review Report For: Data extraction methods for systematic review (semi)automation: A living systematic review [version 2; peer review: 2 approved]',
  doi: null,
  source: 'doaj',
  url: 'https://doi.org/10.5256/f1000research.54235.r85692',
  authors: [],
};

check('the two titles really do share a 120-character prefix',
  reportV1.title.slice(0, 120) === reportV2.title.slice(0, 120), 'prefixes differ');

const two = dedup([reportV1, reportV2]);
check('two different papers stay TWO records', two.length === 2, String(two.length));
check('the first URL survives', two.some((p) => p.url === reportV1.url), JSON.stringify(two.map((p) => p.url)));
check('the second URL survives', two.some((p) => p.url === reportV2.url), JSON.stringify(two.map((p) => p.url)));

// ── 2. A synthetic minimal proof, independent of the real titles ────────────
const long = 'a'.repeat(120);
const a = { title: `${long} one`, doi: null, source: 'crossref', url: 'https://example.org/a', authors: [] };
const b = { title: `${long} two`, doi: null, source: 'doaj', url: 'https://example.org/b', authors: [] };
const ab = dedup([a, b]);
check('a synthetic 120-char shared prefix does not merge', ab.length === 2, String(ab.length));

// ── 3. Genuinely identical titles MUST still merge ─────────────────────────
const same1 = { title: 'Deep Learning: A Review', doi: null, source: 'crossref', url: 'https://example.org/1', authors: [] };
const same2 = { title: 'Deep Learning: A Review', doi: null, source: 'doaj', url: 'https://example.org/2', authors: [] };
const merged = dedup([same1, same2]);
check('identical titles still merge into one record', merged.length === 1, String(merged.length));
check('the merged record lists BOTH sources',
  JSON.stringify(merged[0]?.sources) === JSON.stringify(['crossref', 'doaj']),
  JSON.stringify(merged[0]?.sources));

// The normalization is what makes two databases agree: punctuation and case
// differ between them for the same paper.
const punct1 = { title: 'Deep Learning — A Review', doi: null, source: 'crossref', url: 'https://example.org/3', authors: [] };
const punct2 = { title: 'deep learning: a review', doi: null, source: 'doaj', url: 'https://example.org/4', authors: [] };
check('punctuation and case differences still merge', dedup([punct1, punct2]).length === 1,
  String(dedup([punct1, punct2]).length));

// ── 4. DOI dedup is unaffected ─────────────────────────────────────────────
const doi1 = { title: 'One title', doi: '10.1234/x', source: 'crossref', url: 'https://example.org/5', authors: [] };
const doi2 = { title: 'A completely different title', doi: '10.1234/x', source: 'doaj', url: 'https://example.org/6', authors: [] };
check('the same DOI still merges regardless of title', dedup([doi1, doi2]).length === 1,
  String(dedup([doi1, doi2]).length));

// ── 5. Untitled records still stay separate (the earlier fix) ──────────────
const untitled = [
  { title: null, doi: null, source: 'zenodo', url: 'https://example.org/z1', authors: [] },
  { title: null, doi: null, source: 'hal', url: 'https://example.org/h1', authors: [] },
  { title: null, doi: null, source: 'ios', url: 'https://example.org/i1', authors: [] },
];
check('three untitled records stay three records', dedup(untitled).length === 3,
  String(dedup(untitled).length));

console.log('\nD25 dedup title-prefix collision: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
