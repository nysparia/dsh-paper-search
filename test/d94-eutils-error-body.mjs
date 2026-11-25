// test/d94-eutils-error-body.mjs — `pubmed` and `pmc` turned an HTTP 200 error
// body into "0 results".
//
// THE DEFECT. E-utilities answers a transient backend failure with status 200
// and `{"esearchresult":{"ERROR":"…"}}` — no `idlist` at all. The connector read
// `esearchresult.idlist`, got `[]`, and returned an empty list, so the reply
// printed:
//
//   OK     PubMed             api       0 results  (0 ms)
//   NO results passed the filter.
//
// Measured live 25 Nov 2026 with `term=()`:
//
//   GET esearch.fcgi?db=pubmed&retmode=json&retmax=3&sort=relevance&term=()
//   HTTP 200
//   {"header":{"type":"esearch","version":"0.3"},
//    "esearchresult":{"ERROR":"Search Backend failed: An error occurred while
//    processing request. Status: 500. …"}}
//
// A transient failure reported as a successful empty answer is the one thing the
// reply's own contract forbids: "OK … 0 results" tells the caller PubMed has
// nothing on the topic.
//
// WHAT MUST STILL WORK. A genuine empty `idlist` (a query with no matches) is
// still a successful empty answer — it must NOT throw.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Route esearch/esummary separately; record every URL. */
function serve({ esearch, esummary = { result: {} } }) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const body = u.includes('/esearch.fcgi') ? esearch : esummary;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  return seen;
}

const BACKEND_FAILED = {
  header: { type: 'esearch', version: '0.3' },
  esearchresult: {
    ERROR: 'Search Backend failed: An error occurred while processing request. Status: 500. Source: /api/search/?r= Details: Search is temporarily unavailable. Please try again later. Details: Empty Term in the request',
  },
};

// ── 1. pubmed: the error body is a FAILURE, not an empty answer ───────────
{
  serve({ esearch: BACKEND_FAILED });
  const h = await searchSource('pubmed', '()', { rows: 3 });
  check('pubmed reports an error', h.error !== null, String(h.error));
  check('pubmed returns no papers', h.papers.length === 0, `${h.papers.length} paper(s)`);
  check('the error names the platform reason', /Search Backend failed/.test(String(h.error)), String(h.error));
}

// ── 2. pmc: the same body, the same rule ──────────────────────────────────
{
  serve({ esearch: BACKEND_FAILED });
  const h = await searchSource('pmc', '()', { rows: 3 });
  check('pmc reports an error', h.error !== null, String(h.error));
  check('pmc returns no papers', h.papers.length === 0, `${h.papers.length} paper(s)`);
}

// ── 3. A GENUINE empty result is still a successful empty answer ──────────
// `{"esearchresult":{"count":"0","idlist":[]}}` is what a query with no matches
// returns. It must not be turned into a failure.
{
  serve({ esearch: { esearchresult: { count: '0', idlist: [] } } });
  const h = await searchSource('pubmed', 'a query with no matches', { rows: 3 });
  check('pubmed: a real empty result is not an error', h.error === null, String(h.error));
  check('pubmed: a real empty result has no papers', h.papers.length === 0, `${h.papers.length} paper(s)`);
}

{
  serve({ esearch: { esearchresult: { count: '0', idlist: [] } } });
  const h = await searchSource('pmc', 'a query with no matches', { rows: 3 });
  check('pmc: a real empty result is not an error', h.error === null, String(h.error));
}

// ── 4. A normal reply still works ─────────────────────────────────────────
{
  serve({
    esearch: { esearchresult: { count: '1', idlist: ['30102808'] } },
    esummary: {
      result: {
        uids: ['30102808'],
        30102808: {
          title: 'eDoctor: machine learning and the future of medicine.',
          authors: [{ name: 'Handelman GS' }],
          pubdate: '2018 Dec',
          fulljournalname: 'Journal of internal medicine',
          pubtype: ['Journal Article', 'Review'],
          articleids: [{ idtype: 'doi', value: '10.1111/joim.12822' }],
        },
      },
    },
  });
  const h = await searchSource('pubmed', 'x', { rows: 1 });
  check('a normal reply has no error', h.error === null, String(h.error));
  check('a normal reply returns the record', h.papers.length === 1, `${h.papers.length} paper(s)`);
}

globalThis.fetch = realFetch;
console.log('\nD94 eutils error body: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
