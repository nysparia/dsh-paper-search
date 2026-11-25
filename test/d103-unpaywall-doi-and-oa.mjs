// test/d103-unpaywall-doi-and-oa.mjs — `unpaywall` accepted a keyword query as
// a DOI, and ignored every free copy that was not the "best" one.
//
// ── M2: `normalizeDoi` IS A NORMALIZER, NOT A VALIDATOR ────────────────────
//
// The guard was `const doi = normalizeDoi(query); if (!doi) return [];`, and
// `normalizeDoi` returns anything longer than 3 characters. So
// `searchSource('unpaywall', 'digital literacy')` requested
// `api.unpaywall.org/v2/digital%20literacy`, and a 200 reply produced a record
// whose `doi` was the literal string `digital literacy` and whose `url` was
// `https://doi.org/digital literacy` — a broken link presented as a DOI.
// Measured 25 Nov 2026: the live API answers that request with **HTTP 404**, so
// the user saw a source FAILURE for a query that is simply not this source's
// input. The tool path already skips a DOI-input source for a keyword query
// (`lib/index.js`), so this was a defect in the exported `searchSource`
// contract, not a live one.
//
// ── L4: `oa_locations` WAS NEVER READ ──────────────────────────────────────
//
// Only `best_oa_location` was consulted. Measured 25 Nov 2026 with
// `is_oa: true`, `best_oa_location: null` and one entry in `oa_locations`: the
// record said "open access" and then named the publisher DOI as its URL,
// dropping the free copy it had just been told about.
//
// WHAT MUST STILL WORK. A real DOI still produces exactly one record, the
// "best" copy is still preferred when it exists, and a work with no free copy
// still falls back to its DOI link.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;
const EMAIL = 'me@example.org';

/** Serve one canned JSON body and record every request URL. */
function serve(body) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

// ── 1. M2: a keyword query is not a DOI -> EMPTY, and NO request ───────────
{
  const calls = serve({ title: 'x', doi: 'digital literacy', is_oa: false });
  const h = await searchSource('unpaywall', 'digital literacy', { rows: 5, email: EMAIL });
  check('a keyword query sends NO request', calls.length === 0, JSON.stringify(calls));
  check('a keyword query reports no error', h.error === null, h.error ?? 'null');
  check('a keyword query returns no papers', h.papers.length === 0, String(h.papers.length));
}

// ── 2. M2: a short non-DOI is still refused (no regression) ────────────────
{
  const calls = serve({ title: 'x' });
  const h = await searchSource('unpaywall', 'abc', { rows: 5, email: EMAIL });
  check('a 3-character query sends no request', calls.length === 0, JSON.stringify(calls));
  check('and returns no papers', h.papers.length === 0, String(h.papers.length));
}

// ── 3. A real DOI still works, and the request names it ────────────────────
{
  const calls = serve({ title: 'A Paper', doi: '10.1234/oa1', is_oa: false, year: 2020 });
  const h = await searchSource('unpaywall', '10.1234/oa1', { rows: 5, email: EMAIL });
  check('a DOI query sends exactly one request', calls.length === 1, JSON.stringify(calls));
  check('the request carries the DOI', /\/v2\/10\.1234%2Foa1\?/.test(calls[0] ?? ''), calls[0] ?? '(none)');
  check('and returns the record', h.papers.length === 1, String(h.papers.length));
  check('with the DOI as its doi', h.papers[0]?.doi === '10.1234/oa1', h.papers[0]?.doi ?? '(none)');
}

// ── 4. L4: the free copy in `oa_locations` is used when "best" is null ─────
{
  serve({
    title: 'A Paper',
    doi: '10.1234/oa2',
    is_oa: true,
    best_oa_location: null,
    oa_locations: [{ url_for_pdf: 'https://repo.example.org/oa2.pdf', url: 'https://repo.example.org/oa2' }],
  });
  const h = await searchSource('unpaywall', '10.1234/oa2', { rows: 5, email: EMAIL });
  check('the record is open access', h.papers[0]?.openAccess === true, JSON.stringify(h.papers[0]?.openAccess));
  check('the free copy is named, not the publisher DOI',
    h.papers[0]?.url === 'https://repo.example.org/oa2.pdf', h.papers[0]?.url ?? '(none)');
}

// ── 5. L4: a location with only `url` (no `url_for_pdf`) is still used ─────
{
  serve({
    title: 'A Paper',
    doi: '10.1234/oa3',
    is_oa: true,
    oa_locations: [{ url: 'https://repo.example.org/oa3' }],
  });
  const h = await searchSource('unpaywall', '10.1234/oa3', { rows: 5, email: EMAIL });
  check('a landing-page-only location is used', h.papers[0]?.url === 'https://repo.example.org/oa3',
    h.papers[0]?.url ?? '(none)');
}

// ── 6. No regression: "best" is still preferred over the list ─────────────
{
  serve({
    title: 'A Paper',
    doi: '10.1234/oa4',
    is_oa: true,
    best_oa_location: { url_for_pdf: 'https://best.example.org/oa4.pdf' },
    oa_locations: [{ url_for_pdf: 'https://other.example.org/oa4.pdf' }],
  });
  const h = await searchSource('unpaywall', '10.1234/oa4', { rows: 5, email: EMAIL });
  check('best_oa_location still wins', h.papers[0]?.url === 'https://best.example.org/oa4.pdf',
    h.papers[0]?.url ?? '(none)');
}

// ── 7. No regression: no free copy at all -> the DOI link ─────────────────
{
  serve({ title: 'A Paper', doi: '10.1234/oa5', is_oa: false });
  const h = await searchSource('unpaywall', '10.1234/oa5', { rows: 5, email: EMAIL });
  check('a closed work falls back to its DOI link', h.papers[0]?.url === 'https://doi.org/10.1234/oa5',
    h.papers[0]?.url ?? '(none)');
  check('and is not claimed open access', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

globalThis.fetch = realFetch;
console.log('\nD94 Unpaywall DOI and OA locations: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
