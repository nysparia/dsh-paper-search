// d64 — a copy that OpenAlex NAMES must not be reported as "no free copy".
//
// THE DEFECT, in three shapes, all measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580).
// Each one ends with the tool saying there is no open-access copy while the
// reply it was given contains one — the confident-wrong-answer shape this
// package treats as worse than a visible error.
//
//   1. A LOCATION WITH A `pdf_url` BUT NO `is_oa` FLAG WAS DROPPED.
//      `summarizeOA` tested `if (!l?.is_oa) continue`, and OpenAlex omits that
//      flag on some locations. `{locations:[{pdf_url:'…'}]}` produced
//      `locations: []`, so `paper_fulltext` answered "no open-access copy found
//      for this work".
//
//   2. `best_oa_location` WAS NEVER READ. It is OpenAlex's RECOMMENDED copy and
//      is usually also in `locations`, but when it is the only one the tool
//      reported nothing.
//
//   3. `paper_oa` BRANCHED ON THE FLAG ALONE. A work with
//      `open_access.is_oa: false` AND a location carrying `is_oa: true` and a
//      `pdf_url` printed "NOT OPEN ACCESS — OpenAlex sees no free copy" and
//      returned WITHOUT listing the copy it had just found.
//
// The rule: the URL is the evidence. `is_oa: true` keeps a location, `is_oa:
// false` drops it (the platform said so), and an ABSENT flag keeps it — because
// "the flag was not stated" is not "this is not open access".

import { loadTools, installFetch, reporter } from './harness.mjs';
import { summarizeOA } from '../lib/sources.js';
import { pdfCandidates } from '../lib/fulltext.js';

const { check, done } = reporter();

// ── 1. summarizeOA keeps a location that has a URL but no flag ──────────────
{
  const oa = summarizeOA({ open_access: { is_oa: true }, locations: [{ pdf_url: 'https://x/a.pdf' }] });
  check('a location with a pdf_url and NO is_oa flag is kept', oa.locations.length === 1,
    `locations=${oa.locations.length}`);
  check('its PDF URL survives', oa.locations[0]?.pdf === 'https://x/a.pdf', JSON.stringify(oa.locations[0]));
}
{
  // The other half: an explicit `is_oa: false` is the platform saying no.
  const oa = summarizeOA({ open_access: { is_oa: false }, locations: [{ is_oa: false, pdf_url: 'https://x/a.pdf' }] });
  check('a location the platform marks is_oa:false is still DROPPED', oa.locations.length === 0,
    `locations=${oa.locations.length}`);
}

// ── 2. best_oa_location is read when locations is empty ─────────────────────
{
  const oa = summarizeOA({
    open_access: { is_oa: true },
    best_oa_location: { is_oa: true, pdf_url: 'https://x/b.pdf' },
    locations: [],
  });
  check('best_oa_location is used when locations is empty', oa.locations.length === 1,
    `locations=${oa.locations.length}`);
  check('the best copy is the one named', oa.locations[0]?.pdf === 'https://x/b.pdf', JSON.stringify(oa.locations[0]));
}

// ── 3. pdfCandidates uses open_access.oa_url as a last resort ───────────────
{
  const cands = pdfCandidates({ open_access: { is_oa: true, oa_url: 'https://x/a.pdf' }, locations: [] });
  check('open_access.oa_url becomes a candidate', cands.some((c) => c.url === 'https://x/a.pdf'),
    JSON.stringify(cands.map((c) => c.url)));
}

// ── 4. paper_oa shows a copy it found, even when the flag says closed ───────
{
  const work = {
    id: 'https://openalex.org/W1', title: 'T', publication_year: 2020, cited_by_count: 1,
    open_access: { is_oa: false, oa_status: 'closed' },
    locations: [{ is_oa: true, pdf_url: 'https://x/a.pdf', license: 'cc-by' }],
  };
  const tools = loadTools();
  const h = installFetch(() => ({ body: work }));
  const r = await tools.get('paper_oa').execute({ identifier: 'W1' });
  h.restore();
  check('paper_oa does NOT claim there is no free copy', !/sees no free copy/.test(r),
    r.split('\n').find((l) => /access status/.test(l)) ?? '');
  check('paper_oa LISTS the copy it found', /https:\/\/x\/a\.pdf/.test(r),
    r.split('\n').filter((l) => /PDF|page /.test(l)).join(' | ') || 'not listed');
  check('paper_oa states that the flag and the locations disagree',
    /summary flag says NOT OPEN ACCESS/.test(r),
    r.split('\n').find((l) => /access status/.test(l)) ?? '');
}

// ── 5. A genuinely closed work still says so ───────────────────────────────
{
  const work = {
    id: 'https://openalex.org/W1', title: 'T', publication_year: 2020, cited_by_count: 1,
    open_access: { is_oa: false, oa_status: 'closed' }, locations: [],
  };
  const tools = loadTools();
  const h = installFetch(() => ({ body: work }));
  const r = await tools.get('paper_oa').execute({ identifier: 'W1' });
  h.restore();
  check('a genuinely closed work still reports NOT OPEN ACCESS',
    /NOT OPEN ACCESS \(closed\) — OpenAlex sees no free copy/.test(r),
    r.split('\n').find((l) => /access status/.test(l)) ?? '');
}

done('D64 an open-access copy that was named is shown');
