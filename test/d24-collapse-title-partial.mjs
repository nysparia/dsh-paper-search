// test/d24-collapse-title-partial.mjs — `collapseTitle` rule (A) truncates a
// title whose final repeated copy is INCOMPLETE.
//
// THE DEFECT. Rule (A) looked for the smallest period `p` such that
// `t[i] === t[i % p]` for every `i >= p`. That test never checks that the LAST
// copy is whole, so a title that ends part-way through a repetition was read as
// an exact doubling and cut to one copy. Measured on real Crossref records:
//
//   "Education, Education, Education"  (31 chars, period 11, 31 % 11 = 9)
//     -> "Education,"                   a real book, reduced to one word
//   "Music Education, Music Education, Music Education!"
//     -> "Music Education, Music Education!"
//
// A 499-title live sweep altered 7 of 499 real Crossref titles. Rule (D) made it
// worse: it fired on the same string, deleted one copy, and the next round
// deleted another.
//
// The function's own comment claimed "on the 50 samples, not a single valid
// title was truncated" — a statement about the sample, not about the code.
//
// WHAT MUST STILL WORK. The four documented repetition shapes (A exact period,
// B repeated after ": ", C prefix then "X: X", D phrase repeated at the start)
// are what this function exists for, and the valid shapes the comment names
// ("Title: subtitle", "Title: (case study)", "Title: keywords") must survive.
// `test/d10` already pins the odd-length doubling; this file must not re-break
// it.

import { collapseTitle } from '../lib/sources.js';
import { check, done } from './_harness.mjs';

// ── 1. The defect: a partial final copy is not a repetition ─────────────────
check('a title repeated three times with a PARTIAL last copy is unchanged',
  collapseTitle('Education, Education, Education'),
  'Education, Education, Education');

check('the same title with a trailing space is unchanged',
  collapseTitle('Education, Education, Education, '),
  'Education, Education, Education,');

check('a real book title from the live sweep is unchanged',
  collapseTitle('Music Education, Music Education, Music Education!'),
  'Music Education, Music Education, Music Education!');

check('a synthetic partial repeat is unchanged',
  collapseTitle('Alpha Beta, Alpha Beta, Alpha'),
  'Alpha Beta, Alpha Beta, Alpha');

check('a complete synthetic repeat is unchanged too (it is an enumeration)',
  collapseTitle('Alpha Beta, Alpha Beta, Alpha Beta'),
  'Alpha Beta, Alpha Beta, Alpha Beta');

// ── 2. The four documented repetition shapes must STILL collapse ────────────
// Shape A: exact period, a display pad. The period ends in a WORD, which is what
// separates a pad from an enumeration.
check('shape A: an exact period still collapses',
  collapseTitle('Digital Literacy Digital Literacy Digital Literacy'),
  'Digital Literacy');

check('shape A: an odd-length doubling still collapses (D10 regression guard)',
  collapseTitle('Digital Literacy Digital Literacy'),
  'Digital Literacy');

check('shape A: the trimmed odd-length doubling still collapses (D10)',
  collapseTitle('Digital Literacy Digital Literacy '),
  'Digital Literacy');

// Shape B: repeated after ": ".
check('shape B: a repeat after ": " still collapses',
  collapseTitle('Digital Literacy in Rural Schools: Digital Literacy in Rural Schools'),
  'Digital Literacy in Rural Schools');

// Shape D: a phrase repeated at the start, then the title continues.
check('shape D: a repeated prefix still collapses',
  collapseTitle('IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI PENDIDIKAN KARAKTER'),
  'IMPLEMENTASI PENDIDIKAN KARAKTER');

check('shape D: a repeated prefix followed by the rest of the title still collapses',
  collapseTitle('IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI PENDIDIKAN KARAKTER DAN PRESTASI'),
  'IMPLEMENTASI PENDIDIKAN KARAKTER DAN PRESTASI');

// ── 3. The valid shapes the comment names must survive ─────────────────────
check('a valid "Title: subtitle" is unchanged',
  collapseTitle('Digital Literacy: A Systematic Review'),
  'Digital Literacy: A Systematic Review');

check('a valid "Title: (case study)" is unchanged',
  collapseTitle('Digital Literacy: (case study)'),
  'Digital Literacy: (case study)');

check('a valid "Title: keywords" is unchanged',
  collapseTitle('Digital Literacy: A Systematic Review of Methods'),
  'Digital Literacy: A Systematic Review of Methods');

// ── 4. A partial repeat is not collapsed by rule (D) either ────────────────
// Rule (D) fired on "Education, " and deleted one copy, then the next round
// deleted another — so the fix has to hold in BOTH rules, not just (A).
check('rule (D) does not eat a partial repeat',
  collapseTitle('Education, Education, Education'),
  'Education, Education, Education');

// ── 5. Degenerate inputs are unchanged ─────────────────────────────────────
check('an empty title is empty', collapseTitle(''), '');
check('null becomes an empty string', collapseTitle(null), '');
check('a short title is unchanged', collapseTitle('Attention Is All You Need'), 'Attention Is All You Need');

done('D24 collapseTitle partial final copy');
