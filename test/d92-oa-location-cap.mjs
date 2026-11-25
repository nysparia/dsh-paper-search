// d92 — `paper_oa` listed at most 10 copies and never said it had capped.
//
// THE DEFECT. `summarizeOA` stops collecting after 10 locations, and `paper_oa`
// printed `copies found: ${oa.locations.length}` — the number it LISTED, presented
// as the number that exist. Measured 24 Nov 2026 on 0.8.0 with a work carrying 15
// open-access locations:
//
//   copies found: 10
//    1. PDF   https://x/0.pdf
//    …
//   10. PDF   https://x/9.pdf
//
// Five copies were left out and nothing said so. This is the same "a count that
// does not match its own list" defect the cluster cap (`… and N more cluster(s)
// NOT LISTED`) and `DISPLAY_CAP` already fixed elsewhere in the reply.
//
// The fix: `summarizeOA` counts the copies it NAMED (`locationTotal`) separately
// from the ones it lists (`locations.length`), and the reply states both when
// they differ.

import { loadTools, installFetch, reporter } from './harness.mjs';
import { summarizeOA } from '../lib/sources.js';

const { check, done } = reporter();

/** A work carrying `n` open-access locations. */
function workWith(n) {
  return {
    id: 'https://openalex.org/W1', title: 'T', publication_year: 2020, cited_by_count: 1,
    open_access: { is_oa: true, oa_status: 'green' },
    locations: Array.from({ length: n }, (_, i) => ({ is_oa: true, pdf_url: `https://x/${i}.pdf`, license: 'cc-by' })),
  };
}

// ── 1. The summary counts what it named, separately from what it lists ──────
{
  const oa = summarizeOA(workWith(15));
  check('15 copies are listed as 10', oa.locations.length === 10, `listed=${oa.locations.length}`);
  check('the total named is 15', oa.locationTotal === 15, `total=${oa.locationTotal}`);
}
{
  const oa = summarizeOA(workWith(3));
  check('under the cap, the total equals the list', oa.locationTotal === 3 && oa.locations.length === 3,
    `total=${oa.locationTotal} listed=${oa.locations.length}`);
}
{
  // A location the platform marks closed is not a copy, so it must not be counted.
  const w = workWith(2);
  w.locations.push({ is_oa: false, pdf_url: 'https://x/closed.pdf' });
  const oa = summarizeOA(w);
  check('a closed location is not counted', oa.locationTotal === 2, `total=${oa.locationTotal}`);
}

// ── 2. The reply states the cap ────────────────────────────────────────────
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: workWith(15) }));
  const r = await tools.get('paper_oa').execute({ identifier: 'W1' });
  h.restore();
  check('the reply names the real total', /copies found: 15/.test(r),
    r.split('\n').find((l) => /copies found/.test(l)) ?? 'SILENT');
  check('the reply says only the first 10 are listed', /the first 10 are listed below/.test(r),
    r.split('\n').find((l) => /copies found/.test(l)) ?? 'SILENT');
  check('exactly 10 copies are listed', (r.match(/^\s*\d+\. (PDF|page)/gm) ?? []).length === 10,
    String((r.match(/^\s*\d+\. (PDF|page)/gm) ?? []).length));
}
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: workWith(3) }));
  const r = await tools.get('paper_oa').execute({ identifier: 'W1' });
  h.restore();
  check('under the cap, the reply does not mention a cap', !/are listed below/.test(r),
    r.split('\n').find((l) => /copies found/.test(l)) ?? '');
}

done('D92 the open-access location cap is stated');
