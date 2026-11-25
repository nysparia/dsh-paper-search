// d54 — `yearMin`/`yearMax` came from a silent subset, and the sanity window was
// arbitrary in both directions.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580):
//
//   one garbage year 99999     yearMin=2020 yearMax=99999
//   one garbage year 1e9       yearMin=2020 yearMax=1000000000
//   year 1500 (dropped)        yearMin=2020 yearMax=2020
//   one known + one unknown    "2020-2020" for a 3-work cluster
//
// `.filter(t => t > 1500)` dropped every unknown year without saying so, so
// "2020-2020" read as "every work in this cluster is from 2020" when two of the
// three had no usable year — while a single bad record could define the upper
// bound. The window is now 1500..currentYear+2, and the coverage is reported.

import { summarizeCluster } from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

const W = (id, y) => ({ id: `https://openalex.org/${id}`, title: id, publication_year: y });
const sum = (years) => {
  const ws = years.map((y, i) => W(`W${i}`, y));
  return summarizeCluster(ws, ws.map((w) => w.id.split('/').pop()));
};

// ── 1. the summary carries its year coverage ────────────────────────────────
{
  const r = sum([2020, null, 'n/a']);
  check('the year range is still computed from the known years', r.yearMin === 2020 && r.yearMax === 2020,
    `${r.yearMin}-${r.yearMax}`);
  check('…and says how many members contributed a year', r.yearsKnown === 1, `got ${JSON.stringify(r.yearsKnown)}`);
  check('…and how many did not', r.yearsUnknown === 2, `got ${JSON.stringify(r.yearsUnknown)}`);
}
{
  const r = sum([2020, 2021, 2022]);
  check('a fully known cluster reports no missing years', r.yearsKnown === 3 && r.yearsUnknown === 0,
    JSON.stringify([r.yearsKnown, r.yearsUnknown]));
}

// ── 2. the sanity window is defensible in both directions ───────────────────
{
  const r = sum([2020, 99999]);
  check('a year of 99999 is rejected, not used as the upper bound', r.yearMax === 2020, `got ${r.yearMax}`);
  check('…and it is counted as unknown', r.yearsUnknown === 1, `got ${JSON.stringify(r.yearsUnknown)}`);
}
{
  const r = sum([2020, 1e9]);
  check('a year of 1e9 is rejected', r.yearMax === 2020, `got ${r.yearMax}`);
}
{
  const r = sum([2020, 1500]);
  check('a year of 1500 is KEPT (it is a real year, not garbage)', r.yearMin === 1500, `got ${r.yearMin}`);
}
{
  const r = sum([2020, 0]);
  check('a year of 0 is rejected', r.yearMin === 2020 && r.yearsUnknown === 1, `${r.yearMin} / ${r.yearsUnknown}`);
}
{
  const r = sum([null, undefined, 'n/a']);
  check('no usable year at all -> null range and 0 known', r.yearMin === null && r.yearMax === null && r.yearsKnown === 0,
    JSON.stringify([r.yearMin, r.yearMax, r.yearsKnown]));
}

// ── 3. the reply prints the coverage when it is partial ─────────────────────
const SEED = {
  id: 'https://openalex.org/W1000', title: 'Seed', publication_year: 2010,
  cited_by_count: 50, referenced_works: ['https://openalex.org/W1'],
};
const CANDS = [
  { id: 'https://openalex.org/W1', title: 'One', publication_year: 2020, cited_by_count: 10, referenced_works: ['https://openalex.org/W9'] },
  { id: 'https://openalex.org/W2', title: 'Two', publication_year: null, cited_by_count: 20, referenced_works: ['https://openalex.org/W9'] },
  { id: 'https://openalex.org/W3', title: 'Three', publication_year: 'n/a', cited_by_count: 30, referenced_works: ['https://openalex.org/W9'] },
];
const h = installFetch((url) => {
  const u = new URL(url);
  if (u.pathname === '/works/W1000') return { body: SEED };
  const filter = u.searchParams.get('filter') ?? '';
  if (filter.startsWith('cites:')) return { body: { results: CANDS, meta: { count: CANDS.length } } };
  return { body: { results: [] } };
});
const tools = loadTools();
const r = await tools.get('paper_citations').execute({
  identifier: 'W1000', analysis: 'map', max_candidates: 5,
  strong_threshold: 0.01, min_shared_strong: 1,
});
h.restore();
const line = r.split('\n').find((l) => /^  cluster \d+:/.test(l)) ?? '';
check('the cluster line states the partial year coverage', /2020-2020 .*\(2 of 3 years not reported\)/.test(line),
  line || 'no cluster line in the reply');
check('the coverage is the LAST thing on the line, so the range cannot be read as complete',
  /\(2 of 3 years not reported\)$/.test(line), line);

done('D54 cluster year coverage');
