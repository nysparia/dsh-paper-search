// d93 — a retracted paper beyond the display cap was described as "listed below".
//
// THE DEFECT. The retraction warning counted every retracted paper in the merged
// list and then said "they are still listed below, marked" — but only the first
// 40 are listed. Measured 24 Nov 2026 on 0.8.0 with 45 papers whose only
// retracted one was #45:
//
//   WARNING: 1 of these 45 papers IS RETRACTED … they are still listed below,
//   marked, because a retracted paper is the one you most need to know about.
//   papers listed: 40 · last: 40. Paper 39
//   is the retracted paper in the list? false
//
// So the one sentence that exists to protect the reader from citing a retracted
// paper pointed at a paper they could not see, and claimed it was marked when it
// was not.
//
// The two cases are now counted and worded separately, and the ones that fell off
// the end are NAMED — a title is the only thing that lets the reader find them.
//
// A second defect was found while fixing the first: `retracted` is a FILTERED
// subset, so slicing it at DISPLAY_CAP does not give the papers beyond display
// position 40. The comparison has to be against the papers actually printed.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** 45 OpenAlex works; `retractedAt` is the index of the only retracted one. */
async function reply(retractedAt) {
  const items = Array.from({ length: 45 }, (_, i) => ({
    id: `https://openalex.org/W${i}`, title: `Paper ${i}`, publication_year: 2020,
    cited_by_count: 100 - i, is_retracted: i === retractedAt,
  }));
  const tools = loadTools();
  const h = installFetch((url) => (new URL(url).host === 'api.openalex.org'
    ? { body: { results: items, meta: { count: 45 } } }
    : { body: {} }));
  const out = await tools.get('paper_search').execute({ query: 'x', sources: 'openalex', max_results: 50 });
  h.restore();
  return out;
}

// ── 1. Retracted at #45, beyond the 40-paper cap ───────────────────────────
{
  const r = await reply(44);
  check('the warning still fires', /IS RETRACTED/.test(r));
  check('it does NOT claim the paper is listed below', !/listed below and marked/.test(r),
    r.split('\n').filter((l) => /listed below|BEYOND/.test(l)).join(' | '));
  check('it says the paper is BEYOND the display cap', /BEYOND the 40-paper display cap/.test(r),
    r.split('\n').find((l) => /BEYOND/.test(l)) ?? 'SILENT');
  check('it NAMES the paper that fell off the end', /· Paper 44/.test(r),
    r.split('\n').filter((l) => /· Paper/.test(l)).join(' | ') || 'not named');
  check('it says how to bring it into view', /Narrow the query or lower max_results/.test(r));
  check('the paper really is not in the list', !/^41\. /m.test(r));
}

// ── 2. Retracted at #1, inside the cap ─────────────────────────────────────
{
  const r = await reply(0);
  check('a retracted paper inside the cap IS described as listed', /listed below and marked/.test(r),
    r.split('\n').filter((l) => /listed below|BEYOND/.test(l)).join(' | '));
  check('it does not mention the cap', !/BEYOND the 40-paper/.test(r));
  check('the paper is marked in the list', /⚠ RETRACTED/.test(r));
}

// ── 3. Two retracted, one inside and one outside ───────────────────────────
{
  const items = Array.from({ length: 45 }, (_, i) => ({
    id: `https://openalex.org/W${i}`, title: `Paper ${i}`, publication_year: 2020,
    cited_by_count: 100 - i, is_retracted: i === 0 || i === 44,
  }));
  const tools = loadTools();
  const h = installFetch((url) => (new URL(url).host === 'api.openalex.org'
    ? { body: { results: items, meta: { count: 45 } } }
    : { body: {} }));
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'openalex', max_results: 50 });
  h.restore();
  check('both are counted', /2 of these 45 papers ARE RETRACTED/.test(r),
    r.split('\n').find((l) => /RETRACTED/.test(l)) ?? 'SILENT');
  check('the visible one is described as listed', /1 of them is listed below and marked/.test(r),
    r.split('\n').find((l) => /listed below/.test(l)) ?? 'SILENT');
  check('the hidden one is named', /· Paper 44/.test(r),
    r.split('\n').filter((l) => /· Paper/.test(l)).join(' | ') || 'not named');
}

done('D93 a retracted paper beyond the display cap');
