// test/d108-semantic-citations.mjs — `semantic` never asked for `citationCount`,
// so `citedBy` was always `null`.
//
// THE DEFECT. The `fields` list sent to Semantic Scholar was
// `title,year,authors,externalIds,venue,abstract,openAccessPdf` — no
// `citationCount`. Semantic Scholar returns ONLY the fields it is asked for, so
// the count was never in the reply and `makePaper` was handed nothing.
//
// Measured live 25 Nov 2026 on `/graph/v1/paper/search/match`:
//
//   fields=title,year,citationCount,isOpenAccess,openAccessPdf
//     -> {"title":"GENERATIVE ADVERSARIAL NETS","citationCount":48273, …}
//   the connector's old fields list
//     -> keys: abstract, authors, externalIds, matchScore, openAccessPdf,
//              paperId, title, venue, year        (no citationCount)
//
// The user-visible consequence was the Crossref defect (`d31`) repeated in a
// different connector:
//
//   Filter: citations >= 10 — 0 below the threshold · 2 DROPPED because the
//   source does not report a citation count.
//
// The platform reported the number; the connector never asked for it.
//
// WHAT MUST STILL WORK. A reply that does not carry the field must still yield
// `null`, not 0 — that is the `workNumber` rule, and it is what keeps
// `min_citations` honest about a genuine absence.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Semantic Scholar reply and record the request URL. */
function serve(data) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data }),
    };
  };
  return seen;
}

// ── 1. The field is REQUESTED ─────────────────────────────────────────────
{
  const seen = serve([]);
  await searchSource('semantic', 'x', { rows: 1 });
  const fields = new URL(seen[0]).searchParams.get('fields') ?? '';
  check('semantic requests citationCount', fields.split(',').includes('citationCount'), fields);
}

// ── 2. The field is MAPPED to citedBy ─────────────────────────────────────
{
  serve([{ title: 'A Paper Semantic Scholar Counts', year: 2017, citationCount: 48273 }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('the citation count reaches citedBy', h.papers[0]?.citedBy === 48273,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 3. A real 0 stays 0 ───────────────────────────────────────────────────
{
  serve([{ title: 'An uncited paper', year: 2024, citationCount: 0 }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('a reported 0 stays 0', h.papers[0]?.citedBy === 0, JSON.stringify(h.papers[0]?.citedBy));
}

// ── 4. An ABSENT field is still null, not 0 ───────────────────────────────
// A reply that omits the field is "not reported", and `min_citations` must keep
// counting it as such.
{
  serve([{ title: 'A paper with no count field', year: 2024 }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  check('an absent field is null, not 0', h.papers[0]?.citedBy === null,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 5. The count survives the whole path into the filter ──────────────────
// The defect was only visible through `min_citations`, so the assertion is made
// where the user saw it: a record with a count must not be counted as "no
// citation count reported".
{
  const { filterAndSort } = await import('../lib/index.js');
  serve([{ title: 'A well cited paper', year: 2017, citationCount: 48273 }]);
  const h = await searchSource('semantic', 'x', { rows: 1 });
  const f = filterAndSort(h.papers, { minCitations: 10 });
  check('min_citations keeps a record whose count was reported', f.papers.length === 1,
    `${f.papers.length} kept, dropped=${JSON.stringify(f.dropped)}`);
  check('min_citations does not count it as "no citation count"', f.dropped.noCitations === 0,
    JSON.stringify(f.dropped));
}

globalThis.fetch = realFetch;
console.log('\nD91 semantic citations: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
