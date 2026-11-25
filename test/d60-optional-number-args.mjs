// d60 — an OPTIONAL numeric argument that was not sent must not become a value.
//
// THE DEFECT. Every numeric parameter in `lib/index.js` parsed itself, and each
// one got a different subset of three cases right. Measured 24 Nov 2026 on 0.7.0
// (HEAD ba4b580), with a mocked Crossref that records the `rows` it was asked
// for:
//
//   max_results: undefined -> rows 5   (the default — correct)
//   max_results: null      -> rows 1   <- ONE result per source instead of five
//   max_results: ""        -> rows 1
//   max_results: "abc"     -> rows 5   <- the default, with NO note at all
//
// `Number(null)` is 0 and `Number('')` is 0 — both finite — so the guard
// `Number.isFinite(Number(x))` read "absent" as "zero" and then clamped zero up
// to the minimum. And `Number('abc')` is NaN, which the same guard treated as
// "absent" silently, while an invalid `min_citations` and an invalid `year_from`
// were both reported.
//
// A model that fills an unset optional number with `null` is extremely common —
// it is what a JSON schema with a nullable field produces — so this was not a
// theoretical input. The reply then blamed the caller for a value they had not
// sent: "max_results was not a whole number in 1-50 — 1 was used".
//
// THE RULE, now implemented once in `numberArg`:
//   absent  (undefined / null / blank) -> the default, and NOTHING is printed
//   invalid (not a finite number)      -> the default, and the caller is TOLD
//   ok      (a finite number)          -> used, clamped into range if needed
//
// The same rule applies to `abstract_chars`, where `0` is a MEANINGFUL value
// ("no limit") and therefore cannot be the fallback: `null` used to mean "no
// limit" and dumped the whole abstract instead of the documented 1200.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** A Crossref that answers with no items and records the `rows` it was asked for. */
function crossref() {
  const rows = [];
  const h = installFetch((url) => {
    const u = new URL(url);
    if (u.host === 'api.crossref.org') {
      rows.push(u.searchParams.get('rows'));
      return { body: { message: { items: [] } } };
    }
    return { body: {} };
  });
  return { rows, restore: h.restore };
}

// ── 1. `null` and `""` mean ABSENT, so the default applies ───────────────────
{
  for (const [label, value] of [['undefined', undefined], ['null', null], ['""', '']]) {
    const tools = loadTools();
    const f = crossref();
    const r = await tools.get('paper_search').execute({
      query: 'x', sources: 'crossref', ...(value === undefined ? {} : { max_results: value }),
    });
    f.restore();
    check(`max_results: ${label} sends the DEFAULT 5 rows, not 1`, f.rows[0] === '5', `rows=${f.rows[0]}`);
    check(`max_results: ${label} prints no note (nothing was rejected)`,
      !/max_results/.test(r), r.split('\n').find((l) => /max_results/.test(l)) ?? 'clean');
  }
}

// ── 2. A value that is not a number is REPORTED, not silently defaulted ──────
{
  const tools = loadTools();
  const f = crossref();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', max_results: 'abc' });
  f.restore();
  check('max_results: "abc" falls back to 5', f.rows[0] === '5', `rows=${f.rows[0]}`);
  check('max_results: "abc" is REPORTED as not a number',
    /max_results "abc" is not a number/.test(r),
    r.split('\n').find((l) => /max_results/.test(l)) ?? 'SILENT');
}

// ── 3. A real number out of range is clamped AND reported ────────────────────
{
  const tools = loadTools();
  const f = crossref();
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref', max_results: 500 });
  f.restore();
  check('max_results: 500 is clamped to 50', f.rows[0] === '50', `rows=${f.rows[0]}`);
  check('the clamp names the value actually used', /max_results was 500 — 50 was used/.test(r),
    r.split('\n').find((l) => /max_results/.test(l)) ?? 'SILENT');
}

// ── 4. The early-return path keeps the note ─────────────────────────────────
//
// `unpaywall` is skipped for a keyword query, so `ids` is empty and the early
// return is taken. The numeric parsing used to happen AFTER that return, so the
// note was lost — the same defect the filter block already fixed for `sort`.
{
  const tools = loadTools();
  const h = installFetch(() => ({ body: {} }));
  const r = await tools.get('paper_search').execute({
    query: 'digital literacy', sources: 'unpaywall', max_results: 'abc',
  });
  h.restore();
  check('early return: the max_results note survives', /max_results "abc" is not a number/.test(r),
    r.split('\n').filter((l) => /max_results/.test(l)).join(' | ') || 'SILENT');
}

// ── 5. `abstract_chars`: 0 means "no limit", absent means 1200 ──────────────
//
// The abstract is built from a real `abstract_inverted_index`, because that is
// the only shape `detailOfWork` reads.
{
  const idx = {};
  for (let i = 0; i < 300; i++) idx['ABCDEFGHIJ'] = [...(idx['ABCDEFGHIJ'] ?? []), i];
  const work = {
    id: 'https://openalex.org/W1', title: 'T', publication_year: 2020, cited_by_count: 1,
    abstract_inverted_index: idx,
  };
  const serve = () => installFetch((url) => (url.includes('is_retracted%3Atrue')
    ? { body: { results: [] } }
    : { body: { results: [work] } }));

  /** The length of the abstract line in the reply. */
  const abstractLength = (reply) => {
    const line = reply.split('\n').find((l) => l.trim().startsWith('abstract:'));
    return line ? line.trim().slice('abstract:'.length).trim().length : -1;
  };

  for (const [label, value, expected] of [
    ['undefined', undefined, 1200],
    ['null', null, 1200],
    ['""', '', 1200],
    ['-5', -5, 1200],
    ['0 (documented "no limit")', 0, 3299],
    ['100', 100, 100],
  ]) {
    const tools = loadTools();
    const f = serve();
    const r = await tools.get('paper_detail').execute({
      identifier: 'W1', ...(value === undefined ? {} : { abstract_chars: value }),
    });
    f.restore();
    check(`abstract_chars: ${label} -> ${expected} characters`, abstractLength(r) === expected,
      `got ${abstractLength(r)}`);
  }

  // A negative value is a mistake, not a request for "no limit", and it is said.
  const tools = loadTools();
  const f = serve();
  const r = await tools.get('paper_detail').execute({ identifier: 'W1', abstract_chars: -5 });
  f.restore();
  check('abstract_chars: -5 is REPORTED rather than silently meaning "no limit"',
    /abstract_chars "-5" is not a valid length/.test(r),
    r.split('\n').find((l) => /abstract_chars/.test(l)) ?? 'SILENT');
}

done('D60 optional numeric arguments');
