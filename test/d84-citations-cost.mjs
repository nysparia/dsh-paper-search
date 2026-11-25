// d84 — `paper_citations` must state what it cost.
//
// THE DEFECT. `paper_detail` prints "N OpenAlex requests" and `paper_search`
// prints a per-source line with a timing, but `paper_citations` printed no
// number at all — though it makes the same kind of calls: one to resolve the
// identifier, then one for the citing page (or one per 50 references).
//
// Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580): a citing query made 2 HTTP
// requests and a references query made 2, and neither reply mentioned a number.
// The tool's own description says "FREE and keyless", which is true and also
// unhelpful: a caller budgeting against "free" needs to know how many calls
// "free" costs.
//
// The count is DERIVED, not guessed: `worksCited` fetches at most
// `REFERENCE_LIMIT` references in chunks of 50, so the number of list requests
// is `ceil(min(total, REFERENCE_LIMIT) / 50)`.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

const SEED = {
  id: 'https://openalex.org/W1', title: 'Seed', publication_year: 2020,
  cited_by_count: 3, referenced_works: ['https://openalex.org/W9'],
};

/** Serve the seed and an empty list; count the requests actually made. */
function serve() {
  let requests = 0;
  const h = installFetch((url) => {
    requests += 1;
    if (url.includes('filter=cites')) return { body: { results: [], meta: { count: 0 } } };
    if (url.includes('openalex_id')) return { body: { results: [] } };
    return { body: SEED };
  });
  return { get requests() { return requests; }, restore: h.restore };
}

/** The number the reply claims. */
function claimed(reply) {
  const m = /OpenAlex requests: (\d+)/.exec(reply);
  return m ? Number(m[1]) : -1;
}

// ── 1. The citing direction ─────────────────────────────────────────────────
{
  const tools = loadTools();
  const f = serve();
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', direction: 'citing' });
  const made = f.requests;
  f.restore();
  check('the citing reply states a request count', claimed(r) > 0, r.split('\n').find((l) => /requests/.test(l)) ?? 'SILENT');
  check('the stated count matches the requests actually made', claimed(r) === made, `claimed=${claimed(r)} made=${made}`);
}

// ── 2. The references direction ─────────────────────────────────────────────
{
  const tools = loadTools();
  const f = serve();
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', direction: 'references' });
  const made = f.requests;
  f.restore();
  check('the references reply states a request count', claimed(r) > 0, r.split('\n').find((l) => /requests/.test(l)) ?? 'SILENT');
  check('the stated count matches the requests actually made', claimed(r) === made, `claimed=${claimed(r)} made=${made}`);
}

// ── 3. The count is stated even when the answer is EMPTY ────────────────────
//
// Both branches return early on `total === 0`, and a cost fence that disappears
// exactly when the answer is empty is the one a caller cannot budget against.
{
  const tools = loadTools();
  const f = serve();
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', direction: 'citing' });
  f.restore();
  check('an empty citing answer still states the cost', /OpenAlex requests: \d+/.test(r),
    r.split('\n').find((l) => /requests/.test(l)) ?? 'SILENT');
}

// ── 4. "1 reference", not "1 references" ────────────────────────────────────
{
  const tools = loadTools();
  const f = serve();
  const r = await tools.get('paper_citations').execute({ identifier: 'W1', direction: 'references' });
  f.restore();
  check('a single reference is singular', /records 1 reference in OpenAlex/.test(r),
    r.split('\n').find((l) => /records/.test(l)) ?? 'SILENT');
}

done('D84 paper_citations states its cost');
