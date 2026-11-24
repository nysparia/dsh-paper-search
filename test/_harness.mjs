// Deep-equality adapter over `harness.mjs`.
//
// `harness.mjs` (shared with the other defect branches) exposes
// `check(label, ok, detail)` — a boolean assertion. The parsing tests in this
// directory compare whole values (arrays of author names, identifier objects),
// so they need a deep comparison with a readable diff. This wraps the shared
// `check` rather than re-implementing PASS/FAIL printing and the exit code, so
// there is exactly one place that decides whether a test failed.

import { check as checkBool } from './harness.mjs';

/** Assert `actual` deep-equals `expected`, printing both on failure. */
export function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return checkBool(label, a === e, a === e ? '' : `expected ${e}, got ${a}`);
}

/** Print a summary line. The exit code is already set by `check`. */
export function done(name) {
  console.log(`\n${name}: ${process.exitCode ? 'FAILED' : 'all assertions passed'}`);
}
