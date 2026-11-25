// test/d105-open-access-unknown.mjs — "not reported" was collapsed into
// "closed", so the search record contradicted `paper_oa` about the same work.
//
// ── L7: `!!` IN `makePaper` / `fromOpenAlexWork` ───────────────────────────
//
// `openAccess: !!p.openAccess` turned a missing flag into a definite `false`.
// Measured 25 Nov 2026 with an OpenAlex work whose `open_access` block was
// absent:
//
//   search record: openAccess=false
//   summarizeOA:   {"isOa":null,"reported":false,...}
//
// The same work was "not open access" on the search path and "not reported"
// through `paper_oa`. Nothing printed a false negative (the reply shows
// `· open access` only when true, and `open_access_only` is documented to drop
// unknowns), but two paths must not contradict each other about the same work —
// and `summarizeOA` in the same file already models this correctly with
// `isOa: true|false|null`. The search record now uses the same three values.
//
// ── L8: `zenodoOpenAccess` MAPPED AN UNRECOGNISED VALUE TO `false` ─────────
//
// `return v === 'open'` made every other value a definite negative. Measured
// 25 Nov 2026 against the mapping: `open_access` -> false, `public` -> false,
// absent -> false. The four documented values are right; anything outside them
// is now `null` ("unknown"), so `open_access_only` no longer drops it silently
// as if the platform had said "closed".
//
// WHAT MUST STILL WORK. `true` and `false` are still produced by the values that
// really mean them, and `open_access_only` still keeps exactly the open ones.

import { searchSource, summarizeOA } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned JSON body for every request. */
function serve(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
}

// ── 1. L8: Zenodo's four documented values are still true/false ───────────
{
  serve({
    hits: {
      hits: [
        { metadata: { title: 'Open', access_right: 'open' }, links: { self_html: 'https://zenodo.org/records/1' } },
        { metadata: { title: 'Restricted', access_right: 'restricted' }, links: { self_html: 'https://zenodo.org/records/2' } },
        { metadata: { title: 'Embargoed', access_right: 'embargoed' }, links: { self_html: 'https://zenodo.org/records/3' } },
        { metadata: { title: 'Closed', access_right: 'closed' }, links: { self_html: 'https://zenodo.org/records/4' } },
      ],
    },
  });
  const h = await searchSource('zenodo', 'x', { rows: 4 });
  const byTitle = (t) => h.papers.find((p) => p.title === t);
  check('access_right "open" is true', byTitle('Open')?.openAccess === true, JSON.stringify(byTitle('Open')?.openAccess));
  check('access_right "restricted" is false', byTitle('Restricted')?.openAccess === false, JSON.stringify(byTitle('Restricted')?.openAccess));
  check('access_right "embargoed" is false', byTitle('Embargoed')?.openAccess === false, JSON.stringify(byTitle('Embargoed')?.openAccess));
  check('access_right "closed" is false', byTitle('Closed')?.openAccess === false, JSON.stringify(byTitle('Closed')?.openAccess));
}

// ── 2. L8: an UNRECOGNISED access_right is unknown, not "closed" ──────────
{
  serve({
    hits: {
      hits: [
        { metadata: { title: 'Open Access Spelling', access_right: 'open_access' }, links: { self_html: 'https://zenodo.org/records/5' } },
        { metadata: { title: 'Public Spelling', access_right: 'public' }, links: { self_html: 'https://zenodo.org/records/6' } },
        { metadata: { title: 'No Field' }, links: { self_html: 'https://zenodo.org/records/7' } },
      ],
    },
  });
  const h = await searchSource('zenodo', 'x', { rows: 3 });
  const byTitle = (t) => h.papers.find((p) => p.title === t);
  check('access_right "open_access" is UNKNOWN, not false',
    byTitle('Open Access Spelling')?.openAccess === null, JSON.stringify(byTitle('Open Access Spelling')?.openAccess));
  check('access_right "public" is UNKNOWN, not false',
    byTitle('Public Spelling')?.openAccess === null, JSON.stringify(byTitle('Public Spelling')?.openAccess));
  check('a record with no access_right is UNKNOWN',
    byTitle('No Field')?.openAccess === null, JSON.stringify(byTitle('No Field')?.openAccess));
}

// ── 3. L7: the OpenAlex search record agrees with `summarizeOA` ───────────
{
  const work = {
    id: 'https://openalex.org/W1',
    title: 'A Work With No open_access Block',
    publication_year: 2020,
    doi: 'https://doi.org/10.1234/unknown',
  };
  serve({ results: [work] });
  const h = await searchSource('openalex', 'x', { rows: 1 });
  const summary = summarizeOA(work);
  check('a work with no open_access block is UNKNOWN on the search path',
    h.papers[0]?.openAccess === null, JSON.stringify(h.papers[0]?.openAccess));
  check('and summarizeOA agrees', summary.isOa === null && summary.reported === false, JSON.stringify(summary.isOa));
  check('the two paths do not contradict each other', h.papers[0]?.openAccess === summary.isOa,
    `${JSON.stringify(h.papers[0]?.openAccess)} vs ${JSON.stringify(summary.isOa)}`);
}

// ── 4. L7: a reported `is_oa` is still true/false ─────────────────────────
{
  serve({
    results: [
      { id: 'https://openalex.org/W2', title: 'Reported Open', open_access: { is_oa: true } },
      { id: 'https://openalex.org/W3', title: 'Reported Closed', open_access: { is_oa: false } },
    ],
  });
  const h = await searchSource('openalex', 'x', { rows: 2 });
  const byTitle = (t) => h.papers.find((p) => p.title === t);
  check('is_oa true is true', byTitle('Reported Open')?.openAccess === true, JSON.stringify(byTitle('Reported Open')?.openAccess));
  check('is_oa false is false', byTitle('Reported Closed')?.openAccess === false, JSON.stringify(byTitle('Reported Closed')?.openAccess));
}

// ── 5. L7: a source with no OA field at all is UNKNOWN, not "closed" ──────
{
  serve({ message: { items: [{ title: ['A Crossref Record'], DOI: '10.1234/cr1' }] } });
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a Crossref record is UNKNOWN, not false', h.papers[0]?.openAccess === null,
    JSON.stringify(h.papers[0]?.openAccess));
}

// ── 6. No regression: `open_access_only` still keeps exactly the open ones ─
{
  serve({
    hits: {
      hits: [
        { metadata: { title: 'Open One', access_right: 'open' }, links: { self_html: 'https://zenodo.org/records/1' } },
        { metadata: { title: 'Closed One', access_right: 'closed' }, links: { self_html: 'https://zenodo.org/records/2' } },
        { metadata: { title: 'Unknown One', access_right: 'public' }, links: { self_html: 'https://zenodo.org/records/3' } },
      ],
    },
  });
  const h = await searchSource('zenodo', 'x', { rows: 3 });
  const kept = h.papers.filter((p) => p.openAccess);
  check('only the open record survives the filter', kept.length === 1, String(kept.length));
  check('and it is the right one', kept[0]?.title === 'Open One', kept[0]?.title ?? '(none)');
}

globalThis.fetch = realFetch;
console.log('\nD96 open access unknown: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
