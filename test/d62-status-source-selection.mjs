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

// ── 4. The same rule in paper_detail: a repeated identifier is one paper ────
//
// `resolveWorks` already de-duplicated within a group, so the duplicate was
// never fetched twice — but nothing said so. Measured 24 Nov 2026 on 0.7.0
// (HEAD ba4b580): `identifiers: ['10.1234/a','10.1234/a']` answered "1 paper ·
// 2 OpenAlex requests" with no note, so a caller who asked for two papers could
// not tell whether the second was absent from OpenAlex or had been collapsed.
{
  const det = loadTools().get('paper_detail');
  const hd = installFetch((url) => {
    if (url.includes('is_retracted%3Atrue')) return { body: { results: [] } };
    const m = /filter=(doi|openalex_id)%3A([^&]+)/.exec(url);
    if (!m) return { body: { results: [] } };
    return { body: { results: decodeURIComponent(m[2]).split('|').map((v) => ({
      id: `https://openalex.org/W${v.replace(/\W/g, '')}`, title: `Paper ${v}`,
      publication_year: 2020, cited_by_count: 1,
    })) } };
  });
  const r = await det.execute({ identifiers: ['10.1234/a', '10.1234/a'] });
  hd.restore();
  check('a repeated identifier is ONE paper', /^1 paper ·/.test(r), r.split('\n')[0]);
  check('the repetition is REPORTED',
    /repeated identifier\(s\) counted once: 10\.1234\/a/.test(r),
    r.split('\n').find((l) => /repeated/.test(l)) ?? 'SILENT');
}

// ── 5. A cached source is MARKED in the per-source list ─────────────────────
//
// It used to print "(0 ms)", which reads as "this source answered instantly" —
// the opposite of the truth, which is that it was not asked at all. The summary
// line does say how many were served from cache, but a reader who skims the
// per-source list sees only the timings.
{
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(tmpdir(), `dsh-d62-cache-${process.pid}.json`);
  rmSync(file, { force: true });
  const hc = installFetch(() => ({ body: { message: { items: [
    { DOI: '10.1234/a', title: ['A'], issued: { 'date-parts': [[2020]] }, 'is-referenced-by-count': 3 },
  ] } } }));
  await loadTools({ cache: true, cacheFile: file }).get('paper_search').execute({ query: 'x', sources: 'crossref' });
  const second = await loadTools({ cache: true, cacheFile: file }).get('paper_search').execute({ query: 'x', sources: 'crossref' });
  hc.restore();
  rmSync(file, { force: true });
  const line = second.split('\n').find((l) => /^  OK/.test(l));
  check('a cached source says "cached", not "0 ms"', /\(cached\)/.test(line ?? ''), line ?? 'no OK line');
}

done('D62 paper_status source selection');
