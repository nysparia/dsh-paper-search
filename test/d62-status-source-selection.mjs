// d62 — `paper_status` must not report on FEWER sources than a bare call.
//
// THE DEFECT. `selectSources` maps the group keyword "all" to `DEFAULT_IDS`,
// which is right for `paper_search` — a bare search must not pay for `pmc` and
// `ios`, which are registered but off by default. It is wrong for the DOCTOR,
// whose whole job is to report on every REGISTERED source: a source that is off
// by default could break and this tool — the one place you would look — would
// never mention it.
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580):
//
//   paper_status({})              -> 23 of 23 sources checked
//   paper_status({sources:'all'}) -> 21 of 23 sources checked
//
// so asking for "all" reported on FEWER sources than asking for nothing, and the
// two it dropped are exactly the two a user reaches for this tool to diagnose.
//
// The same file also de-duplicated a repeated source id correctly but never said
// so, while `paper_search` printed "repeated source id(s) counted once". Two
// tools, one behaviour, two reports.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** How many sources the reply says it checked. */
function checkedCount(reply) {
  const line = reply.split('\n').find((l) => /sources checked above/.test(l));
  const m = /(\d+) of (\d+)/.exec(line ?? '');
  return m ? Number(m[1]) : -1;
}

/** The source ids the reply lists, in order. */
function listedIds(reply) {
  return reply.split('\n')
    .filter((l) => /^  \?/.test(l))
    .map((l) => l.trim().split(/\s+/)[1]);
}

const tools = loadTools();
const h = installFetch(() => ({ body: {} }));

// ── 1. "all" is not narrower than nothing ───────────────────────────────────
{
  const bare = await tools.get('paper_status').execute({});
  const all = await tools.get('paper_status').execute({ sources: 'all' });
  const star = await tools.get('paper_status').execute({ sources: '*' });

  check('a bare call checks every registered source', checkedCount(bare) === 23, `checked=${checkedCount(bare)}`);
  check('sources:"all" checks the SAME number as a bare call',
    checkedCount(all) === checkedCount(bare), `all=${checkedCount(all)} bare=${checkedCount(bare)}`);
  check('sources:"*" checks the SAME number as a bare call',
    checkedCount(star) === checkedCount(bare), `star=${checkedCount(star)} bare=${checkedCount(bare)}`);

  // The two off-by-default sources are the whole point: they must be listed.
  const ids = listedIds(all);
  check('sources:"all" lists the off-by-default pmc', ids.includes('PubMed'), `ids=${ids.join(',')}`);
  check('sources:"all" lists the off-by-default ios', ids.includes('IOS'), `ids=${ids.join(',')}`);
}

// ── 2. A real subset still narrows ──────────────────────────────────────────
{
  const one = await tools.get('paper_status').execute({ sources: 'crossref' });
  check('sources:"crossref" still narrows to one', checkedCount(one) === 1, `checked=${checkedCount(one)}`);

  const indo = await tools.get('paper_status').execute({ sources: 'indonesia' });
  check('sources:"indonesia" still narrows to the Indonesian portals',
    checkedCount(indo) === 2, `checked=${checkedCount(indo)}`);
}

// ── 3. A repeated id is one source, and the repetition is REPORTED ──────────
{
  const r = await tools.get('paper_status').execute({ sources: 'crossref,crossref,crossref' });
  check('a repeated id is checked ONCE', checkedCount(r) === 1, `checked=${checkedCount(r)}`);
  check('the repetition is REPORTED, in the same wording paper_search uses',
    /repeated source id\(s\) counted once: crossref/.test(r),
    r.split('\n').find((l) => /repeated/.test(l)) ?? 'SILENT');
}

h.restore();
done('D62 paper_status source selection');
