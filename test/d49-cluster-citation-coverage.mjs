// d49 — a PARTIAL citation sum was reported as the cluster total.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580): a 3-work cluster with one
// `cited_by_count: null` returned `totalCitations: 30`, and the reply printed
// "total 30 citations" — a definite number over a set that is partly unknown. A
// 20-work cluster with 19 unknown printed "total 5 citations". The comment in
// `summarizeCluster` claimed this was already fixed; the fix stopped at the
// all-unknown case, where the sum is `null`.
//
// The known sum stays, but it now travels with its coverage, and the caller
// prints the coverage whenever it is partial — so a partial sum cannot be read as
// a total. `null` still means "nothing known".

import { summarizeCluster } from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

const W = (id, extra) => ({ id: `https://openalex.org/${id}`, title: id, ...extra });

// ── 1. the summary carries its coverage ──────────────────────────────────────
{
  const partial = summarizeCluster([
    W('A', { cited_by_count: 10, publication_year: 2020 }),
    W('B', { cited_by_count: 20, publication_year: 2021 }),
    W('C', { cited_by_count: null, publication_year: 2022 }),
  ], ['A', 'B', 'C']);
  check('a partial sum still reports the known sum', partial.totalCitations === 30, `got ${JSON.stringify(partial.totalCitations)}`);
  check('…and says how many members it covers', partial.citedByKnown === 2, `got ${JSON.stringify(partial.citedByKnown)}`);
  check('…and how many it does not', partial.citedByUnknown === 1, `got ${JSON.stringify(partial.citedByUnknown)}`);
}
{
  const none = summarizeCluster([W('A', { cited_by_count: null }), W('B', {})], ['A', 'B']);
  check('nothing known -> totalCitations stays null', none.totalCitations === null, `got ${JSON.stringify(none.totalCitations)}`);
  check('nothing known -> 0 known, 2 unknown', none.citedByKnown === 0 && none.citedByUnknown === 2,
    `got ${JSON.stringify([none.citedByKnown, none.citedByUnknown])}`);
}
{
  const zeros = summarizeCluster([W('A', { cited_by_count: 0 }), W('B', { cited_by_count: 0 })], ['A', 'B']);
  check('a real 0 is still 0 and fully covered', zeros.totalCitations === 0 && zeros.citedByUnknown === 0,
    `got ${JSON.stringify([zeros.totalCitations, zeros.citedByUnknown])}`);
}

// ── 2. the reply prints the coverage when it is partial ──────────────────────
const SEED = {
  id: 'https://openalex.org/W1000', title: 'Seed', publication_year: 2010,
  cited_by_count: 50, referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
};
const CANDS = [
  { id: 'https://openalex.org/W1', title: 'One', publication_year: 2020, cited_by_count: 10, referenced_works: ['https://openalex.org/W9'] },
  { id: 'https://openalex.org/W2', title: 'Two', publication_year: 2021, cited_by_count: 20, referenced_works: ['https://openalex.org/W9'] },
  { id: 'https://openalex.org/W3', title: 'Three', publication_year: 2022, cited_by_count: null, referenced_works: ['https://openalex.org/W9'] },
];

function mapFetch(candidates) {
  return installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works/W1000') return { body: SEED };
    const filter = u.searchParams.get('filter') ?? '';
    if (filter.startsWith('cites:')) return { body: { results: candidates, meta: { count: candidates.length } } };
    return { body: { results: [] } };
  });
}

{
  const tools = loadTools();
  const h = mapFetch(CANDS);
  const r = await tools.get('paper_citations').execute({
    identifier: 'W1000', analysis: 'map', max_candidates: 5,
    // Loosened so the three candidates really land in ONE cluster.
    strong_threshold: 0.01, min_shared_strong: 1,
  });
  h.restore();
  const line = r.split('\n').find((l) => /^  cluster \d+:/.test(l)) ?? '';
  check('the cluster line states the partial coverage', /total 30 citations \(1 of 3 citation counts not reported\)/.test(line),
    line || 'no cluster line in the reply');
  check('the cluster line does not present 30 as a bare total', !/total 30 citations$/.test(line), line);
}

done('D49 cluster citation coverage');
