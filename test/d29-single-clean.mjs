// test/d29-single-clean.mjs — `makePaper` cleans the title and abstract TWICE,
// deleting escaped markup that is content.
//
// THE DEFECT. `truncate()` calls `cleanText()`, and `makePaper` called
// `cleanText()` before it, so the cleaning ran twice. The second pass is not a
// no-op: the first pass has already turned `&lt;title&gt;` into a real
// `<title>`, so the second pass strips it as markup and deletes text that is
// CONTENT.
//
// Measured on a real Crossref record:
//
//   raw      "&lt;title&gt;WWW image retrieval …&lt;/title&gt;"
//   pass 1   "<title>WWW image retrieval …</title>"
//   pass 2   "WWW image retrieval …"          (right by accident — a wrapper)
//
// and on a title that IS the markup:
//
//   raw      "&lt;div&gt;"  ->  pass 1 "<div>"  ->  pass 2 ""  ->  record DROPPED
//
// The abstract was affected in the opposite direction: it was cleaned once, so
// double-encoded entities survived:
//
//   raw      "The &amp;lt;title&amp;gt; element and O&amp;#x27;Brien."
//   returned "The &lt;title&gt; element and O&#x27;Brien."
//
// The `authorList` comment states the invariant this breaks: "the decode happens
// exactly ONCE: calling `cleanText` on each part would decode a second time, so
// a double-encoded `O&amp;#x27;Brien` would collapse further here than it does
// in a title."
//
// WHAT MUST STILL WORK. Real markup in a title must still be stripped (Crossref
// wraps some abstracts in JATS tags), and a long title must still be truncated
// with an ellipsis.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Crossref reply. */
function serveItems(items) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: { items } }),
  });
}

const base = { author: [{ family: 'A' }], issued: { 'date-parts': [[2024]] }, type: 'journal-article' };

// ── 1. The defect: escaped markup that is CONTENT survives ────────────────
{
  serveItems([{ ...base, DOI: '10.1145/1', title: ['Using &lt;script&gt; tags in HTML'] }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('escaped markup in a title survives as text',
    h.papers[0]?.title === 'Using <script> tags in HTML', JSON.stringify(h.papers[0]?.title));
}

// ── 2. The record that used to DISAPPEAR ──────────────────────────────────
// A title that is entirely escaped markup was stripped to nothing by the second
// pass, and `filter((p) => p.title)` then dropped the record.
{
  serveItems([
    { ...base, DOI: '10.1145/2', title: ['The &lt;title&gt; element in HTML'] },
    { ...base, DOI: '10.1145/3', title: ['&lt;div&gt;'] },
  ]);
  const h = await searchSource('crossref', 'x', { rows: 2 });
  check('both records survive', h.papers.length === 2, String(h.papers.length));
  check('the escaped-markup title is kept as text',
    h.papers.some((p) => p.title === '<div>'), JSON.stringify(h.papers.map((p) => p.title)));
}

// ── 3. The abstract is cleaned exactly once too ───────────────────────────
// Double-encoded entities must decode ONE level, not two.
{
  serveItems([{
    ...base,
    DOI: '10.1145/4',
    title: ['A paper'],
    abstract: 'The &amp;lt;title&amp;gt; element and O&amp;#x27;Brien.',
  }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a double-encoded abstract decodes exactly one level',
    h.papers[0]?.abstract === 'The &lt;title&gt; element and O&#x27;Brien.',
    JSON.stringify(h.papers[0]?.abstract));
}

// ── 4. A single-encoded abstract decodes fully ────────────────────────────
{
  serveItems([{
    ...base,
    DOI: '10.1145/5',
    title: ['A paper'],
    abstract: 'The &lt;title&gt; element and O&#x27;Brien.',
  }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a single-encoded abstract decodes fully',
    h.papers[0]?.abstract === 'The <title> element and O\'Brien.',
    JSON.stringify(h.papers[0]?.abstract));
}

// ── 5. REAL markup is still stripped ──────────────────────────────────────
// Crossref wraps some abstracts in JATS tags. Those are markup, not content, and
// must still be removed — the fix must not stop cleaning altogether.
{
  serveItems([{
    ...base,
    DOI: '10.1145/6',
    title: ['A <i>real</i> title'],
    abstract: '<jats:p>An abstract with <jats:italic>markup</jats:italic>.</jats:p>',
  }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('real markup in a title is still stripped', h.papers[0]?.title === 'A real title',
    JSON.stringify(h.papers[0]?.title));
  // `cleanText` replaces a tag with a SPACE (not with nothing), so the closing
  // tag leaves a space before the period. That is pre-existing behaviour and is
  // not part of this defect — the assertion is that the TAGS are gone.
  check('real markup in an abstract is still stripped',
    h.papers[0]?.abstract === 'An abstract with markup .', JSON.stringify(h.papers[0]?.abstract));
}

// ── 6. Truncation still happens, with an ellipsis ─────────────────────────
{
  // A long title that is NOT a repetition — `'A'.repeat(400)` would be collapsed
  // by rule (A) as a display pad, which is correct and unrelated to this defect.
  const longTitle = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  serveItems([{ ...base, DOI: '10.1145/7', title: [longTitle] }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a long title is still truncated to 300 characters',
    h.papers[0]?.title?.length === 300, String(h.papers[0]?.title?.length));
  check('the truncated title ends with an ellipsis', h.papers[0]?.title?.endsWith('…') === true,
    JSON.stringify(h.papers[0]?.title?.slice(-3)));
}

// ── 7. A long abstract is still truncated to 900 characters ───────────────
{
  serveItems([{ ...base, DOI: '10.1145/8', title: ['A paper'], abstract: 'B'.repeat(1200) }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a long abstract is still truncated to 900 characters',
    h.papers[0]?.abstract?.length === 900, String(h.papers[0]?.abstract?.length));
}

globalThis.fetch = realFetch;
console.log('\nD29 single clean pass: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
