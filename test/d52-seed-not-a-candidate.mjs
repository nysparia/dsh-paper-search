// d52 — the SEED was counted as a candidate against itself.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580), with a seed whose
// `referenced_works` contains its own id and `direction: 'references'` (where the
// candidate list IS the seed's reference list, so the seed comes back as a
// candidate):
//
//   -- most in the same field as the seed --
//      1. [1.000] The seed  (2020 · 50 citations · 4 shared of 4 · W9000)
//   -- shared foundation --
//     [3x] W1   [3x] W2   [1x] W3   [1x] W9000
//
// The seed is the thing being compared AGAINST, not a candidate. Both lines are
// tautologies presented as findings, and the seed's own id in `seedRefs` also
// inflates `shared` for every candidate that cites the seed.
//
// The audit sampled 205 live OpenAlex works and found 0 self-citing records, so
// this is rare — but the failure is maximally confident when it happens, which is
// why it is excluded in `peta.js` AND filtered out by the caller.

import { referenceSets, closenessToSeed, coCitation } from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

// ── 1. the seed is not a candidate, and its own id is not a reference ────────
const SEED = {
  id: 'https://openalex.org/W9000', title: 'The seed', publication_year: 2020, cited_by_count: 50,
  referenced_works: ['https://openalex.org/W9000', 'https://openalex.org/W1', 'https://openalex.org/W2'],
};
const C1 = {
  id: 'https://openalex.org/W1', title: 'ref 1', publication_year: 2015, cited_by_count: 10,
  // Cites the seed itself, which is NOT a shared reference.
  referenced_works: ['https://openalex.org/W9000', 'https://openalex.org/W1', 'https://openalex.org/W2', 'https://openalex.org/W9'],
};
const seedRefs = referenceSets([SEED]).get('W9000');

{
  const close = closenessToSeed([SEED, C1], seedRefs, { seedId: 'W9000' });
  check('the seed is not a candidate against itself', !close.some((d) => d.id === 'W9000'),
    JSON.stringify(close.map((d) => d.id)));
  check('…so nothing is ranked at coupling 1.000', !close.some((d) => d.coupling === 1),
    JSON.stringify(close.map((d) => d.coupling)));
  check('a candidate citing the seed is not credited with a shared reference',
    close[0].shared === 2, `got ${JSON.stringify(close[0].shared)}`);
}
{
  const cc = coCitation([SEED, C1], seedRefs, { seedId: 'W9000' });
  check('the seed is not a citer of its own references', !cc.some((x) => x.id === 'W9000'),
    JSON.stringify(cc));
  check('…and the counts do not include it', cc.find((x) => x.id === 'W1')?.by === 1,
    JSON.stringify(cc));
}

// ── 2. the caller filters the seed out and says so ───────────────────────────
const REF_WORKS = [
  SEED,
  C1,
  { id: 'https://openalex.org/W2', title: 'ref 2', publication_year: 2016, cited_by_count: 20, referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'] },
  { id: 'https://openalex.org/W3', title: 'ref 3', publication_year: 2017, cited_by_count: 5, referenced_works: ['https://openalex.org/W1'] },
];

const h = installFetch((url) => {
  const u = new URL(url);
  if (u.pathname === '/works/W9000') return { body: SEED };
  const filter = u.searchParams.get('filter') ?? '';
  // The candidate fetch for `direction: 'references'` asks for the seed's own
  // reference list, which contains the seed. The title fetch never does.
  if (filter.startsWith('openalex_id:') && filter.includes('W9000')) {
    return { body: { results: REF_WORKS, meta: { count: REF_WORKS.length } } };
  }
  return { body: { results: [] } };
});
const tools = loadTools();
const r = await tools.get('paper_citations').execute({
  identifier: 'W9000', analysis: 'map', direction: 'references', max_candidates: 10,
});
h.restore();

check('the reply says the seed was excluded from its own candidate list',
  /NOTE: the seed's own record came back in its candidate list and was EXCLUDED from the comparisons below/.test(r),
  r.split('\n').find((l) => /EXCLUDED/.test(l)));
check('the seed is NOT the top "most in the same field" hit', !/\[1\.000\] The seed/.test(r),
  r.split('\n').find((l) => /\[1\.000\]/.test(l)));
check('the seed\'s own id is named as excluded from its reference list',
  /one of them is the seed itself — excluded from the comparisons below/.test(r),
  r.split('\n').find((l) => /references recorded on the seed/.test(l)));
// The co-citation rows print the reference id on their second line; the seed's
// own id must not be one of them.
check('the seed is not listed as a shared foundation of itself', !/citations · W9000/.test(r),
  r.split('\n').find((l) => /citations · W9000/.test(l)));

done('D52 the seed is not a candidate');
