// d88 — the arXiv loose fallback must not re-send the SAME query.
//
// THE DEFECT. `arxiv()` runs a precise query, and if it returns nothing it runs a
// "loose" one — a reasonable design, because `all:inertial AND all:poser` is much
// stricter than `all:inertial poser`. But for a SINGLE-WORD query the two forms
// are the same string:
//
//   arxivQuery('literature', true)  -> 'all:literature'
//   arxivQuery('literature', false) -> 'all:literature'
//
// so the fallback re-sent an identical request, waited out arXiv's 3-second
// self-throttle in order to do it, and could not possibly get a different answer.
// Measured 24 Nov 2026 on 0.8.0 with `paper_status({probe:true, sources:'arxiv'})`:
// two identical requests to `export.arxiv.org/api/query?search_query=all%3Aliterature`.
//
// The cost is not only the wasted request: arXiv asks for 1 request / 3 seconds,
// so the duplicate turned a 1-request probe into a 6-second one.
//
// The rule: the fallback runs only when it is a DIFFERENT query. A multi-word
// query still gets its fallback, because there the two forms genuinely differ.

import { arxivQuery } from '../lib/sources.js';
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

/** An arXiv feed with no entries — the case that triggers the fallback. */
const EMPTY_FEED = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';

/** Run one arXiv search and return the `search_query` values actually sent. */
async function sentQueries(query) {
  const sent = [];
  const h = installFetch((url) => {
    if (url.includes('export.arxiv.org')) {
      sent.push(new URL(url).searchParams.get('search_query'));
      return { body: EMPTY_FEED };
    }
    return { body: {} };
  });
  const tools = loadTools();
  await tools.get('paper_search').execute({ query, sources: 'arxiv', max_results: 1 });
  h.restore();
  return sent;
}

// ── 1. The two forms really are identical for one word ──────────────────────
{
  check('a single-word query has ONE form', arxivQuery('literature', true) === arxivQuery('literature', false),
    `${arxivQuery('literature', true)} vs ${arxivQuery('literature', false)}`);
  check('a multi-word query has TWO forms', arxivQuery('inertial poser', true) !== arxivQuery('inertial poser', false),
    `${arxivQuery('inertial poser', true)} vs ${arxivQuery('inertial poser', false)}`);
}

// ── 2. A single-word query sends ONE request, not two ──────────────────────
{
  const sent = await sentQueries('literature');
  check('a single-word query sends exactly ONE arXiv request', sent.length === 1,
    `sent ${sent.length}: ${sent.join(' | ')}`);
  check('the two requests are not identical', new Set(sent).size === sent.length,
    sent.join(' | '));
}

// ── 3. A multi-word query still gets its fallback ──────────────────────────
//
// The fix must not be "never fall back" — that would lose the recall the fallback
// exists for.
{
  const sent = await sentQueries('inertial poser');
  check('a multi-word query still sends the fallback', sent.length === 2,
    `sent ${sent.length}: ${sent.join(' | ')}`);
  check('the fallback is a DIFFERENT query', sent.length === 2 && sent[0] !== sent[1],
    sent.join(' | '));
}

done('D88 the arXiv fallback is not a duplicate request');
