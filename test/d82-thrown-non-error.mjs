// d82 — a connector that throws something that is not an Error must not lose it.
//
// THE DEFECT. `searchSource` built its failure message with
// `e?.message ?? 'failed'`. A thrown STRING has no `.message`, so the fallback
// won and the reason was gone. Measured 24 Nov 2026 on 0.7.0 (HEAD ba4b580) with
// a connector that threw a bare string:
//
//   FAILED Crossref           api     failed
//
// — a per-source line that says a source failed and refuses to say why. The
// same expression is used for every connector, so any library that throws a
// non-Error (a rejected promise with a string, a `throw 'timeout'`) produced the
// same empty answer.
//
// The rule: whatever was thrown is what gets reported. `String(e)` keeps a
// string, a number, and an object with no `message`; `null`/`undefined` still
// fall back to "failed", because there is genuinely nothing to print.

import { loadTools, installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

/** Run one search against a Crossref that throws `thrown`. */
async function failedLine(thrown) {
  const tools = loadTools();
  const h = installFetch(() => { throw thrown; });
  const r = await tools.get('paper_search').execute({ query: 'x', sources: 'crossref' });
  h.restore();
  return r.split('\n').find((l) => /^  FAILED/.test(l)) ?? '';
}

{
  const line = await failedLine('a string, not an Error');
  check('a thrown string is reported verbatim', /a string, not an Error/.test(line), line);
  check('the reply does not reduce it to the bare word "failed"', !/api\s+failed\s*$/.test(line), line);
}

{
  const line = await failedLine(42);
  check('a thrown number is reported', /42/.test(line), line);
}

{
  const line = await failedLine({ code: 'ENOTFOUND' });
  check('a thrown object with no `message` is reported', /ENOTFOUND/.test(line), line);
}

{
  // An Error still reports its message, and still appends the HTTP status once.
  const err = new Error('HTTP 400');
  err.status = 400;
  const line = await failedLine(err);
  check('an Error still reports its message', /HTTP 400/.test(line), line);
  check('the HTTP status is not printed twice', (line.match(/HTTP 400/g) ?? []).length === 1, line);
}

done('D82 a thrown non-Error keeps its content');
