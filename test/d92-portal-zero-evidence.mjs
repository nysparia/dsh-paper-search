// test/d92-portal-zero-evidence.mjs — a zero-result marker found ANYWHERE on the
// page certified "the portal answered zero".
//
// THE DEFECT. `portalHasNoResults` was
//
//   markers.some((re) => re.test(html))
//
// which answers "does this string occur anywhere in the document", not "did the
// portal report zero results for this query". The markers are ordinary page
// text, so a page that is not a result page at all passed. Measured 24 Nov 2026
// on 0.8.0 — four pages came back as `0-RESULTS (error: null)` and the reply
// then printed `OK Garuda html 0 results`:
//
//   garuda  a maintenance page carrying the site's own template in a <script>
//   garuda  an about page whose copy contains "Found 0 documents"
//   sinta   an author-profile page containing "Results for: Scopus"
//   ios     an application/json error envelope containing "No Results!"
//
// The reply's own contract says a zero from one source must not be read as
// "there is no literature", so a page that never answered must not be reported
// as a source that answered with zero. A marker now has to be page TEXT — it
// must START a text node — and Sinta's header has to echo the query that was
// actually sent.
//
// WHAT MUST STILL WORK. A genuine zero-result page is still a VALID empty
// answer: that is the whole reason the marker exists, and test/d30 pins it.

import { searchSource } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();
const realFetch = globalThis.fetch;

/** Serve one canned body for every request. */
function serve(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.invalid/',
    headers: { get: () => null },
    text: async () => body,
  });
}

// ── A marker that is not page text is not evidence ────────────────────────
{
  // The site's own "no results" template, shipped inside a maintenance page.
  serve(`<html><body>
    <h1>Portal sedang dalam pemeliharaan</h1>
    <script>var NO_RESULT_TPL = "<p>Found 0 documents</p>";</script>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: a maintenance page carrying the zero template is an ERROR',
    h.error !== null, h.error ?? 'null (reported as a valid empty answer)');
}

{
  // The marker buried in the middle of a sentence is prose, not a counter.
  serve(`<html><body>
    <h1>Garuda</h1><p>Tentang portal. Found 0 documents</p>
    <p>Halaman ini bukan halaman hasil pencarian.</p>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: an about page whose prose contains the marker is an ERROR',
    h.error !== null, h.error ?? 'null (reported as a valid empty answer)');
}

{
  // "Results for:" is a table header on an author profile, not a result page.
  serve(`<html><body>
    <h2>Author profile</h2>
    <table><tr><th>Results for: Scopus</th><td>12</td></tr></table>
    <p>This page lists an author's indexed journals.</p>
  </body></html>`);
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: an author-profile page containing "Results for:" is an ERROR',
    h.error !== null, h.error ?? 'null (reported as a valid empty answer)');
}

{
  // The header exists but answers a DIFFERENT query — not evidence for this one.
  serve('<html><body><h1>Results for "zzzz"</h1><div class="list"></div></body></html>');
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: a header echoing a DIFFERENT query is an ERROR',
    h.error !== null, h.error ?? 'null (reported as a valid empty answer)');
}

{
  // A JSON error envelope is not HTML, and its string value is not page text.
  serve('{"error":"No Results!","status":500}');
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: a JSON error envelope containing the marker is an ERROR',
    h.error !== null, h.error ?? 'null (reported as a valid empty answer)');
}

// ── A genuine zero-result page is still a valid empty answer ──────────────
{
  serve('<html><body><div class="container"><p>Found 0 documents</p></div></body></html>');
  const h = await searchSource('garuda', 'zzzz', { rows: 5 });
  check('garuda: a genuine zero-result page is still a VALID empty answer',
    h.error === null, h.error ?? 'null');
  check('garuda: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  // The real page shape, measured 24 Nov 2026: the counter sits in the search
  // header, followed by the query echo.
  serve(`<html><body><div class="twelve wide column"><div class="column">
    <h2 class="ui header"><i class="search icon"></i><div class="content">
      Found 0 documents
      <div class="sub header">Search <i><xmp>zzzzqqqxxx</xmp></i></div>
    </div></h2></div></div></body></html>`);
  const h = await searchSource('garuda', 'zzzzqqqxxx', { rows: 5 });
  check('garuda: the live zero-result shape is a VALID empty answer',
    h.error === null, h.error ?? 'null');
  check('garuda: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  // The real Sinta shape, measured 24 Nov 2026: the query is echoed inside <em>.
  serve('<html><body><div class="content-list-no-filter"><div class="alert alert-info">Results for <em>"zzzzqqqxxx"</em></div></div></body></html>');
  const h = await searchSource('sinta', 'zzzzqqqxxx', { rows: 5 });
  check('sinta: the live zero-result shape is a VALID empty answer',
    h.error === null, h.error ?? 'null');
  check('sinta: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

{
  serve('<html><body><div class="results"><p>No Results!</p></div></body></html>');
  const h = await searchSource('ios', 'zzzz', { rows: 5 });
  check('ios: a genuine zero-result page is still a VALID empty answer',
    h.error === null, h.error ?? 'null');
  check('ios: and it returns zero papers', h.papers.length === 0, String(h.papers.length));
}

// ── A page that contradicts itself is an error, not a guess ───────────────
{
  // The counter says zero and a result block matched: one of the two is wrong.
  serve(`<html><body>
    <p>Found 0 documents</p>
    <div class="article-item"><a class="title-article" href="/documents/detail/1"><xmp>A Title</xmp></a></div>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: "Found 0 documents" plus a parsed result block is an ERROR',
    h.error !== null, h.error ?? 'null');
  check('garuda: and no paper is returned from the contradiction',
    h.papers.length === 0, String(h.papers.length));
}

globalThis.fetch = realFetch;
done('d92 portal zero evidence');
