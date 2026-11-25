// test/d118-rows-clamp.mjs — `rows` was forwarded verbatim, so `rows: 0` became
// "0 results" and DOAJ's silent clamp was invisible.
//
// THE DEFECT. `rows: 0` went straight into the request. Measured live
// 25 Nov 2026:
//
//   GET api.crossref.org/works?query=cancer&rows=0&select=DOI,title   HTTP 200
//     {"status":"ok","message":{"total-results":3360771,"items":[]}}
//   GET doaj.org/api/search/articles/cancer?pageSize=0
//     -> {"pageSize":10,"results":[10 items]}      (0 is IGNORED)
//   GET doaj.org/api/search/articles/cancer?pageSize=51
//     -> {"pageSize":50,"results":[50 items]}      (silently clamped)
//
// So a query with 3.3 million matches was reported as "0 results", and a request
// for 100 rows was reported as 50 with nothing saying the page was cut.
//
// `paper_search` clamps `max_results` to 1–50 (`lib/index.js:665`), so this is
// reachable only through the exported `searchSource` — which is exactly why the
// connectors clamp too.
//
// ── WHAT WAS CHOSEN, AND WHY ────────────────────────────────────────────────
//
// `rows` is CLAMPED to 1–50 inside the connectors this branch owns, rather than
// rejected: a source that answered must still be reported as answered, and "at
// least one result" is a truthful answer to a request for zero. A platform that
// serves FEWER rows than asked is a different thing — that is the platform
// refusing, and `doaj` throws for it so the shortfall is never silent.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned body and record every request URL. */
function serve(body) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return seen;
}

const param = (url, name) => new URL(url).searchParams.get(name);

// ── 1. rows: 0 is clamped to 1, not forwarded ─────────────────────────────
{
  const seen = serve({ pageSize: 1, results: [{ bibjson: { title: 'A DOAJ record', year: '2020' } }] });
  const h = await searchSource('doaj', 'x', { rows: 0 });
  check('doaj sends pageSize=1 for rows:0', param(seen[0], 'pageSize') === '1', param(seen[0], 'pageSize'));
  check('doaj returns the record instead of "0 results"', h.papers.length === 1, `${h.papers.length} paper(s)`);
  check('doaj reports no error', h.error === null, String(h.error));
}

{
  const seen = serve({ data: [{ title: 'A Semantic Scholar record', year: 2020 }] });
  await searchSource('semantic', 'x', { rows: 0 });
  check('semantic sends limit=1 for rows:0', param(seen[0], 'limit') === '1', param(seen[0], 'limit'));
}

{
  const seen = serve({ resultList: { result: [{ id: '1', title: 'A Europe PMC record', pubYear: '2020' }] } });
  await searchSource('europepmc', 'x', { rows: 0 });
  check('europepmc sends pageSize=1 for rows:0', param(seen[0], 'pageSize') === '1', param(seen[0], 'pageSize'));
}

{
  const seen = serve({ esearchresult: { count: '0', idlist: [] } });
  await searchSource('pubmed', 'x', { rows: 0 });
  check('pubmed sends retmax=1 for rows:0', param(seen[0], 'retmax') === '1', param(seen[0], 'retmax'));
}

{
  const seen = serve({ esearchresult: { count: '0', idlist: [] } });
  await searchSource('pmc', 'x', { rows: 0 });
  check('pmc sends retmax=1 for rows:0', param(seen[0], 'retmax') === '1', param(seen[0], 'retmax'));
}

{
  const seen = serve({ results: [{ title: 'A CORE record', yearPublished: 2020 }] });
  await searchSource('core', 'x', { rows: 0, coreApiKey: 'k' });
  check('core sends limit=1 for rows:0', param(seen[0], 'limit') === '1', param(seen[0], 'limit'));
}

// ── 2. rows above the cap is clamped to 50 ────────────────────────────────
{
  const seen = serve({ pageSize: 50, results: [] });
  await searchSource('doaj', 'x', { rows: 100 });
  check('doaj sends pageSize=50 for rows:100', param(seen[0], 'pageSize') === '50', param(seen[0], 'pageSize'));
}

{
  const seen = serve({ data: [] });
  await searchSource('semantic', 'x', { rows: 100 });
  check('semantic sends limit=50 for rows:100', param(seen[0], 'limit') === '50', param(seen[0], 'limit'));
}

// ── 3. A normal rows value is forwarded unchanged ─────────────────────────
{
  const seen = serve({ pageSize: 7, results: [] });
  await searchSource('doaj', 'x', { rows: 7 });
  check('doaj forwards rows:7 unchanged', param(seen[0], 'pageSize') === '7', param(seen[0], 'pageSize'));
}

// ── 4. DOAJ serving FEWER rows than asked is a FAILURE, not a quiet page ──
// This is the platform refusing, and the reply must not print "10 results" for
// a request for 50 as if that were the whole answer.
{
  serve({ pageSize: 10, results: Array.from({ length: 10 }, (_, i) => ({ bibjson: { title: `Record ${i}`, year: '2020' } })) });
  const h = await searchSource('doaj', 'x', { rows: 50 });
  check('doaj reports an error when it serves fewer rows than asked', h.error !== null, String(h.error));
  check('the error names both numbers', /10/.test(String(h.error)) && /50/.test(String(h.error)), String(h.error));
}

// ── 5. A reply that does not state pageSize is not treated as a shortfall ─
{
  serve({ results: [{ bibjson: { title: 'A DOAJ record', year: '2020' } }] });
  const h = await searchSource('doaj', 'x', { rows: 5 });
  check('a reply without pageSize is not an error', h.error === null, String(h.error));
  check('a reply without pageSize still returns its records', h.papers.length === 1, `${h.papers.length} paper(s)`);
}

globalThis.fetch = realFetch;
console.log('\nD101 rows clamp: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
