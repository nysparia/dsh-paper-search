// d48 — an HTTP failure states its status ONCE.
//
// `getText` builds "HTTP 400" as the error MESSAGE and also sets `err.status`.
// `searchSource` then appended " (HTTP ${e.status})" unconditionally, so every
// HTTP failure read "HTTP 400 (HTTP 400)". Measured 24 Nov 2026 against the live
// Crossref API with `max_results: 7.5`:
//
//   FAILED Crossref  api  HTTP 400 (HTTP 400) — {"status":"failed",…}
//
// The status must still be appended when the message does NOT carry it — a
// connector that throws a plain Error with a `status` field is the case that
// would otherwise lose it.

import { searchSource } from '../lib/sources.js';
import { installFetch, reporter } from './harness.mjs';

const { check, done } = reporter();

// ── 1. A real HTTP failure states the status once ────────────────────────────
{
  const h = installFetch(() => ({ status: 400, body: '{"error":"bad"}' }));
  const r = await searchSource('crossref', 'x', { rows: 1 });
  h.restore();
  check('the failure is reported', typeof r.error === 'string', String(r.error));
  check('the status appears ONCE', (r.error.match(/HTTP 400/g) ?? []).length === 1, r.error);
  check('the doubled form is gone', !/HTTP 400 \(HTTP 400\)/.test(r.error), r.error);
  check('the body is still carried', /bad/.test(r.error), r.error);
}

// ── 2. A status NOT in the message is still appended ─────────────────────────
{
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const e = new Error('something odd');
    e.status = 503;
    throw e;
  };
  const r = await searchSource('crossref', 'x', { rows: 1 });
  globalThis.fetch = original;
  check('a status absent from the message IS appended', /\(HTTP 503\)/.test(r.error), r.error);
  check('the original message survives', /something odd/.test(r.error), r.error);
}

// ── 3. A failure with no status is unchanged ─────────────────────────────────
{
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('plain failure'); };
  const r = await searchSource('crossref', 'x', { rows: 1 });
  globalThis.fetch = original;
  check('a failure with no status prints no status', r.error === 'plain failure', r.error);
}

done('D48 HTTP status stated once');
