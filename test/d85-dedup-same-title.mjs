// d85 — two DIFFERENT papers that share a title must not be merged into one.
//
// THE DEFECT. `dedup` keyed a DOI-less record on its normalized title alone, so
// two papers with the same title collapsed into one and the second one's URL was
// discarded. Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580) with four records that
// differ in year AND URL and carry no DOI:
//
//   Editorial 2020 (crossref)  \
//   Editorial 2021 (doaj)       >  ONE record, the 2021 URL discarded
//   Introduction 2019 (hal)    \
//   Introduction 2022 (zenodo)  >  ONE record, the 2022 URL discarded
//
// Two papers vanished from a four-paper result set, silently. "Editorial" and
// "Introduction" are real titles that recur across journals and years, so this
// is not a contrived shape.
//
// THE RULE. A title key now maps to a LIST of entries, and a new record joins an
// existing one only when the years are COMPATIBLE: equal, or one of them
// unknown. Two records with the same title and two DIFFERENT known years are two
// papers.
//
// The asymmetry is deliberate. A false SPLIT shows the same paper twice, which
// the reader can see and dismiss; a false MERGE deletes a paper, which nobody
// can see. The same reasoning governs the slug hash in `lib/fulltext.js`.

import { dedup } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

/** A DOI-less record. */
const rec = (title, year, source, url) => ({ title, year, source, doi: null, url });

// ── 1. The measured defect ──────────────────────────────────────────────────
{
  const out = dedup([
    rec('Editorial', 2020, 'crossref', 'https://a/1'),
    rec('Editorial', 2021, 'doaj', 'https://b/2'),
    rec('Introduction', 2019, 'hal', 'https://c/3'),
    rec('Introduction', 2022, 'zenodo', 'https://d/4'),
  ]);
  check('four distinct papers stay four', out.length === 4, `got ${out.length}`);
  check('the 2021 Editorial URL survives', out.some((p) => p.url === 'https://b/2'),
    out.map((p) => p.url).join(','));
  check('the 2022 Introduction URL survives', out.some((p) => p.url === 'https://d/4'),
    out.map((p) => p.url).join(','));
}

// ── 2. The merges that MUST still happen ────────────────────────────────────
{
  check('same title + same year still merges',
    dedup([rec('Deep Learning', 2020, 'crossref', 'https://a/1'), rec('Deep learning', 2020, 'doaj', 'https://b/2')]).length === 1);

  check('same title + one UNKNOWN year still merges (cannot tell them apart)',
    dedup([rec('Deep Learning', 2020, 'crossref', 'https://a/1'), rec('Deep Learning', null, 'doaj', 'https://b/2')]).length === 1);

  check('the same DOI still merges regardless of title',
    dedup([
      { title: 'A', year: 2020, source: 'crossref', doi: '10.1/x', url: null },
      { title: 'B', year: 2021, source: 'doaj', doi: '10.1/x', url: null },
    ]).length === 1);

  check('three copies of one paper still merge to one',
    dedup([rec('X', 2020, 'a', 'u1'), rec('X', 2020, 'b', 'u2'), rec('X', 2020, 'c', 'u3')]).length === 1);
}

// ── 3. Two groups of the same title, each with its own duplicates ───────────
{
  const out = dedup([
    rec('X', 2020, 'a', 'u1'), rec('X', 2020, 'b', 'u2'),
    rec('X', 2021, 'c', 'u3'), rec('X', 2021, 'd', 'u4'),
  ]);
  check('two years of the same title give two records', out.length === 2, `got ${out.length}`);
  check('each record lists BOTH of its sources',
    out.every((p) => p.sources.length === 2), out.map((p) => p.sources.join('+')).join(' | '));
}

// ── 4. Untitled records still stay separate ─────────────────────────────────
{
  check('untitled records do not collapse',
    dedup([rec(null, 2020, 'a', 'u1'), rec(null, 2020, 'b', 'u2')]).length === 2);
}

done('D85 dedup keeps two papers that share a title');
