// test/d30-portal-guards.mjs — the HTML-portal guards test a substring that is
// WEAKER than the result pattern, so a markup change is reported as a valid
// empty answer.
//
// THE DEFECT. Each portal's "did the markup change?" guard searched the page for
// a bare substring — `title-article`, `journals/profile/`, `class="title"`,
// `class="paperlink"`. That substring is weaker than the result pattern it is
// supposed to protect, so a page that still contains the marker word but no
// longer matches the pattern returned `[]` with `error: null` — the exact
// failure the file header forbids ("a failure must not disguise itself as
// emptiness").
//
// Measured on all four:
//
//   garuda  class="title-article" kept, inner <xmp> became <span>  -> [] , null
//   sinta   "journals/profile/" kept, links became RELATIVE        -> [] , null
//   ios     class="title" kept, attributes reordered               -> [] , null
//   iacr    class="paperlink" kept, attributes reordered           -> [] , null
//
// WHAT MUST STILL WORK. A genuinely empty page (the portal's own zero-result
// marker) must still be a valid empty answer, and a normal result page must
// still parse. The fix must not turn every empty answer into an error.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

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

// ── GARUDA ────────────────────────────────────────────────────────────────
{
  // The class survives; the inner <xmp> became <span>, so the pattern cannot
  // match. The old guard tested `/title-article/` and passed.
  serve(`<html><body>
    <div class="result"><a class="title-article" href="/documents/detail/123"><span>Some Real Title</span></a></div>
    <div class="result"><a class="title-article" href="/documents/detail/124"><span>Another Real Title</span></a></div>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a changed <xmp> is an ERROR, not an empty answer', h.error !== null, h.error ?? 'null');
  check('garuda: the error names the markup change', /markup changed/i.test(h.error ?? ''), h.error ?? '');
}

{
  // The real zero-result page: no result anchors, but the marker is there.
  serve('<html><body><div class="container"><p>Found 0 documents</p></div></body></html>');
  const h = await searchSource('garuda', 'zzzz', { rows: 5 });
  check('garuda: a zero-result page is a VALID empty answer', h.error === null, h.error ?? 'null');
  check('garuda: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  serve(`<html><body>
    <a class="title-article" href="/documents/detail/123"><xmp>A Real Garuda Title</xmp></a>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a normal page still parses', h.papers.length === 1, String(h.papers.length));
  check('garuda: the title is parsed', h.papers[0]?.title === 'A Real Garuda Title', h.papers[0]?.title ?? '(none)');
}

// ── SINTA ─────────────────────────────────────────────────────────────────
{
  // Relative profile links: "journals/profile/" is still on the page, so the old
  // guard passed, but the pattern needs the ABSOLUTE href.
  serve(`<html><body><div class="list">
    <a href="/journals/profile/60001">Jurnal Pendidikan Karakter</a>
    <a href="/journals/profile/60002">Jurnal Ilmu Pendidikan</a>
  </div></body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: relative profile links are an ERROR', h.error !== null, h.error ?? 'null');
  check('sinta: the error names the markup change', /markup changed/i.test(h.error ?? ''), h.error ?? '');
}

{
  // Sinta writes no empty message — the `Results for` header is the proof.
  serve('<html><body><h1>Results for "zzzz"</h1><div class="list"></div></body></html>');
  const h = await searchSource('sinta', 'zzzz', { rows: 5 });
  check('sinta: a zero-result page is a VALID empty answer', h.error === null, h.error ?? 'null');
  check('sinta: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  serve(`<html><body>
    <a href="https://sinta.kemdiktisaintek.go.id/journals/profile/60001">Jurnal Pendidikan Karakter</a>
  </body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: a normal page still parses', h.papers.length === 1, String(h.papers.length));
  check('sinta: the url is built from the id',
    h.papers[0]?.url === 'https://sinta.kemdiktisaintek.go.id/journals/profile/60001',
    h.papers[0]?.url ?? '(none)');
}

// ── IOS ───────────────────────────────────────────────────────────────────
{
  // Attributes reordered: class before href. `class="title"` is still present.
  serve(`<html><body><div class="results">
    <a class="title" href="/Record/12345">Kumpulan Makalah Pendidikan</a>
    <a class="title" href="/Record/12346">Prosiding Seminar Nasional</a>
  </div></body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: reordered attributes are an ERROR', h.error !== null, h.error ?? 'null');
  check('ios: the error names the markup change', /markup changed/i.test(h.error ?? ''), h.error ?? '');
}

{
  serve('<html><body><div class="results"><p>No Results!</p></div></body></html>');
  const h = await searchSource('ios', 'zzzz', { rows: 5 });
  check('ios: a zero-result page is a VALID empty answer', h.error === null, h.error ?? 'null');
  check('ios: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  serve(`<html><body>
    <a href="/Record/12345" class="title">Kumpulan Makalah Pendidikan</a>
  </body></html>`);
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a normal page still parses', h.papers.length === 1, String(h.papers.length));
  check('ios: the url is built from the id', h.papers[0]?.url === 'https://onesearch.id/Record/12345',
    h.papers[0]?.url ?? '(none)');
}

// ── IACR ──────────────────────────────────────────────────────────────────
{
  // Attributes reordered: class before title. `class="paperlink"` is still there.
  serve(`<html><body><div class="container">
    <a class="paperlink" title="2026/2984" href="/2026/2984"><strong>A Real Paper</strong></a>
  </div></body></html>`);
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('iacr: reordered attributes are an ERROR', h.error !== null, h.error ?? 'null');
  check('iacr: the error names the markup change', /markup changed/i.test(h.error ?? ''), h.error ?? '');
}

{
  serve('<html><body><div class="container"><h4 class="mt-5">No results</h4></div></body></html>');
  const h = await searchSource('iacr', 'digital literacy', { rows: 5 });
  check('iacr: a zero-result page is a VALID empty answer', h.error === null, h.error ?? 'null');
  check('iacr: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  serve(`<html><body><div class="container">
    <a title="2026/2984" class="paperlink" href="/2026/2984"><strong>A Real Paper</strong></a>
  </div></body></html>`);
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('iacr: a normal page still parses', h.papers.length === 1, String(h.papers.length));
  check('iacr: the title is parsed', h.papers[0]?.title === 'A Real Paper', h.papers[0]?.title ?? '(none)');
}

// ── A page with NO container at all is still an error ─────────────────────
// The guard must not become "anything without results is empty".
{
  serve('<html><body><div class="container"><p>Search the archive</p></div></body></html>');
  const h = await searchSource('iacr', 'anything', { rows: 5 });
  check('iacr: a page with neither anchors nor a zero marker IS an error', h.error !== null, h.error ?? 'null');
}

globalThis.fetch = realFetch;
console.log('\nD30 portal guards: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
