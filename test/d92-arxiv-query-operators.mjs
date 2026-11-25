// test/d92-arxiv-query-operators.mjs — two defects in `arxivQuery`.
//
// ── M1: AN OPERATOR-ONLY QUERY BECAME `all:AND`, WHICH arXiv REJECTS ────────
//
// The comment above `arxivQuery` says a query with nothing searchable returns
// `null` so the caller skips the request. The `terms.length === 0` branch did
// the opposite — it sent the OPERATOR as a search term. Measured live 25 Nov
// 2026:
//
//   curl 'https://export.arxiv.org/api/query?search_query=all%3AAND'
//     -> HTTP 400 "Invalid query string: 'AND'"
//
// so the user saw arXiv reported as FAILED for a query that simply cannot
// match. That is the converse of the rule this file follows: a non-failure must
// not be reported as a failure.
//
// ── M4: `+` WAS NOT STRIPPED, AND arXiv READS IT AS A SEPARATOR ────────────
//
// Measured live 25 Nov 2026:
//
//   all:C++        -> HTTP 200, totalResults=182461, top hits about carbon-12
//   all:C%2B%2B    -> HTTP 200, totalResults=182461   (percent-encoding does not help)
//   all:"C++"      -> HTTP 200, totalResults=182461   (quoting does not help either)
//
// arXiv's query language cannot express `+` at all, so "C++" still searches "C"
// — that part is NOT fixable here and this test does not pretend otherwise.
// What the strip fixes is the SILENT DEGRADATION of the precise form:
// `arxivQuery('foo+bar', true)` used to return the single term `all:foo+bar`,
// which arXiv read as the LOOSE `all:foo bar` — a precise AND search quietly
// became an OR search.
//
// WHAT MUST STILL WORK. `-` is part of real terms (`hep-th`) and must survive;
// an empty query still returns `null`; a normal multi-word query still produces
// the two documented forms.

import { arxivQuery, searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

// ── 1. M1: nothing but operators -> null, so no request is sent ────────────
{
  for (const q of ['AND', 'OR', 'NOT', 'ANDNOT', 'and or', 'not']) {
    check(`arxivQuery(${JSON.stringify(q)}) is null`, arxivQuery(q, true) === null,
      JSON.stringify(arxivQuery(q, true)));
  }
  check('the loose form is null too', arxivQuery('AND OR', false) === null,
    JSON.stringify(arxivQuery('AND OR', false)));
}

// ── 2. M1 end to end: an operator-only query costs NO request ──────────────
// Before the fix this sent `search_query=all%3AAND` and arXiv answered 400.
{
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<feed><entry><title>Should not be reached</title></entry></feed>',
    };
  };
  const h = await searchSource('arxiv', 'AND OR', { rows: 5 });
  check('an operator-only query sends NO request', calls.length === 0, JSON.stringify(calls));
  check('an operator-only query reports no error', h.error === null, h.error ?? 'null');
  check('an operator-only query returns no papers', h.papers.length === 0, String(h.papers.length));
}

// ── 3. M4: `+` no longer survives into the query string ────────────────────
{
  check('"C++" produces no "+" in the query', !arxivQuery('C++', true).includes('+'),
    JSON.stringify(arxivQuery('C++', true)));
  check('"foo+bar" is a PRECISE and-search, not a loose one',
    arxivQuery('foo+bar', true) === 'all:foo AND all:bar', JSON.stringify(arxivQuery('foo+bar', true)));
  check('"foo+bar" loose form is the two words', arxivQuery('foo+bar', false) === 'all:foo bar',
    JSON.stringify(arxivQuery('foo+bar', false)));
  for (const q of ['a|b', 'a~b', 'a&b']) {
    check(`${JSON.stringify(q)} is split into two terms`, arxivQuery(q, true) === 'all:a AND all:b',
      JSON.stringify(arxivQuery(q, true)));
  }
}

// ── 4. M4 end to end: the request URL carries no encoded "+" ───────────────
{
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => `<feed><entry><title>A Paper</title><id>http://arxiv.org/abs/1706.03762v7</id></entry></feed>`,
    };
  };
  const h = await searchSource('arxiv', 'C++', { rows: 3 });
  check('the arXiv request is made', calls.length === 1, JSON.stringify(calls));
  check('the request URL carries no %2B', !/%2B/i.test(calls[0] ?? ''), calls[0] ?? '(none)');
  check('and no bare "+"', !/\+/.test(calls[0] ?? ''), calls[0] ?? '(none)');
  check('the reply is still parsed', h.papers.length === 1, String(h.papers.length));
}

// ── 5. No regression: `-` is part of real terms and must survive ───────────
{
  check('"hep-th" keeps its hyphen', arxivQuery('hep-th', true) === 'all:hep-th',
    JSON.stringify(arxivQuery('hep-th', true)));
  check('"cond-mat/0102536" keeps its hyphen', arxivQuery('cond-mat/0102536', true) === 'all:cond-mat/0102536',
    JSON.stringify(arxivQuery('cond-mat/0102536', true)));
}

// ── 6. No regression: the empty and metacharacter-only cases ───────────────
{
  check('an empty query is null', arxivQuery('', true) === null, JSON.stringify(arxivQuery('', true)));
  check('a whitespace query is null', arxivQuery('   ', true) === null, JSON.stringify(arxivQuery('   ', true)));
  check('a metacharacter-only query is null', arxivQuery('""', true) === null, JSON.stringify(arxivQuery('""', true)));
  check('a normal multi-word query keeps both forms',
    arxivQuery('inertial poser', true) === 'all:inertial AND all:poser'
      && arxivQuery('inertial poser', false) === 'all:inertial poser',
    `${arxivQuery('inertial poser', true)} / ${arxivQuery('inertial poser', false)}`);
}

globalThis.fetch = realFetch;
console.log('\nD92 arXiv query operators: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
