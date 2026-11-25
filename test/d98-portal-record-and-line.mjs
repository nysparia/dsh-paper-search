// test/d98-portal-record-and-line.mjs — what the portal record and the per-source
// line claim, when the portal reported neither.
//
// THE DEFECTS, measured 24 Nov 2026 on 0.8.0.
//
// 1. `collectHtml` applied `limit` BEFORE the title filter, so unusable matches
//    ate the budget. With `rows: 2` and three Garuda anchors whose first two
//    `<xmp>` were empty, a page holding a valid result was reported as FAILED:
//
//      -> ERROR  Garuda markup changed: result links are still present, but the
//                title is no longer inside <xmp>
//
//    The model was told the parser broke when it had not.
//
// 2. `journal` was filled with the SOURCE LABEL — `'Garuda (Indonesian
//    journal)'`, `'Sinta (accredited journals)'`, `'IOS OneSearch (Indonesian
//    repository)'` — so the reply printed a journal name that does not exist, in
//    the slot where it already knows how to say "journal not reported":
//
//      ? · Garuda (Indonesian journal) · (authors not reported)
//
//    `openAccess: true` was asserted for all three. Garuda and Sinta index
//    open-access material only, but neither page STATES it per record (measured
//    24 Nov 2026: no "open access" / "akses terbuka" string on either page), and
//    IOS is an aggregator that also indexes catalogue records.
//
// 3. Calling a portal connector without `opts` threw a destructuring TypeError
//    into the reply: "Cannot destructure property 'rows' of 'undefined'".
//
// 4. `rows` is silently capped by the portal's page size, and the reply presented
//    the page count as the source's count. Measured with a page holding 10
//    results and `max_results: 50`:
//
//      OK     Garuda             html     10 results  (1 ms)
//
//    The model reads that as "Garuda has 10 hits". The paging parameter is not
//    verified for any of the three, so the number is not chased — it is LABELLED.

import { searchSource } from '../lib/sources.js';
import { loadTools, installFetch, outcome, reporter } from './harness.mjs';

const { check, done } = reporter();
const realFetch = globalThis.fetch;

/** Serve one canned HTML body for every request. */
function serve(html) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.invalid/',
    headers: { get: () => null },
    text: async () => html,
  });
}

// ── F5: the cap is on PAPERS, not on matches ──────────────────────────────
{
  serve(`<html><body>
    <a class="title-article" href="/documents/detail/1"><xmp>   </xmp></a>
    <a class="title-article" href="/documents/detail/2"><xmp></xmp></a>
    <a class="title-article" href="/documents/detail/3"><xmp>The Only Real Result</xmp></a>
  </body></html>`);
  const h = await searchSource('garuda', 'pendidikan', { rows: 2 });
  check('garuda: two empty titles do not consume the budget of a valid result',
    h.error === null, h.error ?? 'null');
  check('garuda: the valid result is returned',
    h.papers[0]?.title === 'The Only Real Result', h.papers[0]?.title ?? '(none)');
}

// ── F9: the portal does not report a journal name or an access status ─────
{
  serve('<html><body><a class="title-article" href="/documents/detail/1"><xmp>A Real Title</xmp></a></body></html>');
  const h = await searchSource('garuda', 'pendidikan', { rows: 5 });
  check('garuda: journal is NOT the source label', h.papers[0]?.journal === null,
    JSON.stringify(h.papers[0]?.journal));
  check('garuda: open access is not asserted', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

{
  serve('<html><body><a href="https://sinta.kemdiktisaintek.go.id/journals/profile/1">Jurnal Pendidikan</a></body></html>');
  const h = await searchSource('sinta', 'pendidikan', { rows: 5 });
  check('sinta: journal is NOT the source label', h.papers[0]?.journal === null,
    JSON.stringify(h.papers[0]?.journal));
  check('sinta: open access is not asserted', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

{
  serve('<html><body><a href="/Record/1" class="title">A Real Title</a></body></html>');
  const h = await searchSource('ios', 'pendidikan', { rows: 5 });
  check('ios: journal is NOT the source label', h.papers[0]?.journal === null,
    JSON.stringify(h.papers[0]?.journal));
  check('ios: open access is not asserted', h.papers[0]?.openAccess === false,
    JSON.stringify(h.papers[0]?.openAccess));
}

// ── F14: a connector called without opts must not fail on the destructuring ─
//
// `searchSource` never throws — it turns a connector's throw into `error` — so
// the defect surfaces as a per-source FAILED line whose text is the JavaScript
// TypeError, not as an exception here.
{
  serve('<html><body><a class="title-article" href="/documents/detail/1"><xmp>A Real Title</xmp></a></body></html>');
  const r = await outcome(() => searchSource('garuda', 'pendidikan'));
  check('garuda: a call with no opts does not fail with a destructuring TypeError',
    !/Cannot destructure/.test(r.value?.error ?? ''), r.value?.error ?? 'null');
  check('garuda: and it still returns the result', r.value?.papers?.length === 1,
    String(r.value?.papers?.length ?? 'threw'));
}

{
  serve('<html><body><a href="https://sinta.kemdiktisaintek.go.id/journals/profile/1">Jurnal Pendidikan</a></body></html>');
  const r = await outcome(() => searchSource('sinta', 'pendidikan'));
  check('sinta: a call with no opts does not fail with a destructuring TypeError',
    !/Cannot destructure/.test(r.value?.error ?? ''), r.value?.error ?? 'null');
  check('sinta: and it still returns the result', r.value?.papers?.length === 1,
    String(r.value?.papers?.length ?? 'threw'));
}

{
  serve('<html><body><a href="/Record/1" class="title">A Real Title</a></body></html>');
  const r = await outcome(() => searchSource('ios', 'pendidikan'));
  check('ios: a call with no opts does not fail with a destructuring TypeError',
    !/Cannot destructure/.test(r.value?.error ?? ''), r.value?.error ?? 'null');
  check('ios: and it still returns the result', r.value?.papers?.length === 1,
    String(r.value?.papers?.length ?? 'threw'));
}

// ── F4: the per-source line says the number is a page size ────────────────
{
  const tools = loadTools();
  const rows = Array.from({ length: 10 }, (_, i) =>
    `<div class="article-item"><a class="title-article" href="/documents/detail/${i + 1}"><xmp>Real Garuda Article Number ${i + 1}</xmp></a></div>`).join('\n');
  const h = installFetch(() => ({
    body: `<html><body><h2 class="ui header"><i class="search icon"></i><div class="content">Found 196,627 documents</div></h2>${rows}</body></html>`,
    headers: { 'content-type': 'text/html' },
  }));
  const reply = await tools.get('paper_search').execute({ query: 'pendidikan', sources: 'garuda', max_results: 50 });
  h.restore();
  const line = reply.split('\n').find((l) => /^\s+OK\s+Garuda/.test(l)) ?? '';
  check('the per-source line reports the 10 results the page held', /\b10 results\b/.test(line), line);
  check('the per-source line says the count is a first page, not the corpus',
    /first page only/.test(line), line);
  check('the per-source line does not claim the portal has only 10 hits',
    !/10 results\s+\([^)]*\)\s*$/.test(line), line);
}

globalThis.fetch = realFetch;
done('d94 portal record and line');
