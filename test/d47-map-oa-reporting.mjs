// d47 — the citation map and `paper_oa` reporting.
//
// Five defects, all measured 24 Nov 2026 on 0.6.9 (HEAD 148f7c4):
//
//   1. `direction: 'cites'` resolved to `references` — works CITED BY the paper —
//      with no warning, while the word most naturally means "papers that cite
//      this work". The caller got the OPPOSITE direction.
//   2. The map printed one message for two opposite facts: "(not one candidate
//      shares a reference with the seed)" appeared both when the candidates HAD
//      reference lists that shared nothing and when they had NONE at all.
//   3. The map's LIMITS line said reference-less works "show up with closeness 0",
//      but the list filters to coupling > 0, so they never appear.
//   4. The cluster list was capped at 6 while the header stated the true count.
//   5. `max_candidates` was clamped silently.
//
// Plus: the "fewer than 2 candidates" advice named the "citing" direction even
// when the caller asked for "references", and `paper_oa` reported a work with no
// `open_access` block as "OpenAlex sees no free copy".

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

const SEED_REFS = Array.from({ length: 40 }, (_, i) => `https://openalex.org/R${i}`);
const SEED = {
  id: 'https://openalex.org/W1', title: 'Seed', publication_year: 2010,
  cited_by_count: 50, referenced_works: SEED_REFS,
};

/** A fetch that answers the seed, the candidate list, and the shared-ref titles. */
function mapFetch(candidates, { total = null } = {}) {
  return installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works/W1') return { body: SEED };
    const filter = u.searchParams.get('filter') ?? '';
    if (filter.startsWith('cites:')) return { body: { results: candidates, meta: { count: total ?? candidates.length } } };
    if (filter.startsWith('openalex_id:')) {
      const ids = filter.slice('openalex_id:'.length).split('|');
      return { body: { results: ids.map((id) => ({ id: `https://openalex.org/${id}`, title: `Ref ${id}`, publication_year: 1990, cited_by_count: 50 })) } };
    }
    return { body: { results: [] } };
  });
}

/** N candidates that all share the first 5 seed references. */
function sharingCandidates(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `https://openalex.org/WS${i}`, title: `Shares ${i}`, publication_year: 2015,
    cited_by_count: 10, referenced_works: SEED_REFS.slice(0, 5),
  }));
}

/** N candidates with NO reference list at all. */
function referenceLessCandidates(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `https://openalex.org/WN${i}`, title: `NoRefs ${i}`, publication_year: 2015,
    cited_by_count: 10, referenced_works: [],
  }));
}

// ── 1. "cites" is not silently read as BACKWARD ──────────────────────────────
{
  const tools = loadTools();
  const h = mapFetch(sharingCandidates(3));
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', direction: 'cites' });
  h.restore();
  check('direction:"cites" is WARNED about', /WARNING: direction "cites" is not recognized/.test(r));
  check('direction:"cites" does NOT silently become references', !/direction: references/.test(r));
}
{
  const tools = loadTools();
  const h = mapFetch(sharingCandidates(3));
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', direction: 'cited' });
  h.restore();
  check('direction:"cited" still means references (unambiguous)', /direction: references/.test(r));
}

// ── 2. the two zero-coupling cases get different messages ────────────────────
{
  const tools = loadTools();
  const h = mapFetch(referenceLessCandidates(5));
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', max_candidates: 5 });
  h.restore();
  check('all-reference-less candidates: says closeness CANNOT be measured',
    /has a reference list in OpenAlex, so closeness CANNOT be measured/.test(r));
  check('all-reference-less candidates: does NOT claim they share nothing',
    !/not one candidate shares a reference/.test(r));
}
{
  const tools = loadTools();
  const other = Array.from({ length: 5 }, (_, i) => ({
    id: `https://openalex.org/WX${i}`, title: `Other ${i}`, publication_year: 2015,
    cited_by_count: 10, referenced_works: ['https://openalex.org/Z1', 'https://openalex.org/Z2'],
  }));
  const h = mapFetch(other);
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', max_candidates: 5 });
  h.restore();
  check('candidates WITH references that share none: says exactly that',
    /not one candidate shares a reference with the seed/.test(r));
}

// ── 3. the LIMITS line describes what the code does ──────────────────────────
{
  const tools = loadTools();
  const h = mapFetch(sharingCandidates(5));
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', max_candidates: 5 });
  h.restore();
  check('LIMITS says reference-less works are OMITTED, not shown as 0',
    /are OMITTED from the closeness list/.test(r));
  check('LIMITS no longer claims they "show up with closeness 0"',
    !/show up with closeness 0/.test(r));
}

// ── 4. the cluster cap is stated ─────────────────────────────────────────────
{
  const tools = loadTools();
  // 8 disjoint pairs -> 8 clusters.
  const cands = [];
  for (let c = 0; c < 8; c++) {
    for (let m = 0; m < 2; m++) {
      cands.push({
        id: `https://openalex.org/W${c}${m}`, title: `Cluster${c} member${m}`, publication_year: 2015,
        cited_by_count: 10, referenced_works: SEED_REFS.slice(c * 5, c * 5 + 5),
      });
    }
  }
  const h = mapFetch(cands);
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', max_candidates: 16 });
  h.restore();
  const shown = r.split('\n').filter((l) => /^  cluster \d+:/.test(l)).length;
  check('the cluster list is capped at 6', shown === 6, `shown=${shown}`);
  check('the cap is STATED', /2 more cluster\(s\) NOT LISTED/.test(r), r.split('\n').find((l) => /NOT LISTED/.test(l)));
}

// ── 5. max_candidates is clamped with a note ─────────────────────────────────
{
  const tools = loadTools();
  const h = mapFetch(sharingCandidates(5));
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', max_candidates: 100 });
  h.restore();
  check('max_candidates 100 is clamped to 50 and SAID', /max_candidates was 100 — 50 was used/.test(r));
}

// ── 6. the "fewer than 2 candidates" advice names the direction used ─────────
{
  const tools = loadTools();
  // The references direction reads the SEED's own reference list, so the seed
  // must have none for that direction to reach the "fewer than 2" branch.
  const bare = { ...SEED, referenced_works: [] };
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works/W1') return { body: bare };
    return { body: { results: [], meta: { count: 0 } } };
  });
  const citing = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', direction: 'citing' });
  const refs = await tools.get('paper_citations').execute({ identifier: 'W1', analysis: 'map', direction: 'references' });
  h.restore();
  check('citing advice names "citing"', /If the "citing" direction returns little/.test(citing));
  check('references advice names "references"', /the "references" direction returns little/.test(refs));
  check('references advice does NOT name "citing"', !/If the "citing" direction/.test(refs));
}

// ── 7. paper_oa does not call missing data "closed" ──────────────────────────
//
// This one needs `summarizeOA` (lib/sources.js) to return `isOa: null` for a work
// whose reply carries no `open_access` block. The index.js side is ready for it;
// until that branch lands the old `false` flows through and these two assertions
// would fail for a reason outside this file. They are kept so the merge is
// checked, and skipped while the dependency is missing.
{
  const { summarizeOA } = await import('../lib/sources.js');
  const reportsUnknown = summarizeOA({ id: 'W1', title: 'x' }).isOa === null;
  if (!reportsUnknown) {
    console.log('SKIP  paper_oa unknown-vs-closed — summarizeOA still returns false for a missing block (lib/sources.js, other branch)');
  } else {
    const tools = loadTools();
    const h = installFetch(() => ({ body: { id: 'https://openalex.org/W1', title: 'No OA field', publication_year: 2020 } }));
    const r = await tools.get('paper_oa').execute({ identifier: 'W1' });
    h.restore();
    check('a work with no open_access block is NOT reported as closed',
      !/NOT OPEN ACCESS/.test(r), r.split('\n').find((l) => /access status/.test(l)));
    check('it says the status was NOT REPORTED', /NOT REPORTED/.test(r));
  }
}

done('D47 citation map and paper_oa reporting');
