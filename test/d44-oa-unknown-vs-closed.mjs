// test/d44-oa-unknown-vs-closed.mjs — D44 (audit L29's sibling, F5): `pdfCandidates`
// must not collapse "not reported" into "reported closed".
//
// THE DEFECT, and where it lives. `summarizeOA` (`lib/sources.js:1026`) ends with
//
//   return { isOa: !!oa.is_oa, status: oa.oa_status ?? null, oaUrl: …, locations };
//
// so a work whose `open_access` block is MISSING and a work OpenAlex reports as
// CLOSED both arrive at `pdfCandidates` as `isOa: false` — two opposite facts,
// one value. `lib/sources.js` is owned by another change and is NOT edited here;
// that change makes the field three-valued (`null`/`undefined` = not reported,
// `false` = reported closed).
//
// THIS FILE'S PART. `pdfCandidates` consumes `summarizeOA(work)` and must keep
// working when the field becomes three-valued. It must treat `null`/`undefined`
// as UNKNOWN, never as `false` — a `!isOa` test would turn "OpenAlex did not say"
// into "OpenAlex says no", which is the same class of defect one layer down.
//
// HOW THE FIX IS WRITTEN. `pdfCandidates` does not read `isOa` at all. The
// candidates come from `locations`, which is the only field that carries a URL:
// a location with a `pdf_url` is a real open-access copy whether or not the
// summary flag was reported, and a work with no locations yields no candidates
// either way. That makes the function's answer INDEPENDENT of which of the two
// shapes `summarizeOA` returns, which is the only way to be correct under both.
//
// WHY THE INJECTION IS NEEDED TO TEST IT. The CURRENT `summarizeOA` coerces to a
// boolean, so it cannot produce the `null` this function must tolerate. The
// `summarize` option (same pattern as `findArxiv` in `prepareFullText`) lets the
// test hand `pdfCandidates` the shape the fixed `summarizeOA` will return.
// Production always uses the default.
import { pdfCandidates } from '../lib/fulltext.js';
import { summarizeOA } from '../lib/sources.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const PDF = 'https://example.org/paper.pdf';
const LANDING = 'https://example.org/paper';

/** A work with one green OA location. */
const workWithLocation = {
  doi: '10.1038/nature14539',
  title: 'A paper',
  publication_year: 2015,
  open_access: { is_oa: true, oa_status: 'green' },
  locations: [{ is_oa: true, pdf_url: PDF, landing_page_url: LANDING, source: { display_name: 'Nature' } }],
};

/** A work with NO open_access block at all — the "not reported" case. */
const workWithoutOaBlock = {
  doi: '10.1038/nature14539',
  title: 'A paper',
  publication_year: 2015,
  locations: [{ is_oa: true, pdf_url: PDF, landing_page_url: LANDING, source: { display_name: 'Nature' } }],
};

/** A work OpenAlex reports as CLOSED, with no OA location. */
const workClosed = {
  doi: '10.1038/nature14539',
  title: 'A paper',
  publication_year: 2015,
  open_access: { is_oa: false, oa_status: 'closed' },
  locations: [],
};

/**
 * A stand-in for the FIXED `summarizeOA`: `isOa` is three-valued and `locations`
 * is filled from `work.locations` exactly as the real one does.
 */
function summarizeThreeValued(work) {
  const oa = work?.open_access;
  const locations = [];
  for (const l of work?.locations ?? []) {
    if (!l?.is_oa) continue;
    locations.push({
      pdf: l.pdf_url ?? null,
      landing: l.landing_page_url ?? null,
      license: l.license ?? null,
      version: l.version ?? null,
      source: l.source?.display_name ?? null,
    });
  }
  return {
    // The whole point: a MISSING block is `null`, a reported-closed work is `false`.
    isOa: oa === undefined || oa === null ? null : Boolean(oa.is_oa),
    status: oa?.oa_status ?? null,
    oaUrl: oa?.oa_url ?? null,
    locations,
  };
}

// ── 1. The three shapes of `isOa` must all yield the same candidates ───────
//
// This is the assertion that pins the fix. If `pdfCandidates` ever starts
// testing `isOa`, one of these three diverges.
//
// HONEST NOTE ON WHAT FAILS ON THE BASELINE. The unmodified `pdfCandidates` does
// not read `isOa` either — it reads `oa.locations` and nothing else — so the
// invariance below holds there BY ACCIDENT, not by design. The regression these
// assertions guard against is a FUTURE `if (!oa.isOa) return []` guard, which is
// exactly the mistake the audit warns about one layer up. What fails on the
// baseline is the SEAM (assertion 0) and the `locations` guard (section 4): the
// seam is what makes the tolerance verifiable at all, and the guard is what
// keeps the function working if the fixed `summarizeOA` reports "nothing known"
// as a null field rather than an empty array.
check('pdfCandidates accepts a `summarize` override (the tolerance is testable)',
  (() => {
    const sentinel = { isOa: null, status: null, oaUrl: null, locations: [{ pdf: 'https://sentinel.example/x.pdf' }] };
    const urls = pdfCandidates(workWithLocation, { summarize: () => sentinel }).map((c) => c.url);
    return urls.includes('https://sentinel.example/x.pdf');
  })(),
  'the injected summary was ignored — the three-valued shape cannot be exercised');

const shapes = [
  ['isOa: true', { isOa: true, status: 'green', oaUrl: null, locations: summarizeThreeValued(workWithLocation).locations }],
  ['isOa: null (not reported)', { isOa: null, status: null, oaUrl: null, locations: summarizeThreeValued(workWithLocation).locations }],
  ['isOa: undefined (not reported)', { isOa: undefined, status: null, oaUrl: null, locations: summarizeThreeValued(workWithLocation).locations }],
  ['isOa: false (reported closed, but a location exists)', { isOa: false, status: 'closed', oaUrl: null, locations: summarizeThreeValued(workWithLocation).locations }],
];

const results = shapes.map(([label, summary]) => ({
  label,
  urls: pdfCandidates(workWithLocation, { summarize: () => summary }).map((c) => c.url),
}));

for (const { label, urls } of results) {
  check(`a location is offered when ${label}`,
    urls.includes(PDF),
    urls.join(' | ') || '(no candidates)');
}
check('all four isOa shapes produce the SAME candidate list',
  new Set(results.map((r) => r.urls.join('|'))).size === 1,
  results.map((r) => `${r.label}: ${r.urls.join(',')}`).join(' || '));

// ── 2. `null` must not be read as `false` ──────────────────────────────────
//
// The specific regression: a `!isOa` guard would drop the location for `null`
// and `undefined`. Stated as its own assertion so the failure names the cause.
for (const value of [null, undefined]) {
  const urls = pdfCandidates(workWithLocation, {
    summarize: () => ({ isOa: value, status: null, oaUrl: null, locations: summarizeThreeValued(workWithLocation).locations }),
  }).map((c) => c.url);
  check(`isOa: ${String(value)} is treated as UNKNOWN, not as false`,
    urls.includes(PDF),
    urls.join(' | ') || '(no candidates — the location was dropped)');
}

// ── 3. A genuinely closed work still yields nothing ────────────────────────
//
// The fix must not become "always offer something". No location, no candidate.
for (const value of [false, null, undefined]) {
  const urls = pdfCandidates(workClosed, {
    summarize: () => ({ isOa: value, status: value === false ? 'closed' : null, oaUrl: null, locations: [] }),
  }).map((c) => c.url);
  check(`a work with no OA location yields no candidate (isOa: ${String(value)})`,
    urls.length === 0,
    urls.join(' | ') || '(none)');
}

// ── 4. Defensive against a `locations` field that is not an array ──────────
//
// The assumption stated in the code is that the fixed `summarizeOA` keeps
// `locations` an array. If it ever returns `null` instead, this must degrade to
// "no candidates", not throw — a thrown error here would fail the whole tool.
for (const bad of [null, undefined]) {
  let threw = null;
  let urls = [];
  try {
    urls = pdfCandidates(workWithLocation, {
      summarize: () => ({ isOa: null, status: null, oaUrl: null, locations: bad }),
    }).map((c) => c.url);
  } catch (e) { threw = e; }
  check(`a ${String(bad)} locations field does not throw`,
    threw === null,
    threw ? String(threw.message) : 'ok');
  check(`a ${String(bad)} locations field yields no candidates`,
    urls.length === 0,
    urls.join(' | ') || '(none)');
}

// ── 5. The REAL summarizeOA still works through the default path ───────────
//
// The injection must not have replaced the production path. With the current
// (boolean-coercing) `summarizeOA`, a work with a location still yields it.
const realUrls = pdfCandidates(workWithLocation).map((c) => c.url);
check('the default path (real summarizeOA) still offers the location',
  realUrls.includes(PDF),
  realUrls.join(' | ') || '(no candidates)');
check('the real summarizeOA is what the default uses',
  summarizeOA(workWithLocation).locations.length === 1,
  JSON.stringify(summarizeOA(workWithLocation).locations));

// A work with NO open_access block, through the real function: the location is
// still offered, because `locations` is read from `work.locations` regardless.
const noBlockUrls = pdfCandidates(workWithoutOaBlock).map((c) => c.url);
check('a work with no open_access block still offers its location (real path)',
  noBlockUrls.includes(PDF),
  noBlockUrls.join(' | ') || '(no candidates)');

// ── 6. arXiv still comes FIRST, and is unaffected by any of this ───────────
const withArxiv = pdfCandidates(workWithLocation, { arxivId: '2401.00001' }).map((c) => c.url);
check('the arXiv candidate is still first',
  withArxiv[0] === 'https://arxiv.org/pdf/2401.00001',
  withArxiv.join(' | '));
check('the OA location still follows the arXiv candidate',
  withArxiv.includes(PDF),
  withArxiv.join(' | '));

// An arXiv id derived from the work itself (the `10.48550/arXiv.…` DOI form).
const arxivDoiWork = { doi: '10.48550/arXiv.2401.00002', title: 'A preprint', publication_year: 2024 };
const derived = pdfCandidates(arxivDoiWork).map((c) => c.url);
check('an arXiv id is still derived from the DOI form',
  derived.some((u) => u.includes('arxiv.org/pdf/2401.00002')),
  derived.join(' | ') || '(no candidates)');

done('D44 isOa unknown vs reported closed');
