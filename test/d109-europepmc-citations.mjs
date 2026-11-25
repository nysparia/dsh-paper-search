// test/d109-europepmc-citations.mjs — `europepmc` never mapped `citedByCount`,
// so `citedBy` was always `null`.
//
// THE DEFECT. Europe PMC's reply carries the count in the DEFAULT
// (`resultType=lite`) response, and the connector's `makePaper` call simply had
// no `citedBy` key.
//
// Measured live 25 Nov 2026:
//
//   GET /europepmc/webservices/rest/search?query=DOI:"10.1111/joim.12822"
//       &format=json&pageSize=2&resultType=lite
//     -> {"id":"30102808","pubType":"review; journal article",
//         "citedByCount":740,"isOpenAccess":"N", …}
//
// The consequence was the same as `d31`/`d91`: `min_citations` dropped every
// Europe PMC record while the reply said the source does not report a count.
//
// WHAT MUST STILL WORK. A reply without the field must yield `null`, not 0.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Europe PMC reply. */
function serve(results) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ resultList: { result: results } }),
  });
}

// ── 1. The count is MAPPED ────────────────────────────────────────────────
{
  serve([{ id: '30102808', title: 'eDoctor: machine learning and the future of medicine', pubYear: '2018', citedByCount: 740 }]);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  check('citedByCount reaches citedBy', h.papers[0]?.citedBy === 740,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 2. A real 0 stays 0 ───────────────────────────────────────────────────
// Europe PMC reports `citedByCount: 0` for a brand-new paper (measured live on
// PMID 43025392). That is a real zero, not an absence.
{
  serve([{ id: '43025392', title: 'A brand new paper', pubYear: '2026', citedByCount: 0 }]);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  check('a reported 0 stays 0', h.papers[0]?.citedBy === 0, JSON.stringify(h.papers[0]?.citedBy));
}

// ── 3. An ABSENT field is still null ──────────────────────────────────────
{
  serve([{ id: '1', title: 'A record with no count', pubYear: '2020' }]);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  check('an absent field is null, not 0', h.papers[0]?.citedBy === null,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 4. The count survives into the filter ─────────────────────────────────
{
  const { filterAndSort } = await import('../lib/index.js');
  serve([{ id: '30102808', title: 'A well cited review', pubYear: '2018', citedByCount: 740 }]);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  const f = filterAndSort(h.papers, { minCitations: 10 });
  check('min_citations keeps the record', f.papers.length === 1,
    `${f.papers.length} kept, dropped=${JSON.stringify(f.dropped)}`);
  check('min_citations does not count it as "no citation count"', f.dropped.noCitations === 0,
    JSON.stringify(f.dropped));
}

globalThis.fetch = realFetch;
console.log('\nD92 europepmc citations: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
