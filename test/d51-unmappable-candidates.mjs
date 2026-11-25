// d51 — a candidate whose id did not survive `shortId` was dropped from the map
// but still counted as "checked".
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580):
//
//   shortId('https://openalex.org/W123/')  -> null   (trailing slash)
//   shortId('   ')                         -> '   '  (a truthy map key)
//   4 works in, referenceSets size 1, and the reply said "candidates checked: 4"
//
// Three works vanished with no mention: not as reference-less, not as
// unparseable. The cluster and bridge counts were then computed over a smaller
// population than the header stated — the "failed lookup reported as genuinely
// absent" shape.
//
// `shortId` now strips trailing slashes and whitespace, and the caller reports
// how many candidates actually entered the map.

// Namespace import, not named: `referenceSetsDetailed` does not exist on the
// unfixed module, and a missing export would abort the file before any assertion
// could report what is wrong.
import * as peta from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();
const { shortId, referenceSets } = peta;
const referenceSetsDetailed = peta.referenceSetsDetailed ?? (() => ({ map: new Map(), dropped: [] }));

// ── 1. shortId survives the shapes OpenAlex actually returns ─────────────────
check('a trailing slash is stripped, not turned into null',
  shortId('https://openalex.org/W123/') === 'W123', `got ${JSON.stringify(shortId('https://openalex.org/W123/'))}`);
check('several trailing slashes are stripped too',
  shortId('https://openalex.org/W123///') === 'W123', `got ${JSON.stringify(shortId('https://openalex.org/W123///'))}`);
check('a whitespace-only id is NOT a valid key',
  shortId('   ') === null, `got ${JSON.stringify(shortId('   '))}`);
check('a bare id still works', shortId('W123') === 'W123', `got ${JSON.stringify(shortId('W123'))}`);
check('a number still works', shortId(12345) === '12345', `got ${JSON.stringify(shortId(12345))}`);

// ── 2. the map reports what it could not take ────────────────────────────────
{
  const { map, dropped } = referenceSetsDetailed([
    { id: 'https://openalex.org/W1', referenced_works: ['https://openalex.org/r1'] },
    { id: 'https://openalex.org/W2/', referenced_works: ['https://openalex.org/r1'] },
    { id: '', referenced_works: ['https://openalex.org/r1'] },
    { id: null, referenced_works: ['https://openalex.org/r1'] },
  ]);
  check('a trailing-slash id enters the map', map.has('W2'), JSON.stringify([...map.keys()]));
  check('the unmappable records are returned, not silently skipped', dropped.length === 2, JSON.stringify(dropped));
  check('referenceSets still returns the plain map', referenceSets([{ id: 'W1' }]).size === 1);
}

// ── 3. the reply counts the MAP, not the array ───────────────────────────────
const SEED = {
  id: 'https://openalex.org/W1000', title: 'Seed', publication_year: 2010,
  cited_by_count: 50, referenced_works: ['https://openalex.org/W1'],
};

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
  const h = mapFetch([
    { id: 'https://openalex.org/W1', title: 'Kept', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1'] },
    { id: '', title: 'No id', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1'] },
    { id: null, title: 'Null id', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1'] },
    { id: '   ', title: 'Whitespace id', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1'] },
  ]);
  const r = await tools.get('paper_citations').execute({ identifier: 'W1000', analysis: 'map', max_candidates: 5 });
  h.restore();
  check('"candidates checked" is the map size, not the array length',
    /candidates checked: 1 of 4 recorded by OpenAlex/.test(r),
    r.split('\n').find((l) => /candidates checked/.test(l)));
  check('the dropped candidates are REPORTED',
    /NOTE: 3 of the 4 candidate record\(s\) could not be mapped — no usable OpenAlex id/.test(r),
    r.split('\n').find((l) => /could not be mapped/.test(l)));
}

// A trailing-slash id used to be dropped too, which could leave the map with one
// work and the reply claiming "Fewer than 2 candidates".
{
  const tools = loadTools();
  const h = mapFetch([
    { id: 'https://openalex.org/W1/', title: 'One', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1', 'https://openalex.org/r2', 'https://openalex.org/r3'] },
    { id: 'https://openalex.org/W2/', title: 'Two', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1', 'https://openalex.org/r2', 'https://openalex.org/r3'] },
    { id: 'https://openalex.org/W3/', title: 'Three', publication_year: 2015, cited_by_count: 10, referenced_works: ['https://openalex.org/r1', 'https://openalex.org/r2', 'https://openalex.org/r3'] },
  ]);
  const r = await tools.get('paper_citations').execute({ identifier: 'W1000', analysis: 'map', max_candidates: 5 });
  h.restore();
  // On the unfixed code all three are dropped, the map is empty, and the reply
  // says "Fewer than 2 candidates" — so the cluster line is the honest check.
  check('trailing-slash candidates are mapped, so all three form one cluster',
    /cluster 1: 3 works/.test(r),
    r.split('\n').find((l) => /^  cluster \d+:/.test(l)) ?? r.split('\n').find((l) => /Fewer than 2/.test(l)));
}

done('D51 unmappable candidates');
