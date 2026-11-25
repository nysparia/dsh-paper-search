// d45 — the search path's argument handling and reporting.
//
// Five defects, all measured 24 Nov 2026 on 0.6.9 (HEAD 148f7c4):
//
//   1. `max_results: 7.5` was passed through as a fraction, and Crossref, DOAJ,
//      OpenAlex and Zenodo each answered HTTP 400 — four sources dead from one
//      argument, while the parameter is documented "1-50".
//   2. `open_access_only: "false"` APPLIED the filter (truthiness), so a caller
//      that stringified got the opposite of what it asked for.
//   3. `year_from: 'abc'` / `-5` / `0` / `1500` were silently ignored, while an
//      invalid `min_citations` was reported.
//   4. The year filter never counted the works it dropped as too old.
//   5. A repeated source id cost a repeated request and was counted as a second
//      source.
//
// Plus the early-return path, which used to hardcode a neutral `filter` block and
// therefore printed NO filter warnings at all.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

const CROSSREF_ITEMS = [
  { DOI: '10.1/a', title: ['Old A'], issued: { 'date-parts': [[1990]] }, type: 'journal-article' },
  { DOI: '10.1/b', title: ['Old B'], issued: { 'date-parts': [[1995]] }, type: 'journal-article' },
  { DOI: '10.1/c', title: ['New C'], issued: { 'date-parts': [[2021]] }, type: 'journal-article' },
];

/** A fetch that answers Crossref and records the `rows` it was asked for. */
function crossrefFetch(items = CROSSREF_ITEMS) {
  const rows = [];
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.host === 'api.crossref.org') {
      rows.push(u.searchParams.get('rows'));
      return { body: { message: { items } } };
    }
    return { body: {} };
  });
  return { rows, restore: h.restore };
}

// ── 1. max_results is truncated to an integer ────────────────────────────────
{
  const tools = loadTools();
  const f = crossrefFetch();
  await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', max_results: 7.9 });
  f.restore();
  check('max_results 7.9 is sent as 7, not as a fraction', f.rows[0] === '7', `rows=${f.rows[0]}`);
}
{
  const tools = loadTools();
  const f = crossrefFetch();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', max_results: 7.9 });
  f.restore();
  check('the clamp is REPORTED', /max_results was not a whole number/.test(r));
}
{
  const tools = loadTools();
  const f = crossrefFetch();
  await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', max_results: 500 });
  f.restore();
  check('max_results 500 is clamped to 50', f.rows[0] === '50', `rows=${f.rows[0]}`);
}

// ── 2. open_access_only is read as a boolean, not as truthiness ──────────────
{
  const tools = loadTools();
  for (const [value, expectFiltered] of [[false, false], ['false', false], [0, false], ['no', false], [true, true], ['true', true]]) {
    const f = crossrefFetch();
    const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', open_access_only: value });
    f.restore();
    const filtered = /Open-access filter:/.test(r);
    check(`open_access_only=${JSON.stringify(value)} ${expectFiltered ? 'applies' : 'does not apply'} the filter`,
      filtered === expectFiltered, `filtered=${filtered}`);
  }
}

// ── 3. an invalid year_from is reported, not silently ignored ────────────────
{
  const tools = loadTools();
  for (const value of ['abc', -5, 0, 1500]) {
    const f = crossrefFetch();
    const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', year_from: value });
    f.restore();
    check(`year_from=${JSON.stringify(value)} is reported as ignored`, /year_from ignored/.test(r));
  }
}
{
  const tools = loadTools();
  const f = crossrefFetch();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', year_from: 2020.7 });
  f.restore();
  check('a fractional year_from is truncated to 2020', /Year filter: >= 2020\b/.test(r), r.split('\n').find((l) => /Year filter/.test(l)));
  check('the truncation is stated', /year_from was not a whole year/.test(r));
}

// ── 4. the year filter counts what it dropped ────────────────────────────────
{
  const tools = loadTools();
  const f = crossrefFetch();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', year_from: 2020 });
  f.restore();
  check('the works dropped as too old are COUNTED', /2 DROPPED as older than 2020/.test(r),
    r.split('\n').find((l) => /Year filter/.test(l)));
}

// ── 5. a repeated source id is one source ────────────────────────────────────
{
  const tools = loadTools();
  let requests = 0;
  const h = installFetch((url) => {
    if (new URL(url).host === 'api.crossref.org') requests += 1;
    return { body: { message: { items: [] } } };
  });
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref,crossref,crossref' });
  h.restore();
  check('a repeated id costs ONE request', requests === 1, `requests=${requests}`);
  check('the reply says one source was searched', /^1 sources searched/.test(r.split('\n')[1]), r.split('\n')[1]);
  check('the repetition is reported', /repeated source id\(s\) counted once: crossref/.test(r));
}

// ── 6. the early-return path keeps the filter warnings ───────────────────────
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: {} }));
  // `unpaywall` is skipped for a keyword query, so `ids` is empty and the early
  // return is taken — the path that used to drop every warning.
  const r = await tools.get('paper_search').execute({
    query: 'digital literacy', sources: 'unpaywall', sort: 'banana', min_citations: 'abc', kind: 'banana',
  });
  h.restore();
  check('early return: the sort warning survives', /sort "banana" is not recognized/.test(r));
  check('early return: the min_citations note survives', /min_citations ignored/.test(r));
  check('early return: the unknown-kind warning survives', /unknown kind \(ignored\): banana/.test(r));
}

// ── 7. a group keyword mixed with an id is expanded, not discarded ───────────
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: { message: { items: [] } } }));
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'indonesia,crossref', max_results: 1 });
  h.restore();
  check('"indonesia,crossref" runs the Indonesian sources AND crossref',
    /^3 sources searched/.test(r.split('\n')[1]), r.split('\n')[1]);
  check('"indonesia" is not reported as an unknown source', !/unknown source \(ignored\): indonesia/.test(r));
}

done('D45 search argument handling and reporting');
