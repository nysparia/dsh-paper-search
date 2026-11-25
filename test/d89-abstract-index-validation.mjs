// d89 — a malformed `abstract_inverted_index` must not crash the tool, and a
// partial rebuild must not be presented as the abstract.
//
// THE DEFECT. `openAlexAbstract` was four lines:
//
//   for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = word;
//   return pos.filter(Boolean).join(' ') || null;
//
// Measured 24 Nov 2026 on 0.8.0 with a reply whose positions were a NUMBER
// instead of an array:
//
//   { abstract_inverted_index: { word: 5 } }
//     -> TypeError: idxs is not iterable
//
// and that throw came out of `paper_detail` — a tool whose only documented throws
// are for invalid ARGUMENTS. A malformed third-party reply must never take the
// tool down.
//
// The same expression silently DROPPED words at positions that are not array
// indices: `{ a: [-1], b: [0] }` produced "b", and `{ a: [1e9], b: [0] }`
// produced "b a" from a sparse array a billion elements long. A partial abstract
// reads as the paper's abstract, which is a wrong answer rather than a missing
// one — the same rule `workNumber` exists for.
//
// The rule now: the index is VALIDATED first. Anything that is not an array of
// non-negative integers below a sane cap makes the whole abstract `null`, and the
// caller says "OpenAlex has no abstract for this work" — which is true, we could
// not build one.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** Run `paper_detail` against a work carrying `extra`, and return the abstract line. */
async function abstractLine(extra) {
  const work = { id: 'https://openalex.org/W1', title: 'T', publication_year: 2020, cited_by_count: 1, ...extra };
  const tools = loadTools();
  const h = installFetch((url) => (url.includes('is_retracted%3Atrue')
    ? { body: { results: [] } }
    : { body: { results: [work] } }));
  let reply;
  try {
    reply = await tools.get('paper_detail').execute({ identifier: 'W1' });
  } catch (e) {
    h.restore();
    return { threw: true, message: String(e?.message ?? e) };
  }
  h.restore();
  const line = reply.split('\n').find((l) => l.trim().startsWith('abstract:'));
  return { threw: false, text: (line ?? '').trim().slice('abstract:'.length).trim() };
}

const NO_ABSTRACT = '(OpenAlex has no abstract for this work)';

// ── 1. A valid index still rebuilds correctly ───────────────────────────────
{
  const r = await abstractLine({ abstract_inverted_index: { Deep: [0], learning: [1], works: [2] } });
  check('a valid index rebuilds the sentence', r.text === 'Deep learning works', JSON.stringify(r));
}
{
  // Out-of-order positions are the NORMAL shape — the map is not sorted.
  const r = await abstractLine({ abstract_inverted_index: { a: [2], b: [0], c: [1] } });
  check('out-of-order positions are ordered by position', r.text === 'b c a', JSON.stringify(r));
}
{
  const r = await abstractLine({ abstract_inverted_index: { a: [0, 2], b: [1] } });
  check('a word at two positions appears twice', r.text === 'a b a', JSON.stringify(r));
}

// ── 2. A malformed index must NOT throw ────────────────────────────────────
{
  const r = await abstractLine({ abstract_inverted_index: { word: 5 } });
  check('positions that are not an array do not throw', r.threw === false, r.message ?? '');
  check('…and the reply says there is no abstract', r.text === NO_ABSTRACT, JSON.stringify(r.text));
}
{
  const r = await abstractLine({ abstract_inverted_index: { word: null } });
  check('positions that are null do not throw', r.threw === false, r.message ?? '');
}

// ── 3. A partial rebuild is NOT presented as the abstract ──────────────────
{
  const r = await abstractLine({ abstract_inverted_index: { a: [-1], b: [0] } });
  check('a negative position does not silently drop a word', r.text === NO_ABSTRACT, JSON.stringify(r.text));
}
{
  const r = await abstractLine({ abstract_inverted_index: { a: [1e9], b: [0] } });
  check('an absurd position does not silently drop a word', r.text === NO_ABSTRACT, JSON.stringify(r.text));
}
{
  const r = await abstractLine({ abstract_inverted_index: { a: [0.5], b: [0] } });
  check('a fractional position does not silently drop a word', r.text === NO_ABSTRACT, JSON.stringify(r.text));
}

// ── 4. Absent / empty still means "no abstract", not a crash ───────────────
{
  const r = await abstractLine({ abstract_inverted_index: {} });
  check('an empty index means no abstract', r.text === NO_ABSTRACT, JSON.stringify(r.text));
}
{
  const r = await abstractLine({});
  check('a missing index means no abstract', r.text === NO_ABSTRACT, JSON.stringify(r.text));
}

done('D89 abstract inverted-index validation');
