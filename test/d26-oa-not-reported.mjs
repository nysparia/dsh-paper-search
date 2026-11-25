// test/d26-oa-not-reported.mjs — `summarizeOA` reports "not reported" as
// "not open access".
//
// THE DEFECT. `isOa: !!oa.is_oa` turned a MISSING `open_access` block into
// `false`, which is indistinguishable from a work OpenAlex explicitly marks
// `is_oa: false`. `paper_oa` then printed a definite negative:
//
//   work with no `open_access` field at all
//     -> summarizeOA -> {"isOa":false,"status":null,"oaUrl":null,"locations":[]}
//     -> paper_oa    -> "access status: NOT OPEN ACCESS — OpenAlex sees no free copy."
//
// That is a claim the data does not support, and it is the same defect
// `workNumber()` exists to prevent for citation counts: unknown must never print
// as a value. `detailOfWork` handles the distinction correctly for `citedBy`;
// `summarizeOA` did not.
//
// THE SHAPE OF THE FIX. `isOa` becomes `true` / `false` / **`null`**, and a new
// `reported` flag says whether OpenAlex reported the field at all. `reported` is
// ADDITIVE: a consumer that writes `if (!oa.isOa)` keeps its old behaviour, which
// is what makes this change safe for `lib/index.js` and `lib/fulltext.js` while
// they are owned by other branches.
//
// WHAT MUST STILL WORK. A work that DOES report `is_oa: false` is a real
// negative and must keep reporting as one — the fix must not turn every "no"
// into "unknown".

import { summarizeOA } from '../lib/sources.js';
import { check } from './harness.mjs';

// ── 1. The defect: an absent block is UNKNOWN, not "not open access" ────────
{
  const absent = summarizeOA({ id: 'W1', title: 'A Work With No open_access Block' });
  check('an absent open_access block yields isOa: null', absent.isOa === null, JSON.stringify(absent.isOa));
  check('an absent block yields reported: false', absent.reported === false, JSON.stringify(absent.reported));
}

{
  const nullBlock = summarizeOA({ id: 'W2', title: 'A Work With open_access: null', open_access: null });
  check('an explicit null block yields isOa: null', nullBlock.isOa === null, JSON.stringify(nullBlock.isOa));
  check('an explicit null block yields reported: false', nullBlock.reported === false, JSON.stringify(nullBlock.reported));
}

{
  // A present block that omits `is_oa` is still "not reported" — the field the
  // answer depends on is missing, even though the container is there.
  const noFlag = summarizeOA({ id: 'W3', open_access: { oa_status: 'closed' } });
  check('a block without is_oa yields isOa: null', noFlag.isOa === null, JSON.stringify(noFlag.isOa));
  check('a block without is_oa yields reported: false', noFlag.reported === false, JSON.stringify(noFlag.reported));
}

// ── 2. A real negative must stay a real negative ───────────────────────────
{
  const closed = summarizeOA({ id: 'W4', open_access: { is_oa: false, oa_status: 'closed' } });
  check('an explicit is_oa: false yields isOa: false', closed.isOa === false, JSON.stringify(closed.isOa));
  check('an explicit is_oa: false yields reported: true', closed.reported === true, JSON.stringify(closed.reported));
  check('the status is carried through', closed.status === 'closed', JSON.stringify(closed.status));
}

// ── 3. A real positive is unchanged ────────────────────────────────────────
{
  const open = summarizeOA({
    id: 'W5',
    open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://example.org/x.pdf' },
    locations: [
      { is_oa: true, pdf_url: 'https://example.org/x.pdf', landing_page_url: 'https://example.org/x', license: 'cc-by', version: 'publishedVersion', source: { display_name: 'Journal' } },
      { is_oa: false, pdf_url: 'https://example.org/not-oa.pdf' },
    ],
  });
  check('an open work yields isOa: true', open.isOa === true, JSON.stringify(open.isOa));
  check('an open work yields reported: true', open.reported === true, JSON.stringify(open.reported));
  check('the status is carried through', open.status === 'gold', JSON.stringify(open.status));
  check('the oaUrl is carried through', open.oaUrl === 'https://example.org/x.pdf', JSON.stringify(open.oaUrl));
  check('only the OA location is listed', open.locations.length === 1, String(open.locations.length));
  check('the location keeps its license', open.locations[0]?.license === 'cc-by', JSON.stringify(open.locations[0]?.license));
}

// ── 4. The three states are DISTINGUISHABLE from each other ────────────────
// This is the whole point: a consumer must be able to tell "yes", "no" and
// "not reported" apart. If any two of these serialize the same, the fix failed.
{
  const yes = JSON.stringify(summarizeOA({ open_access: { is_oa: true } }).isOa);
  const no = JSON.stringify(summarizeOA({ open_access: { is_oa: false } }).isOa);
  const unknown = JSON.stringify(summarizeOA({}).isOa);
  check('yes, no and unknown are three different values',
    new Set([yes, no, unknown]).size === 3, `${yes} / ${no} / ${unknown}`);
}

// ── 5. `locations` is still read from the work, not from the block ─────────
// A work can carry OA locations while the `open_access` block is absent; those
// locations are real and must not be dropped by the new guard.
{
  const locs = summarizeOA({
    id: 'W6',
    locations: [{ is_oa: true, pdf_url: 'https://example.org/y.pdf' }],
  });
  check('locations are still collected when the block is absent', locs.locations.length === 1,
    String(locs.locations.length));
  check('but isOa is still unknown', locs.isOa === null, JSON.stringify(locs.isOa));
}

console.log('\nD26 summarizeOA not-reported: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
