// test/d22-iacr-zero-results.mjs — IACR's zero-result page must not read as a
// markup change.
//
// THE DEFECT. `iacr()` treats "no `paperlink` anchor found" as proof that the
// operator changed the markup, and throws. But IACR writes a real zero-result
// page — `<h4 class="mt-5">No results</h4>` — which of course has no result
// anchors. Measured 24 Nov 2026 against the live site:
//
//   GET /search?q=literature        -> 100 paperlink anchors, 162,299 bytes
//   GET /search?q=digital%20literacy -> 0 paperlink anchors,  17,108 bytes,
//                                       body contains "No results"
//
// So a perfectly valid empty answer was reported as a broken connector, and the
// reply then told the reader a source had FAILED. That is the same defect the
// three Indonesian portals were fixed for (`portalHasNoResults`), and IACR was
// missed because it is an `api`-shaped connector that happens to scrape HTML.
//
// The fix must NOT weaken the real guard: a page that has neither result anchors
// nor a zero-result marker is still a markup change and must still throw.

import { check } from './harness.mjs';
import { searchSource } from '../lib/sources.js';

const realFetch = globalThis.fetch;

/** Serve one canned HTML body for every request. */
function serve(html) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => html,
  });
}

/** A page shaped like a real IACR result page, with `n` results. */
function resultPage(n) {
  const rows = Array.from({ length: n }, (_, i) => `
    <div class="d-flex flex-column flex-md-row justify-content-between mb-4">
      <div class="ms-md-4">
        <a title="2026/${2984 - i}" class="paperlink" href="/2026/${2984 - i}">
          <strong>Paper number ${i}</strong>
        </a>
        <span class="fst-italic">Alice Example, Bob Example</span>
        <p class="mb-0 mt-1 search-abstract">An abstract for paper ${i}.</p>
      </div>
    </div>`).join('');
  return `<html><body><div class="container">${rows}</div></body></html>`;
}

/** The real zero-result page, reduced to the part that matters. */
const ZERO_PAGE = '<html><body><div class="container"><h4 class="mt-5">No results</h4></div></body></html>';

/** A page whose markup really did change: no anchors, no zero-result marker. */
const CHANGED_PAGE = '<html><body><div class="container"><p>Search the archive</p></div></body></html>';

// ── 1. The defect: a zero-result page is an EMPTY ANSWER, not a failure ──────
{
  serve(ZERO_PAGE);
  const h = await searchSource('iacr', 'digital literacy', { rows: 5 });
  check('a zero-result page reports NO error', h.error === null, h.error ?? 'null');
  check('a zero-result page returns zero papers', h.papers.length === 0, String(h.papers.length));
}

// ── 2. The guard must still hold: a real markup change still throws ──────────
{
  serve(CHANGED_PAGE);
  const h = await searchSource('iacr', 'anything', { rows: 5 });
  check('a page with neither anchors nor a zero marker IS an error', h.error !== null, h.error ?? 'null');
  check('that error names the markup change', /markup changed/i.test(h.error ?? ''), h.error ?? '');
}

// ── 3. No regression: a normal result page still parses ─────────────────────
{
  serve(resultPage(3));
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('a normal page reports no error', h.error === null, h.error ?? 'null');
  check('a normal page returns the results', h.papers.length === 3, String(h.papers.length));
  check('the first title is parsed', h.papers[0]?.title === 'Paper number 0', h.papers[0]?.title ?? '(none)');
  check('the first url is built from the id', h.papers[0]?.url === 'https://eprint.iacr.org/2026/2984', h.papers[0]?.url ?? '(none)');
  check('the year comes from the id', h.papers[0]?.year === 2026, String(h.papers[0]?.year));
  check('the authors are split on commas', (h.papers[0]?.authors ?? []).length === 2, JSON.stringify(h.papers[0]?.authors));
}

// ── 4. `rows` still caps the list ───────────────────────────────────────────
{
  serve(resultPage(10));
  const h = await searchSource('iacr', 'literature', { rows: 2 });
  check('rows caps the returned list', h.papers.length === 2, String(h.papers.length));
}

globalThis.fetch = realFetch;
console.log('\nD22 IACR zero-result page: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
