// test/d9-cluster-unknown-citations.mjs — D9: `summarizeCluster` reported 0 citations
// when every member's count was unknown.
//
// Measured on baseline 864a6e8:
//   summarizeCluster([{cited_by_count:null},{cited_by_count:null}], ['W1','W2']).totalCitations
//     -> 0
//
// `Number(null)` is 0, so "not reported" became "zero". This is the same bug the
// codebase already fixed in `detailOfWork`, `closenessToSeed` and `workNumber`;
// `peta.js` was missed.
import { summarizeCluster } from '../lib/peta.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const works = [
  { id: 'https://openalex.org/W1', cited_by_count: null, publication_year: 2020 },
  { id: 'https://openalex.org/W2', cited_by_count: null, publication_year: 2021 },
];
const allUnknown = summarizeCluster(works, ['W1', 'W2']);
check('all-unknown -> null, not 0', allUnknown.totalCitations === null, `got ${JSON.stringify(allUnknown.totalCitations)}`);

const mixed = summarizeCluster([
  { id: 'https://openalex.org/W1', cited_by_count: 7, publication_year: 2020 },
  { id: 'https://openalex.org/W2', cited_by_count: null, publication_year: 2021 },
  { id: 'https://openalex.org/W3', cited_by_count: 5, publication_year: 2022 },
], ['W1', 'W2', 'W3']);
check('mixed -> the sum of the known ones', mixed.totalCitations === 12, `got ${JSON.stringify(mixed.totalCitations)}`);

const zero = summarizeCluster([
  { id: 'https://openalex.org/W1', cited_by_count: 0, publication_year: 2020 },
  { id: 'https://openalex.org/W2', cited_by_count: 0, publication_year: 2021 },
], ['W1', 'W2']);
check('a real 0 is still 0, not null', zero.totalCitations === 0, `got ${JSON.stringify(zero.totalCitations)}`);

// The caller must print `?` for an unknown total instead of `0`.
const { installFetch, loadTools } = await import('./harness.mjs');
const mock = installFetch((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    return {
      body: {
        id: 'https://openalex.org/W1000',
        doi: 'https://doi.org/10.1038/nature14539',
        title: 'Seed paper',
        publication_year: 2015,
        cited_by_count: 100,
        referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
      },
    };
  }
  if (url.includes('cites%3AW1000') || url.includes('cites:W1000')) {
    return {
      body: {
        meta: { count: 2 },
        results: [
          { id: 'https://openalex.org/W1', title: 'Candidate one', publication_year: 2020, cited_by_count: null, referenced_works: ['https://openalex.org/W9'] },
          { id: 'https://openalex.org/W2', title: 'Candidate two', publication_year: 2021, cited_by_count: null, referenced_works: ['https://openalex.org/W9'] },
        ],
      },
    };
  }
  if (url.includes('api.openalex.org/works')) return { body: { results: [], meta: { count: 0 } } };
  return { status: 404, body: 'not mocked' };
});
const tools = await loadTools();
const reply = await tools.get('paper_citations').execute({
  identifier: '10.1038/nature14539', analysis: 'map', max_candidates: 5,
  // Loosened so the two candidates really land in ONE cluster — a 2-member
  // cluster is the case the defect was measured on.
  strong_threshold: 0.01, min_shared_strong: 1,
});
mock.restore();

const clusterLine = reply.split('\n').find((l) => /cluster \d+:/.test(l)) ?? '';
check('the map reply prints ? for an unknown cluster total', /total \? citations/.test(clusterLine), clusterLine || 'no cluster line in the reply');
check('the map reply does not print "total 0 citations"', !/total 0 citations/.test(reply));

done('D9 unknown cluster citations');
