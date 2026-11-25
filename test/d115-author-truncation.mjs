// test/d115-author-truncation.mjs — author lists were cut to 15 with nothing
// saying so.
//
// THE DEFECT. `makePaper` did `authorList(p.authors).slice(0, 15)`. Measured
// 25 Nov 2026:
//
//   authorList(40 names).length   : 40
//   paper.authors.length          : 15 (of 40 the platform reported)
//   any field saying it was cut?  : []
//
// A 40-author consortium paper was shown with 15 names and nothing anywhere said
// the list was partial. Not a false value, but a silent one.
//
// ── WHAT WAS CHANGED, AND WHAT WAS NOT ──────────────────────────────────────
//
// The cap STAYS: the reply prints three names and "et al", so 15 is already far
// more than it shows, and raising it would only make the record bigger. What
// changed is that the untruncated length is now carried as `authorCount` on the
// record — a plain number, not a property hung on the array, because an array
// with extra properties is a trap for every `Array.isArray`/spread/JSON
// round-trip downstream. The REPLY SHAPE IS UNCHANGED: `formatResult` still
// prints three names and "et al".

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Europe PMC reply with `n` authors. */
function serveAuthors(n) {
  const names = Array.from({ length: n }, (_, i) => `Author${i + 1} X`);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      resultList: { result: [{ id: '1', title: 'A paper', pubYear: '2024', authorString: names.join(', ') }] },
    }),
  });
}

// ── 1. THE DEFECT: 40 authors, 15 kept, and the total is now visible ──────
{
  serveAuthors(40);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  const p = h.papers[0];
  check('the list is still capped at 15', p?.authors.length === 15, `${p?.authors.length} name(s)`);
  check('the untruncated count is carried', p?.authorCount === 40, JSON.stringify(p?.authorCount));
  check('the count is a plain number, not a property on the array',
    typeof p?.authorCount === 'number' && !Object.prototype.hasOwnProperty.call(p?.authors ?? [], 'authorCount'),
    typeof p?.authorCount);
}

// ── 2. A short list is unchanged, and the count matches it ────────────────
{
  serveAuthors(3);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  const p = h.papers[0];
  check('a 3-author list keeps all 3', p?.authors.length === 3, `${p?.authors.length} name(s)`);
  check('a 3-author list reports 3', p?.authorCount === 3, JSON.stringify(p?.authorCount));
}

// ── 3. Exactly 15 is not a truncation ─────────────────────────────────────
{
  serveAuthors(15);
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  check('15 authors: 15 kept', h.papers[0]?.authors.length === 15, `${h.papers[0]?.authors.length}`);
  check('15 authors: 15 reported', h.papers[0]?.authorCount === 15, JSON.stringify(h.papers[0]?.authorCount));
}

// ── 4. No authors at all is 0, not null ───────────────────────────────────
{
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ resultList: { result: [{ id: '1', title: 'A paper', pubYear: '2024' }] } }),
  });
  const h = await searchSource('europepmc', 'x', { rows: 1 });
  check('no authors: the list is empty', h.papers[0]?.authors.length === 0, `${h.papers[0]?.authors.length}`);
  check('no authors: the count is 0', h.papers[0]?.authorCount === 0, JSON.stringify(h.papers[0]?.authorCount));
}

// ── 5. The reply shape is unchanged ───────────────────────────────────────
// The record gained a field; the printed line must not have. `formatResult`
// prints three names and "et al" — asserted here so a later change cannot turn
// `authorCount` into a fourth name.
{
  const { loadTools } = await import('./harness.mjs');
  const tools = loadTools();
  const search = tools.get('paper_search');
  check('paper_search is registered', Boolean(search), 'missing');
  serveAuthors(40);
  const reply = await search.execute({ query: 'x', sources: 'europepmc', max_results: 1 });
  const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
  check('the reply still prints "et al"', /et al/.test(text), text.slice(0, 200));
  check('the reply does not print the 4th author', !/Author4 X/.test(text), text.slice(0, 400));
}

globalThis.fetch = realFetch;
console.log('\nD98 author truncation: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
