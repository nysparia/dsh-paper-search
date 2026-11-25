// d57 — `suspicious` could never fire on a TRUNCATED reference list.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580): a container record with 400 real
// references came back from OpenAlex with 100, so `refs` was 100, `100 <= 300`,
// and `suspicious` stayed false — the reply presented it as an ordinary bridge
// with no container warning, while its coupling had been computed on a quarter of
// its bibliography.
//
// `MAP_FIELDS` (lib/sources.js) did not request `referenced_works_count`, so the
// code had no way to tell a genuinely 100-reference work from a truncated one.
// The field is requested now, and a bridge whose returned list is shorter than
// the reported count is flagged as TRUNCATED — a different artifact from a long
// list, with its own message.

import { findBridges } from '../lib/peta.js';
import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

const refs = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const A = refs('a', 50);
const B = refs('b', 50);
const W = (id, r, extra = {}) => ({ id: `https://openalex.org/${id}`, title: id, referenced_works: r, ...extra });

// C shares 4 references with each group: coupling = 4 / sqrt(100*50) = 0.057,
// above the loose level and below the strict one, so it is a bridge.
const C_REFS = [...A.slice(0, 4), ...B.slice(0, 4), ...refs('c', 92)];
const WORKS = [
  ...['A1', 'A2', 'A3'].map((i) => W(i, A)),
  ...['B1', 'B2', 'B3'].map((i) => W(i, B)),
  W('C', C_REFS, { referenced_works_count: 400 }),
];

// ── 1. the bridge carries the reported count and the truncation flag ────────
{
  const d = findBridges(WORKS);
  const c = d.bridges.find((b) => b.id === 'C');
  check('the bridge is still found', Boolean(c), JSON.stringify(d.bridges.map((b) => b.id)));
  check('the reported reference count is carried', c?.refsReported === 400, JSON.stringify(c?.refsReported));
  check('a returned list shorter than the reported count is TRUNCATED', c?.truncated === true, JSON.stringify(c?.truncated));
  check('…and it is not confused with a long list', c?.suspicious === false, JSON.stringify(c?.suspicious));
}
{
  // A work whose returned list matches its reported count is not truncated.
  const d = findBridges(WORKS.map((w) => (w.id.endsWith('/C') ? { ...w, referenced_works_count: 100 } : w)));
  const c = d.bridges.find((b) => b.id === 'C');
  check('a complete list is NOT flagged as truncated', c?.truncated === false, JSON.stringify(c?.truncated));
}
{
  // No reported count at all is "unknown", not "truncated".
  const d = findBridges(WORKS.map((w) => (w.id.endsWith('/C') ? { ...w, referenced_works_count: undefined } : w)));
  const c = d.bridges.find((b) => b.id === 'C');
  check('an unreported count is not treated as truncation', c?.truncated === false && c?.refsReported === null,
    JSON.stringify([c?.truncated, c?.refsReported]));
}

// ── 2. the request asks for the field, and the reply says TRUNCATED ─────────
const SEED = {
  id: 'https://openalex.org/W1000', title: 'Seed', publication_year: 2010,
  cited_by_count: 50, referenced_works: ['https://openalex.org/W1'],
};
const CANDS = WORKS.map((w) => ({ ...w, publication_year: 2015, cited_by_count: 10 }));

const h = installFetch((url) => {
  const u = new URL(url);
  if (u.pathname === '/works/W1000') return { body: SEED };
  const filter = u.searchParams.get('filter') ?? '';
  if (filter.startsWith('cites:')) return { body: { results: CANDS, meta: { count: CANDS.length } } };
  return { body: { results: [] } };
});
const tools = loadTools();
const r = await tools.get('paper_citations').execute({ identifier: 'W1000', analysis: 'map', max_candidates: 10 });
h.restore();

const candidateCall = h.calls.find((c) => (new URL(c.url).searchParams.get('filter') ?? '').startsWith('cites:'));
const select = new URL(candidateCall?.url ?? 'http://x/').searchParams.get('select') ?? '';
check('the candidate request asks OpenAlex for referenced_works_count',
  select.split(',').includes('referenced_works_count'), select || '(no select parameter)');
check('the reply marks the bridge as TRUNCATED with both numbers',
  /⚠️ TRUNCATED \(100 of 400 returned\)/.test(r),
  r.split('\n').find((l) => /TRUNCATED/.test(l)));
check('…and summarises it separately from the long-list warning',
  /1 of them have a TRUNCATED reference list/.test(r),
  r.split('\n').find((l) => /TRUNCATED reference list/.test(l)));

done('D57 truncated reference list');
