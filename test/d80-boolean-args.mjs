// d80 — a BOOLEAN argument that is not a boolean must not be a silent no-op.
//
// THE DEFECT. Five boolean parameters were read five different ways, and only
// ONE of them accepted the string spelling. Measured 24 Nov 2026 on 0.7.0
// (HEAD ba4b580):
//
//   open_access_only: "true"  -> the filter WAS applied   (it had been fixed)
//   force_refresh:    "true"  -> silently ignored, and not even the
//                                "had no effect" note was printed
//   probe:            "true"  -> 0 requests sent, reply says "not probed"
//   clear_cache:      "true"  -> the cache was NOT cleared
//
// A JSON schema declares these as booleans, but a caller that stringifies is
// making a spelling mistake, not asking for the opposite. The four silent
// no-ops are the worst outcome, because the reply then describes a state the
// caller did not ask for — "not probed" reads as a healthy configuration check
// that simply was not requested.
//
// THE RULE, now implemented once in `boolArg`:
//   true / "true" / "yes" / 1  -> true
//   false / "false" / "no" / 0 -> false   (the FALSE spellings already meant
//                                          false for open_access_only)
//   anything else              -> the default, and the caller is TOLD
//
// Guessing "true" for "yes please" would be a silent substitution of exactly the
// kind the rest of this file avoids, so an unrecognized value is reported.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** A Crossref that answers with one paper and records every request. */
function crossref() {
  const calls = [];
  const h = installFetch((url) => {
    calls.push(url);
    if (new URL(url).host === 'api.crossref.org') {
      return { body: { message: { items: [
        { DOI: '10.1/a', title: ['A'], issued: { 'date-parts': [[2020]] }, type: 'journal-article' },
      ] } } };
    }
    return { body: {} };
  });
  return { calls, restore: h.restore };
}

// ── 1. `force_refresh` honours the string spelling ──────────────────────────
//
// With the cache DISABLED the reply says so; with it ENABLED and a hit present
// the reply says the cache was bypassed. Either way the note must appear, which
// is what proves the value was read at all.
{
  for (const value of [true, 'true', 'TRUE', 'yes', 1]) {
    const tools = loadTools();
    const f = crossref();
    const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', force_refresh: value });
    f.restore();
    check(`force_refresh=${JSON.stringify(value)} is READ (the reply says what it did)`,
      /force_refresh/.test(r), r.split('\n').find((l) => /force_refresh/.test(l)) ?? 'SILENT');
  }
}

// ── 2. An unrecognized boolean is reported, not guessed ─────────────────────
{
  const tools = loadTools();
  const f = crossref();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', force_refresh: 'banana' });
  f.restore();
  check('force_refresh="banana" is REPORTED as not a boolean',
    /force_refresh "banana" is not a boolean/.test(r),
    r.split('\n').find((l) => /force_refresh/.test(l)) ?? 'SILENT');
}

// ── 3. `open_access_only` keeps its string handling, and gains the report ───
{
  for (const [value, filtered] of [[true, true], ['true', true], [false, false], ['false', false], ['no', false], [0, false]]) {
    const tools = loadTools();
    const f = crossref();
    const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', open_access_only: value });
    f.restore();
    check(`open_access_only=${JSON.stringify(value)} ${filtered ? 'applies' : 'does not apply'} the filter`,
      /Open-access filter:/.test(r) === filtered, `filtered=${/Open-access filter:/.test(r)}`);
  }
  const tools = loadTools();
  const f = crossref();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', open_access_only: 'banana' });
  f.restore();
  check('open_access_only="banana" is REPORTED as not a boolean',
    /open_access_only "banana" is not a boolean/.test(r),
    r.split('\n').find((l) => /open_access_only/.test(l)) ?? 'SILENT');
}

// ── 4. `paper_status`'s `probe` honours the string spelling ─────────────────
//
// This is the one that cost real requests: `probe:"true"` sent ZERO requests and
// then printed "not probed — pass probe:true to test it", so a caller who had
// just asked for a probe was told to ask for one.
{
  for (const value of [true, 'true', 'TRUE', 'yes', 1]) {
    const tools = loadTools();
    let requests = 0;
    const h = installFetch(() => { requests += 1; return { body: {} }; });
    await tools.get('paper_status').execute({ sources: 'crossref', probe: value });
    h.restore();
    check(`probe=${JSON.stringify(value)} really sends the request`, requests === 1, `requests=${requests}`);
  }
  for (const value of [false, 'false', 'no', 0]) {
    const tools = loadTools();
    let requests = 0;
    const h = installFetch(() => { requests += 1; return { body: {} }; });
    await tools.get('paper_status').execute({ sources: 'crossref', probe: value });
    h.restore();
    check(`probe=${JSON.stringify(value)} sends NO request`, requests === 0, `requests=${requests}`);
  }
  const tools = loadTools();
  const h = installFetch(() => ({ body: {} }));
  const r = await tools.get('paper_status').execute({ sources: 'crossref', probe: 'banana' });
  h.restore();
  check('probe="banana" is REPORTED as not a boolean',
    /probe "banana" is not a boolean/.test(r),
    r.split('\n').find((l) => /probe/.test(l)) ?? 'SILENT');
}

// ── 5. `clear_cache` honours the string spelling ────────────────────────────
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: {} }));
  const r = await tools.get('paper_status').execute({ sources: 'crossref', clear_cache: 'true' });
  h.restore();
  // With the cache disabled the honest answer is "NOT CLEARED — disabled", which
  // only appears when the value was READ. Before the fix the reply did not
  // contain the word "cache" at all.
  check('clear_cache="true" is READ (the reply talks about the cache)',
    /search cache/.test(r), r.split('\n').find((l) => /cache/i.test(l)) ?? 'SILENT');
}

done('D80 boolean arguments');
