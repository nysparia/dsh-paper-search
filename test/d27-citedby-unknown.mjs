// test/d27-citedby-unknown.mjs — an unreported citation count becomes `0`.
//
// THE DEFECT. `makePaper` computed `const citations = Number(p.citedBy)` and
// guarded with `Number.isFinite(citations)`. `Number(null)` is **0** and
// `Number.isFinite(0)` is TRUE, so the guard passed and `citedBy` became `0` —
// "this paper has no citations yet" instead of "the source does not say".
// `summarizeWork` had the same bug.
//
// Measured 24 Nov 2026 with a canned OpenAlex work carrying
// `cited_by_count: null` — the three paths disagreed about the same work:
//
//   search path     citedBy = 0     (typeof number)
//   summarizeWork   citedBy = 0
//   detailOfWork    citedBy = null
//
// `detailOfWork` was already fixed this way (`workNumber()`); `makePaper` and
// `summarizeWork` were not. Downstream, `filterAndSort` then classified the
// record as "below the threshold" rather than "count unknown".
//
// WHAT MUST STILL WORK. A source that really reports 0 must still produce 0 —
// the fix must not turn every zero into "unknown".

import { searchSource, summarizeWork } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned JSON body for every request. */
function serve(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
}

// ── 1. The defect through the SEARCH path ──────────────────────────────────
{
  serve({
    results: [{
      id: 'https://openalex.org/W1',
      title: 'A Work OpenAlex Gives No Citation Count For',
      publication_year: 2024,
      cited_by_count: null,
      doi: 'https://doi.org/10.1/x',
      authorships: [],
      open_access: { is_oa: false },
      type: 'article',
    }],
    meta: { count: 1 },
  });
  const h = await searchSource('openalex', 'x', { rows: 1 });
  check('the search path reports no error', h.error === null, h.error ?? 'null');
  check('an unreported citation count is null, not 0', h.papers[0]?.citedBy === null,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 2. The defect through `summarizeWork` ─────────────────────────────────
{
  const s = summarizeWork({ id: 'https://openalex.org/W2', title: 'X', cited_by_count: null });
  check('summarizeWork reports null for an unreported count', s.citedBy === null, JSON.stringify(s.citedBy));
}

// ── 3. A real 0 must stay 0 ───────────────────────────────────────────────
{
  serve({
    results: [{
      id: 'https://openalex.org/W3',
      title: 'A Work With Genuinely Zero Citations',
      publication_year: 2024,
      cited_by_count: 0,
      authorships: [],
      open_access: { is_oa: false },
      type: 'article',
    }],
    meta: { count: 1 },
  });
  const h = await searchSource('openalex', 'x', { rows: 1 });
  check('a reported 0 stays 0', h.papers[0]?.citedBy === 0, JSON.stringify(h.papers[0]?.citedBy));
}

{
  const s = summarizeWork({ id: 'https://openalex.org/W4', title: 'X', cited_by_count: 0 });
  check('summarizeWork keeps a reported 0', s.citedBy === 0, JSON.stringify(s.citedBy));
}

// ── 4. A real positive count is unchanged ─────────────────────────────────
{
  serve({
    results: [{
      id: 'https://openalex.org/W5',
      title: 'A Well Cited Work',
      publication_year: 2020,
      cited_by_count: 4641,
      authorships: [],
      open_access: { is_oa: false },
      type: 'article',
    }],
    meta: { count: 1 },
  });
  const h = await searchSource('openalex', 'x', { rows: 1 });
  check('a reported count is carried through', h.papers[0]?.citedBy === 4641, JSON.stringify(h.papers[0]?.citedBy));
}

// ── 5. A source that does not report the field at all ─────────────────────
// Crossref omits `is-referenced-by-count` for works nobody has cited yet; the
// field being ABSENT is the same "not reported" case as an explicit null.
{
  serve({
    message: {
      items: [{
        DOI: '10.1145/1',
        title: ['A Crossref Item With No Citation Field'],
        author: [{ family: 'A' }],
        issued: { 'date-parts': [[2024]] },
        type: 'journal-article',
      }],
    },
  });
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('an absent citation field is null, not 0', h.papers[0]?.citedBy === null,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 6. The three paths now AGREE about the same work ──────────────────────
// This is the invariant the defect broke: the same input must not produce 0 on
// one path and null on another.
{
  const work = { id: 'https://openalex.org/W6', title: 'Agreement', cited_by_count: null };
  const viaSummary = summarizeWork(work).citedBy;
  serve({ results: [work], meta: { count: 1 } });
  const viaSearch = (await searchSource('openalex', 'x', { rows: 1 })).papers[0]?.citedBy;
  check('summarizeWork and the search path agree', viaSummary === viaSearch,
    `${JSON.stringify(viaSummary)} vs ${JSON.stringify(viaSearch)}`);
  check('both say null', viaSummary === null && viaSearch === null,
    `${JSON.stringify(viaSummary)} / ${JSON.stringify(viaSearch)}`);
}

globalThis.fetch = realFetch;
console.log('\nD27 citedBy unknown: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
