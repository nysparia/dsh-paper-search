// test/d23-network-error-cause.mjs — a network failure must name its cause.
//
// THE DEFECT. `searchSource()` builds its error message from `e.message` only.
// For a `fetch` failure that message is the constant string "fetch failed" and
// the actual reason lives in `e.cause` — so every distinct network problem
// (connection reset, DNS failure, TLS error, refused connection) was reported
// identically, and the reader had no way to tell a dead host from a blocked one.
//
// Measured 24 Nov 2026 against the live Garuda portal:
//
//   fetch(...) -> TypeError: fetch failed
//                 cause: ECONNRESET
//   paper_search reported: "Garuda  html  fetch failed"
//
// The cause is what makes the line actionable: ECONNRESET means the server
// dropped the connection (retry later), ENOTFOUND means the name does not
// resolve (the source is gone), CERT_HAS_EXPIRED means the certificate is stale.
//
// The fix must NOT change the shape of a successful result, and must not lose
// the HTTP status or body it already reported.

import { check } from './harness.mjs';
import { searchSource } from '../lib/sources.js';

const realFetch = globalThis.fetch;

/** Make every request fail with a given `cause` code. */
function failWith(code, message = 'fetch failed') {
  globalThis.fetch = async () => {
    const e = new TypeError(message);
    e.cause = { code, message: `simulated ${code}` };
    throw e;
  };
}

// ── 1. The defect: the cause code reaches the report ────────────────────────
{
  failWith('ECONNRESET');
  const h = await searchSource('garuda', 'literasi', { rows: 2 });
  check('a reset connection is reported as an error', h.error !== null, h.error ?? 'null');
  check('the error names ECONNRESET', /ECONNRESET/.test(h.error ?? ''), h.error ?? '');
  check('the error still says "fetch failed"', /fetch failed/i.test(h.error ?? ''), h.error ?? '');
}

// ── 2. Different causes must be distinguishable ────────────────────────────
{
  failWith('ENOTFOUND');
  const a = await searchSource('garuda', 'x', { rows: 1 });
  failWith('ECONNREFUSED');
  const b = await searchSource('garuda', 'x', { rows: 1 });
  check('ENOTFOUND is reported', /ENOTFOUND/.test(a.error ?? ''), a.error ?? '');
  check('ECONNREFUSED is reported', /ECONNREFUSED/.test(b.error ?? ''), b.error ?? '');
  check('the two are not the same string', a.error !== b.error, `${a.error} vs ${b.error}`);
}

// ── 3. A TLS failure names its code too ────────────────────────────────────
{
  failWith('CERT_HAS_EXPIRED');
  const h = await searchSource('garuda', 'x', { rows: 1 });
  check('a certificate failure names CERT_HAS_EXPIRED', /CERT_HAS_EXPIRED/.test(h.error ?? ''), h.error ?? '');
}

// ── 4. No regression: an HTTP error keeps its status and body ──────────────
{
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => '{"error":"rate limited"}',
  });
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('an HTTP error reports the status', /HTTP 429/.test(h.error ?? ''), h.error ?? '');
  check('an HTTP error keeps the body snippet', /rate limited/.test(h.error ?? ''), h.error ?? '');
}

// ── 5. No regression: a timeout is still just "timeout" ────────────────────
{
  globalThis.fetch = async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a timeout is reported as timeout', h.error === 'timeout', h.error ?? 'null');
}

// ── 6. No regression: a successful call is unchanged ───────────────────────
{
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: { items: [] } }),
  });
  const h = await searchSource('crossref', 'x', { rows: 1 });
  check('a successful call reports no error', h.error === null, h.error ?? 'null');
  check('a successful call returns an array', Array.isArray(h.papers), typeof h.papers);
}

globalThis.fetch = realFetch;
console.log('\nD23 network error cause: ' + (process.exitCode ? 'FAILED' : 'all assertions passed'));
