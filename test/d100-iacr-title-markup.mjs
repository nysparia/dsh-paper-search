// test/d100-iacr-title-markup.mjs — a markup change INSIDE the IACR result
// container must not be reported as a valid empty answer.
//
// THE DEFECT. The zero-result guard in `iacr()` was keyed on
// `links.length === 0`, so it only ran when NO `paperlink` anchor was found.
// When the anchors ARE found but the title element inside them changed
// (`<strong>` -> `<h5>`), every record was pushed with `title: null`, the
// `filter((p) => p.title)` emptied the list, and the connector returned `[]`
// with `error: null` — indistinguishable from "IACR has no paper matching this
// query". Measured 25 Nov 2026 with two well-formed results whose `<strong>`
// became `<h5>`:
//
//   papers=0 error=null
//
// The file header states the rule this breaks ("a failure must not disguise
// itself as emptiness"), and the comment above `hasAnchorWith` promises the
// opposite of what the code did: "container present, pattern matched nothing ->
// the markup INSIDE the container changed -> error". `garuda`/`sinta`/`ios`
// never had this bug because their guard tests the PARSED RESULT; this one now
// does the same.
//
// WHAT MUST STILL WORK. A genuinely empty search is still `[]` with no error
// (`test/d22`), a normal page still parses, and a PARTIAL drop — one result
// whose title element is gone among results that parse — is still not a
// failure, because the answer is not empty.

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

/** One IACR result block, with the title element's tag configurable. */
function result(id, title, tag = 'strong') {
  return `
    <div class="d-flex flex-column flex-md-row justify-content-between mb-4">
      <div class="ms-md-4">
        <a title="${id}" class="paperlink" href="/${id}">
          <${tag}>${title}</${tag}>
        </a>
        <span class="fst-italic">Alice Example, Bob Example</span>
        <p class="mb-0 mt-1 search-abstract">An abstract.</p>
      </div>
    </div>`;
}

const page = (inner) => `<html><body><div class="container">${inner}</div></body></html>`;

// ── 1. The defect: anchors present, title element changed -> ERROR ──────────
{
  serve(page(result('2024/1234', 'A Real Paper', 'h5') + result('2023/999', 'Another Paper', 'h5')));
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('a changed title element is NOT a valid empty answer', h.error !== null, h.error ?? 'null');
  check('and it names the markup change', /markup changed/i.test(h.error ?? ''), h.error ?? '');
  check('and it returns no papers', h.papers.length === 0, String(h.papers.length));
}

// ── 2. The same page with `<b>` instead of `<strong>` is the same failure ───
{
  serve(page(result('2024/1234', 'A Real Paper', 'b')));
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('a <b> title is also reported as a markup change', h.error !== null, h.error ?? 'null');
}

// ── 3. No regression: a normal page still parses ───────────────────────────
{
  serve(page(result('2024/1234', 'A Real Paper') + result('2023/999', 'Another Paper')));
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('a normal page reports no error', h.error === null, h.error ?? 'null');
  check('a normal page returns both results', h.papers.length === 2, String(h.papers.length));
  check('the first title is parsed', h.papers[0]?.title === 'A Real Paper', h.papers[0]?.title ?? '(none)');
}

// ── 4. No regression: a genuinely empty search is still an empty answer ────
{
  serve(page('<h4 class="mt-5">No results</h4>'));
  const h = await searchSource('iacr', 'digital literacy', { rows: 5 });
  check('a zero-result page still reports no error', h.error === null, h.error ?? 'null');
  check('a zero-result page still returns zero papers', h.papers.length === 0, String(h.papers.length));
}

// ── 5. A PARTIAL drop is not a failure: the answer is not empty ────────────
{
  serve(page(result('2024/1234', 'A Real Paper') + result('2023/999', 'Another Paper').replace(/<strong>Another Paper<\/strong>/, '')));
  const h = await searchSource('iacr', 'literature', { rows: 5 });
  check('one unparseable result among parseable ones is not an error', h.error === null, h.error ?? 'null');
  check('and the parseable result is returned', h.papers.length === 1, String(h.papers.length));
}

globalThis.fetch = realFetch;
console.log('\nD91 IACR title markup: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
