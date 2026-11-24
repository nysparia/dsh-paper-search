// D10 — `collapseTitle` misses an exact doubling of odd length.
//
// Measured on baseline 864a6e8:
//   'Digital Literacy Digital Literacy'   (33 chars, period 17) -> NOT collapsed
//   'Digital Literacy Digital Literacy '  (34 chars)            -> COLLAPSED
//
// `for (let p = 10; p <= Math.floor(n / 2); p++)` — for an exact doubling the
// period is exactly n/2, and when n is odd `Math.floor(n/2)` is one short.
// Garuda repeats titles to fill the display width, which is what this function
// exists for, so an odd-length repeat is a real case.
//
// The function is deliberately conservative (see its comment: 50 real samples,
// an over-long title is better than a wrongly truncated one). This test pins
// that conservatism too — the fix must not make it more aggressive.

import { collapseTitle } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

// ── the defect ───────────────────────────────────────────────────────────────
const odd = 'Digital Literacy Digital Literacy';
check('the odd-length doubling is 33 chars with period 17', [odd.length, odd.length / 2], [33, 16.5]);
check('an odd-length exact doubling collapses',
  collapseTitle(odd), 'Digital Literacy');

check('the even-length doubling still collapses (regression guard)',
  collapseTitle('Digital Literacy Digital Literacy '), 'Digital Literacy');

check('a triple repeat of odd length collapses to one copy',
  collapseTitle('Digital Literacy Digital Literacy Digital Literacy'), 'Digital Literacy');

// ── a valid "Title: subtitle" must survive ──────────────────────────────────
check('a valid "Title: subtitle" is unchanged',
  collapseTitle('Digital Literacy: A Systematic Review'), 'Digital Literacy: A Systematic Review');

check('a valid "Title: (case study)" is unchanged',
  collapseTitle('Digital Literacy: (case study)'), 'Digital Literacy: (case study)');

check('a valid "Title: keywords" is unchanged',
  collapseTitle('Digital Literacy: A Systematic Review of Methods'), 'Digital Literacy: A Systematic Review of Methods');

// ── rule (B): a genuine repeat after ": " still collapses ───────────────────
// Rule (B) requires the tail to be at least 20 chars — that fence is what keeps
// a valid "Title: subtitle" safe, so the repeat has to be long enough to fire.
check('a title repeated after ": " still collapses',
  collapseTitle('Digital Literacy in Rural Schools: Digital Literacy in Rural Schools'),
  'Digital Literacy in Rural Schools');

check('a SHORT repeat after ": " is deliberately left alone (the 20-char fence)',
  collapseTitle('Digital Literacy: Digital Literacy'), 'Digital Literacy: Digital Literacy');

// ── rule (D): a phrase repeated at the start still collapses ────────────────
check('a phrase repeated at the start still collapses',
  collapseTitle('IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI PENDIDIKAN KARAKTER'),
  'IMPLEMENTASI PENDIDIKAN KARAKTER');

// ── short titles must not be touched (the period scan starts at 10) ─────────
check('a short title is unchanged',
  collapseTitle('Attention Is All You Need'), 'Attention Is All You Need');

check('a short repeated word is not collapsed',
  collapseTitle('Very Very'), 'Very Very');

check('an empty title is empty',
  collapseTitle(''), '');

check('null becomes an empty string',
  collapseTitle(null), '');

done('D10 collapseTitle off-by-one');
