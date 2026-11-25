// d67 — `mapIsUseful` answered confidently on the wrong type, and the caller
// dropped the bar it was given.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580):
//
//   mapIsUseful({seedRefs: new Set(['a']), candidates: 0})
//     -> {"useful":false,"seedRefs":{},"candidates":0,"minCandidates":5}
//
// `seedRefs > 0` is a numeric comparison, so a Set — the natural thing to pass,
// and the type the caller holds — compares as NaN and a seed that HAS a reference
// is declared to have none. The echoed `seedRefs: {}` was uninterpretable.
//
// The caller half: it printed "OpenAlex records 0 references for this work and
// only 4 citing works." — no mention of the threshold 5 that made it "only", so
// the reader could not tell how close the run was, and `minCandidates` (returned
// specifically so it could be reported) was dropped. The same line said "citing
// works" unconditionally, which is wrong in `direction: 'references'`.

import { mapIsUseful } from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

// ── 1. a sized collection is a reference count ──────────────────────────────
{
  const r = mapIsUseful({ seedRefs: new Set(['a']), candidates: 0 });
  check('a non-empty Set counts as references', r.useful === true, JSON.stringify(r));
}
{
  const r = mapIsUseful({ seedRefs: new Set(), candidates: 0 });
  check('an empty Set still counts as none, and the echoed count is a NUMBER',
    r.useful === false && r.seedRefs === 0, JSON.stringify(r));
}
{
  const r = mapIsUseful({ seedRefs: 0, candidates: 4 });
  check('the bar is still >= minCandidates (4 of 5 is not useful) and is returned',
    r.useful === false && r.minCandidates === 5, JSON.stringify(r));
}
{
  check('a number still works', mapIsUseful({ seedRefs: 1, candidates: 0 }).useful === true);
}

// ── 2. the caller names the bar ─────────────────────────────────────────────
const BARE_SEED = {
  id: 'https://openalex.org/W1000', title: 'Seed', publication_year: 2020,
  cited_by_count: 3, referenced_works: [],
};
const FOUR = Array.from({ length: 4 }, (_, i) => ({
  id: `https://openalex.org/W${i + 1}`, title: `Citing ${i}`, publication_year: 2021,
  cited_by_count: 1, referenced_works: ['https://openalex.org/r1'],
}));

{
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works/W1000') return { body: BARE_SEED };
    const filter = u.searchParams.get('filter') ?? '';
    if (filter.startsWith('cites:')) return { body: { results: FOUR, meta: { count: FOUR.length } } };
    return { body: { results: [] } };
  });
  const tools = loadTools();
  const r = await tools.get('paper_citations').execute({ identifier: 'W1000', analysis: 'map', direction: 'citing', max_candidates: 5 });
  h.restore();
  check('the not-useful message names the bar it failed',
    /only 4 citing works — the map needs at least 5 candidates when the seed has no references\./.test(r),
    r.split('\n').find((l) => /only 4/.test(l)));
}

// The direction clause. `direction: 'references'` normally cannot reach this
// branch — a seed with no references yields no candidates, which hits the
// "fewer than 2 candidates" branch first. It is reachable when the seed's
// reference list is present but UNPARSEABLE: `mapCandidates` keeps the raw
// segments, `referenceSets` drops them, so the seed has 0 usable references and
// the batch still has works in it.
{
  const ODD_SEED = { ...BARE_SEED, referenced_works: ['   ', '  ', ' '] };
  const TWO = FOUR.slice(0, 2);
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works/W1000') return { body: ODD_SEED };
    const filter = u.searchParams.get('filter') ?? '';
    if (filter.startsWith('openalex_id:')) return { body: { results: TWO, meta: { count: TWO.length } } };
    return { body: { results: [] } };
  });
  const tools = loadTools();
  const r = await tools.get('paper_citations').execute({ identifier: 'W1000', analysis: 'map', direction: 'references', max_candidates: 5 });
  h.restore();
  check('in the references direction the message says "references", not "citing works"',
    /only 2 references — the map needs at least 5 candidates/.test(r) && !/only 2 citing works/.test(r),
    r.split('\n').find((l) => /only 2/.test(l)));
}

done('D67 mapIsUseful and the reported bar');
