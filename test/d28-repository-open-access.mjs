// test/d28-repository-open-access.mjs — `zenodo` and `hal` claim open access
// for records the platform marks restricted, embargoed or closed.
//
// THE DEFECT. Both connectors hardcoded `openAccess: true` for every record.
// Both platforms report the real status and the connectors ignored it.
//
// Measured live 24 Nov 2026, Zenodo:
//
//   WRONG  access_right=restricted  connector.openAccess=true
//   WRONG  access_right=embargoed   connector.openAccess=true
//   … 7 of 10 records claimed open access while Zenodo said otherwise
//
// Measured live, HAL:
//
//   WRONG  HAL openAccess_bool=false  connector.openAccess=true
//   … 8 of 10 HAL records claimed open access while HAL said false
//
// The consequence is user-visible: `open_access_only` is supposed to drop
// non-OA works, and it did not — a reader filtering for open access was handed
// restricted and embargoed records labelled "open access".
//
// WHAT MUST STILL WORK. A record the platform DOES mark open must still be
// reported as open, and a record that does not report the field at all must not
// be claimed as open (that is the same rule as `summarizeOA`).
//
// ── THE TWO "DOES NOT SAY" ASSERTIONS NOW EXPECT `null`, NOT `false` ────────
//
// They were written as `=== false` because `makePaper` coerced a missing flag
// with `!!`, so "not reported" and "reported closed" were the same value. That
// coercion was itself the defect (fixed 25 Nov 2026, `test/d96`): the same
// OpenAlex work came back `openAccess: false` on the search path and
// `{isOa: null, reported: false}` through `paper_oa`. `null` is what this test's
// own header asks for — "the same rule as `summarizeOA`" — and it is STRICTER,
// not weaker: `false` still has to be produced by the four documented values
// above, and `null` can no longer be produced by them.

import { searchSource } from '../lib/sources.js';
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

// ── 1. Zenodo: the four documented access_right values ────────────────────
{
  serve({
    hits: {
      hits: [
        { metadata: { title: 'An open record', access_right: 'open', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/1' } },
        { metadata: { title: 'A restricted record', access_right: 'restricted', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/2' } },
        { metadata: { title: 'An embargoed record', access_right: 'embargoed', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/3' } },
        { metadata: { title: 'A closed record', access_right: 'closed', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/4' } },
        { metadata: { title: 'A record that does not say', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/5' } },
      ],
    },
  });
  const h = await searchSource('zenodo', 'x', { rows: 5 });
  check('zenodo reports no error', h.error === null, h.error ?? 'null');
  check('zenodo returns all five records', h.papers.length === 5, String(h.papers.length));

  const byTitle = (t) => h.papers.find((p) => p.title === t);
  check('access_right "open" is open access', byTitle('An open record')?.openAccess === true,
    JSON.stringify(byTitle('An open record')?.openAccess));
  check('access_right "restricted" is NOT open access', byTitle('A restricted record')?.openAccess === false,
    JSON.stringify(byTitle('A restricted record')?.openAccess));
  check('access_right "embargoed" is NOT open access', byTitle('An embargoed record')?.openAccess === false,
    JSON.stringify(byTitle('An embargoed record')?.openAccess));
  check('access_right "closed" is NOT open access', byTitle('A closed record')?.openAccess === false,
    JSON.stringify(byTitle('A closed record')?.openAccess));
  check('a record that does not report the field is NOT claimed open',
    byTitle('A record that does not say')?.openAccess === null,
    JSON.stringify(byTitle('A record that does not say')?.openAccess));
}

// ── 2. HAL: `openAccess_bool` is requested and mapped ─────────────────────
{
  let requested = null;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        response: {
          docs: [
            { title_s: ['An open HAL record'], openAccess_bool: true, producedDateY_i: 2024, uri_s: 'https://hal.science/1' },
            { title_s: ['A closed HAL record'], openAccess_bool: false, producedDateY_i: 2024, uri_s: 'https://hal.science/2' },
            { title_s: ['A HAL record that does not say'], producedDateY_i: 2024, uri_s: 'https://hal.science/3' },
          ],
        },
      }),
    };
  };
  const h = await searchSource('hal', 'x', { rows: 3 });
  check('hal reports no error', h.error === null, h.error ?? 'null');
  check('hal requests the openAccess_bool field', /openAccess_bool/.test(requested ?? ''),
    requested ?? '(no request)');

  const byTitle = (t) => h.papers.find((p) => p.title === t);
  check('openAccess_bool true is open access', byTitle('An open HAL record')?.openAccess === true,
    JSON.stringify(byTitle('An open HAL record')?.openAccess));
  check('openAccess_bool false is NOT open access', byTitle('A closed HAL record')?.openAccess === false,
    JSON.stringify(byTitle('A closed HAL record')?.openAccess));
  check('a HAL record that does not report the field is NOT claimed open',
    byTitle('A HAL record that does not say')?.openAccess === null,
    JSON.stringify(byTitle('A HAL record that does not say')?.openAccess));
}

// ── 3. The `open_access_only` filter now really drops them ────────────────
// This is the user-visible consequence the defect had: the filter is applied to
// `p.openAccess`, so a hardcoded `true` made it a no-op for these two sources.
{
  serve({
    hits: {
      hits: [
        { metadata: { title: 'Open one', access_right: 'open', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/1' } },
        { metadata: { title: 'Restricted one', access_right: 'restricted', publication_date: '2024-01-01' }, links: { self_html: 'https://zenodo.org/records/2' } },
      ],
    },
  });
  const h = await searchSource('zenodo', 'x', { rows: 2 });
  const kept = h.papers.filter((p) => p.openAccess);
  check('open_access_only keeps exactly the open record', kept.length === 1, String(kept.length));
  check('and it is the right one', kept[0]?.title === 'Open one', kept[0]?.title ?? '(none)');
}

globalThis.fetch = realFetch;
console.log('\nD28 repository open access: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
