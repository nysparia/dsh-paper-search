// test/d117-core-journal.mjs — `core` mapped `journal` from `publisher`.
//
// THE DEFECT. `journal: c.publisher` printed a PUBLISHER in the journal slot.
// Measured 25 Nov 2026 with a canned CORE v3 record whose `publisher` is
// "Elsevier BV":
//
//   journal field: "Elsevier BV"   (CORE `publisher`, not a journal title)
//
// CORE's journal title is `journals[].title`; `publisher` is the publisher. The
// user saw "Elsevier BV" where a journal name belongs.
//
// ── NOT VERIFIED LIVE ───────────────────────────────────────────────────────
//
// CORE requires `CORE_API_KEY` and none is configured on this machine, so this
// mapping is read from CORE's documented v3 schema and from the canned record
// below — NOT from a real reply. The audit says the same.
//
// WHAT MUST STILL WORK. A record with no journal title reports `null` ("not
// reported"), never the publisher.

import { searchSource } from '../lib/sources.js';
import { check } from './harness.mjs';

const realFetch = globalThis.fetch;

/** Serve one canned CORE v3 reply. */
function serve(results) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ results }),
  });
}

const opts = { rows: 1, coreApiKey: 'test-key' };

// ── 1. THE DEFECT: the publisher is not the journal ───────────────────────
{
  serve([{
    title: 'A CORE record',
    yearPublished: 2020,
    publisher: 'Elsevier BV',
    journals: [{ title: 'Journal of Inertial Motion Capture' }],
  }]);
  const h = await searchSource('core', 'x', opts);
  check('the journal title is used', h.papers[0]?.journal === 'Journal of Inertial Motion Capture',
    JSON.stringify(h.papers[0]?.journal));
  check('the publisher is NOT in the journal slot', h.papers[0]?.journal !== 'Elsevier BV',
    JSON.stringify(h.papers[0]?.journal));
}

// ── 2. No journal title: null, not the publisher ──────────────────────────
{
  serve([{ title: 'A CORE record with no journal', yearPublished: 2020, publisher: 'Elsevier BV' }]);
  const h = await searchSource('core', 'x', opts);
  check('no journal title is null', h.papers[0]?.journal === null, JSON.stringify(h.papers[0]?.journal));
}

// ── 3. An empty journals array is null too ────────────────────────────────
{
  serve([{ title: 'A CORE record with an empty journals list', yearPublished: 2020, publisher: 'Elsevier BV', journals: [] }]);
  const h = await searchSource('core', 'x', opts);
  check('an empty journals list is null', h.papers[0]?.journal === null, JSON.stringify(h.papers[0]?.journal));
}

// ── 4. The rest of the record is unchanged ────────────────────────────────
{
  serve([{
    title: 'A CORE record',
    yearPublished: 2020,
    publisher: 'Elsevier BV',
    journals: [{ title: 'Some Journal' }],
    doi: '10.1234/abc',
    downloadUrl: 'https://core.ac.uk/download/1.pdf',
  }]);
  const h = await searchSource('core', 'x', opts);
  const p = h.papers[0];
  check('the title is unchanged', p?.title === 'A CORE record', JSON.stringify(p?.title));
  check('the year is unchanged', p?.year === 2020, JSON.stringify(p?.year));
  check('the doi is unchanged', p?.doi === '10.1234/abc', JSON.stringify(p?.doi));
  check('openAccess still follows downloadUrl', p?.openAccess === true, JSON.stringify(p?.openAccess));
}

globalThis.fetch = realFetch;
console.log('\nD100 core journal: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
