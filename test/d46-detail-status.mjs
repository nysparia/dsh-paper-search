// d46 — `paper_detail` and `paper_status` reporting.
//
// Six defects, all measured 24 Nov 2026 on 0.6.9 (HEAD 148f7c4):
//
//   1. `paper_detail` RETURNED "FAILED: …" for an unresolvable title while
//      `paper_oa` and `paper_citations` THREW for the same input — a rejected
//      call indistinguishable from an answer (DSH maps throw -> isError:true).
//   2. A title lookup that threw (HTTP 429) was reported as "genuinely absent
//      from OpenAlex" — a transient failure stated as a fact about the corpus.
//   3. A batch [TITLE, DOI] came back as [DOI, TITLE]: the title's work could not
//      be matched by `parseIdentifier` and was appended at the end.
//   4. The same paper given twice (a DOI and its OpenAlex id) was listed twice.
//   5. The request count was printed only in batch mode, and under-counted when a
//      title failed.
//   6. `paper_status` called a missing credential FAILED while `paper_search`
//      called it skipped; it silently widened a group keyword to all 23 sources;
//      and `clear_cache` was a silent no-op when the cache was disabled.

import { loadTools, installFetch, outcome, reporter } from './harness.mjs';

const { check, done } = reporter();

const WORK = (over = {}) => ({
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1234/a',
  title: 'Deep learning',
  publication_year: 2015,
  cited_by_count: 100,
  ids: {},
  ...over,
});

/** A fetch that answers the OpenAlex list endpoint with `works`, and titles with `titleWork`. */
function openAlexFetch({ works = [WORK()], titleWork = null, titleStatus = 200 } = {}) {
  return installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works') {
      const search = u.searchParams.get('search');
      if (search) {
        if (titleStatus !== 200) return { status: titleStatus, body: { error: 'rate' } };
        return { body: { results: titleWork ? [titleWork] : [] } };
      }
      const filter = u.searchParams.get('filter') ?? '';
      const m = /^doi:(.*?)(,is_retracted:true)?$/.exec(filter);
      const ids = m ? m[1].split('|').filter(Boolean) : [];
      return { body: { results: ids.length ? ids.map((d) => WORK({ doi: `https://doi.org/${d}` })) : works } };
    }
    return { body: {} };
  });
}

// ── 1. an unresolvable title THROWS ──────────────────────────────────────────
{
  const tools = loadTools();
  const h = openAlexFetch({ titleWork: null });
  const r = await outcome(() => tools.get('paper_detail').execute({ identifier: 'zzz qqq xxx' }));
  h.restore();
  check('paper_detail THROWS for an unresolvable title', r.threw, r.threw ? '' : `returned: ${String(r.value).slice(0, 60)}`);
}

// ── 2. a failed lookup is not reported as an absence ─────────────────────────
{
  const tools = loadTools();
  const h = openAlexFetch({ titleStatus: 429 });
  const r = await tools.get('paper_detail').execute({ identifiers: ['10.1234/a', 'Attention Is All You Need'] });
  h.restore();
  check('a 429 is reported as LOOKUP FAILED', /LOOKUP FAILED \(1\)/.test(r));
  check('a 429 is NOT reported as "genuinely absent"', !/genuinely absent/.test(r));
  check('the failure carries its own message', /rate-limiting|HTTP 429/.test(r));
}

// ── 3. batch order is restored for a title ───────────────────────────────────
{
  const tools = loadTools();
  const h = openAlexFetch({ titleWork: WORK({ id: 'https://openalex.org/WT', doi: null, title: 'Title Paper' }) });
  const r = await tools.get('paper_detail').execute({ identifiers: ['Attention Is All You Need', '10.1234/aaa'] });
  h.restore();
  const first = r.split('\n').find((l) => /^1\. /.test(l));
  check('the TITLE keeps slot 1 when it is first', /Title Paper/.test(first ?? ''), first);
}

// ── 4. the same paper twice is listed once ───────────────────────────────────
{
  const tools = loadTools();
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/works/W')) return { body: WORK() };
    return { body: { results: [WORK()] } };
  });
  const r = await tools.get('paper_detail').execute({ identifiers: ['10.1234/a', 'W1'] });
  h.restore();
  const occurrences = (r.match(/Deep learning/g) ?? []).length;
  check('a DOI and its OpenAlex id resolve to ONE entry', occurrences === 1, `occurrences=${occurrences}`);
  check('the duplicate is reported', /resolved to a paper already in this list/.test(r));
}

// ── 5. the request count is printed in both modes and is accurate ────────────
{
  const tools = loadTools();
  const h = openAlexFetch();
  const r = await tools.get('paper_detail').execute({ identifier: '10.1234/a' });
  h.restore();
  check('a single-identifier call prints its request count', /OpenAlex request/.test(r), r.split('\n')[0]);
}
{
  const tools = loadTools();
  let requests = 0;
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/works') {
      requests += 1;
      if (u.searchParams.get('search')) return { status: 429, body: { error: 'rate' } };
      const filter = u.searchParams.get('filter') ?? '';
      const ids = (/^doi:(.*?)(,is_retracted:true)?$/.exec(filter)?.[1] ?? '').split('|').filter(Boolean);
      return { body: { results: ids.map((d) => WORK({ doi: `https://doi.org/${d}` })) } };
    }
    return { body: {} };
  });
  const r = await tools.get('paper_detail').execute({ identifiers: ['10.1234/a', 'Bad 1', 'Bad 2', 'Bad 3', 'Bad 4'] });
  h.restore();
  const reported = Number(/· (\d+) OpenAlex request/.exec(r)?.[1] ?? -1);
  check('the reported request count matches the requests actually made', reported === requests, `reported=${reported} actual=${requests}`);
}

// ── 6a. paper_status SKIPs a source with no credential ───────────────────────
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: {} }));
  const r = await tools.get('paper_status').execute({ probe: true, sources: 'core' });
  h.restore();
  check('a missing credential is SKIP, not FAILED', /SKIP\s+CORE/.test(r), r.split('\n').find((l) => /CORE/.test(l) && /SKIP|FAILED/.test(l)));
  check('no FAILED line for CORE', !/FAILED\s+CORE/.test(r));
}

// ── 6b. paper_status honours a group keyword ─────────────────────────────────
{
  const tools = loadTools();
  const r = await tools.get('paper_status').execute({ sources: 'indonesia' });
  const listed = r.split('\n').filter((l) => /^  \?/.test(l)).length;
  check('sources:"indonesia" lists only the Indonesian sources', listed === 2, `listed=${listed}`);
  check('the count matches the list', /note: 2 of 23 sources checked above/.test(r));
}

// ── 6c. clear_cache says it did nothing when the cache is disabled ───────────
{
  const tools = loadTools();   // loadTools forces cache:false
  const r = await tools.get('paper_status').execute({ clear_cache: true, sources: 'crossref' });
  check('clear_cache with no cache SAYS so', /NOT CLEARED/.test(r), r.split('\n')[0]);
}

done('D46 paper_detail and paper_status reporting');
