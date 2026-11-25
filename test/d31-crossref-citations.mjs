// test/d31-crossref-citations.mjs — Crossref, ACM and IEEE drop the citation
// count the platform reports.
//
// THE DEFECT. `CROSSREF_FIELDS` — the `select` list all three connectors send —
// omitted `is-referenced-by-count`, so Crossref never returned it and `citedBy`
// was always `null` for `crossref`, `acm` and `ieee`.
//
// Crossref DOES report the field and it IS selectable. Verified live 24 Nov 2026
// on real records: 18, 57 and 4641 citations on three works.
//
// The consequence was that `min_citations` silently emptied those three sources:
//
//   Filter: citations >= 100 — 0 below the threshold · 2 DROPPED because the
//   source does not report a citation count.
//
// The reply was honest about the drop, but the cause was this `select` list, not
// a platform limitation — and the registry `note` for `ieee` claimed the
// opposite ("citation counts ARE present").
//
// WHAT MUST STILL WORK. A record that does not carry the field must still yield
// `null`, not 0 — that is the `workNumber` rule, and it is what keeps
// `min_citations` honest about a genuine absence.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned Crossref reply and record the request URL. */
function serveItems(items) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: { items } }),
    };
  };
  return seen;
}

const base = { author: [{ family: 'A' }], issued: { 'date-parts': [[2024]] }, type: 'journal-article' };

// ── 1. The field is REQUESTED ─────────────────────────────────────────────
{
  const seen = serveItems([]);
  await searchSource('crossref', 'x', { rows: 1 });
  const select = new URL(seen[0]).searchParams.get('select') ?? '';
  check('crossref requests is-referenced-by-count', select.includes('is-referenced-by-count'), select);
}

{
  const seen = serveItems([]);
  await searchSource('acm', 'x', { rows: 1 });
  const select = new URL(seen[0]).searchParams.get('select') ?? '';
  check('acm requests is-referenced-by-count', select.includes('is-referenced-by-count'), select);
}

{
  const seen = serveItems([]);
  await searchSource('ieee', 'x', { rows: 1 });
  const select = new URL(seen[0]).searchParams.get('select') ?? '';
  check('ieee requests is-referenced-by-count', select.includes('is-referenced-by-count'), select);
}

// ── 2. The field is MAPPED to citedBy, on all three sources ───────────────
for (const source of ['crossref', 'acm', 'ieee']) {
  serveItems([{
    ...base,
    DOI: '10.1145/3290605.3300233',
    title: ['A Crossref Item That Reports Its Citation Count'],
    'container-title': ['Some Journal'],
    'is-referenced-by-count': 42,
    URL: 'https://doi.org/10.1145/3290605.3300233',
  }]);
  const h = await searchSource(source, 'x', { rows: 1 });
  check(`${source}: the citation count reaches citedBy`, h.papers[0]?.citedBy === 42,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 3. A real 0 stays 0 ───────────────────────────────────────────────────
{
  serveItems([{ ...base, DOI: '10.1145/1', title: ['An uncited item'], 'is-referenced-by-count': 0 }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a reported 0 stays 0', h.papers[0]?.citedBy === 0, JSON.stringify(h.papers[0]?.citedBy));
}

// ── 4. An ABSENT field is still null, not 0 ───────────────────────────────
// Crossref omits the field for works nobody has cited yet. That is "not
// reported", and `min_citations` must keep counting it as such.
{
  serveItems([{ ...base, DOI: '10.1145/2', title: ['An item with no citation field'] }]);
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('an absent field is null, not 0', h.papers[0]?.citedBy === null,
    JSON.stringify(h.papers[0]?.citedBy));
}

// ── 5. The registry note for ieee is now true ─────────────────────────────
// The note said "Crossref does not carry IEEE abstracts" and then "citation
// counts ARE present" — true of Crossref, false of this connector before the fix.
{
  const { SOURCES } = await import('../lib/sources.js');
  const ieee = SOURCES.find((s) => s.id === 'ieee');
  check('the ieee registry entry still exists', Boolean(ieee), 'missing');
  check('the ieee note does not claim citation counts are absent',
    !/no citation|citation counts are not/i.test(ieee?.note ?? ''), ieee?.note ?? '');
}

globalThis.fetch = realFetch;
console.log('\nD31 crossref citations: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
