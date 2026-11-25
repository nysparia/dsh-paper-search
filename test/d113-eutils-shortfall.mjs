// test/d113-eutils-shortfall.mjs — `pubmed` and `pmc` silently dropped ids that
// `esummary` did not return.
//
// THE DEFECT. `if (!r) return null` plus `.filter((p) => p && p.title)` removed
// the record with no count anywhere. Measured 25 Nov 2026 with a canned reply
// holding 3 ids and 2 records:
//
//   ids from esearch : 3
//   records in reply : 2
//   papers returned  : 2   error: null
//   any field counting the loss? id, papers, error, ms
//
// A page of 3 that yields 2 was indistinguishable from a page of 2.
//
// ── WHAT WAS CHOSEN, AND WHY ────────────────────────────────────────────────
//
// `searchSource` returns `{id, papers, error, ms}` and has no field for a
// shortfall, and hanging a count on the returned array is a trap for every
// `Array.isArray`/spread/JSON round-trip downstream. So:
//
//   • a TOTAL loss THROWS — the source did not answer the question, and the
//     reply must say FAILED rather than "0 results";
//   • a PARTIAL loss returns the records it did get, and the count of missing
//     ones is a KNOWN LIMITATION, stated in the connector's own comment. It is
//     not reported, because there is nowhere honest to report it.
//
// This test pins both halves so the limitation cannot quietly become a total
// loss, and the total loss cannot quietly become "0 results".

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve `ids` from esearch and only the records named in `records`. */
function serve(ids, records) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/esearch.fcgi')
      ? { esearchresult: { count: String(ids.length), idlist: ids } }
      : { result: Object.fromEntries(records.map((r) => [r.uid, r])) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}

const rec = (uid, title) => ({
  uid,
  title,
  authors: [{ name: 'A B' }],
  pubdate: '2024',
  pubtype: ['Journal Article'],
  articleids: [],
});

// ── 1. A TOTAL loss is a FAILURE, not "0 results" ─────────────────────────
{
  serve(['1', '2', '3'], []);
  const h = await searchSource('pubmed', 'x', { rows: 3 });
  check('pubmed: 3 ids and 0 records is an error', h.error !== null, String(h.error));
  check('pubmed: the error names the shortfall', /3 ids/.test(String(h.error)), String(h.error));
  check('pubmed: no papers are returned', h.papers.length === 0, `${h.papers.length} paper(s)`);
}

{
  serve(['1', '2'], []);
  const h = await searchSource('pmc', 'x', { rows: 2 });
  check('pmc: 2 ids and 0 records is an error', h.error !== null, String(h.error));
  check('pmc: the error names the shortfall', /2 ids/.test(String(h.error)), String(h.error));
}

// ── 2. A PARTIAL loss returns what it got, and is a stated limitation ─────
// This is the documented behaviour, not an accident: the records that DID come
// back are real and useful, and throwing them away would be worse than the
// unreported count.
{
  serve(['1', '2', '3'], [rec('1', 'First record'), rec('2', 'Second record')]);
  const h = await searchSource('pubmed', 'x', { rows: 3 });
  check('pubmed: a partial page is not an error', h.error === null, String(h.error));
  check('pubmed: the records that came back are returned', h.papers.length === 2, `${h.papers.length} paper(s)`);
  check('pubmed: the returned records are the right ones',
    h.papers.map((p) => p.title).join('|') === 'First record|Second record',
    h.papers.map((p) => p.title).join('|'));
}

{
  serve(['1', '2', '3'], [rec('1', 'First record'), rec('2', 'Second record')]);
  const h = await searchSource('pmc', 'x', { rows: 3 });
  check('pmc: a partial page is not an error', h.error === null, String(h.error));
  check('pmc: the records that came back are returned', h.papers.length === 2, `${h.papers.length} paper(s)`);
}

// ── 3. A COMPLETE page is unchanged ───────────────────────────────────────
{
  serve(['1', '2'], [rec('1', 'First record'), rec('2', 'Second record')]);
  const h = await searchSource('pubmed', 'x', { rows: 2 });
  check('a complete page has no error', h.error === null, String(h.error));
  check('a complete page returns every record', h.papers.length === 2, `${h.papers.length} paper(s)`);
}

// ── 4. A record with no title is still dropped, and still counts as a loss ─
// `makePaper` cannot produce a usable record without a title, so the filter
// stays — but it must not turn a page of 1 into a silent empty answer.
{
  serve(['1'], [{ uid: '1', title: '', authors: [], pubdate: '2024', articleids: [] }]);
  const h = await searchSource('pubmed', 'x', { rows: 1 });
  check('a page whose only record has no title is an error', h.error !== null, String(h.error));
}

globalThis.fetch = realFetch;
console.log('\nD96 eutils shortfall: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
