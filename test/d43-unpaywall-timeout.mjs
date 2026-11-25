// test/d43-unpaywall-timeout.mjs — D43 (audit L29): the Unpaywall lookup inside
// `prepareFullText` had no timeout.
//
// THE DEFECT. Every other network call in this package is bounded — `downloadPdf`
// at 120 s, `getText` in `lib/sources.js` at 25 s — but the Unpaywall lookup was
// a bare call:
//
//   const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
//
// No `AbortController`, no `signal`, no timer. Measured 24 Nov 2026 with a stub
// that never settles: `prepareFullText` was still running after 3 s with no way
// to bound it. `paper_fulltext` is a TOOL CALL, so an unbounded wait is a hung
// tool — and there is no user watching it who could cancel.
//
// WHAT THIS TEST PINS:
//   1. the call carries an abort signal at all (the structural fix);
//   2. a stub that never settles is ABANDONED at the bound, and the failure is
//      reported as a timeout rather than as an opaque `AbortError`;
//   3. the bound is a real bound — the call returns, it does not hang;
//   4. the other candidates are still tried after the timeout, so a slow
//      Unpaywall does not cost the whole lookup.
//
// The bound is passed in through `lookupTimeoutMs` (the same injection pattern
// `findArxiv` already uses) so the test does not wait the real 25 s.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { prepareFullText } from '../lib/fulltext.js';
import { reporter, fakePdf } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d43-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'md'), { recursive: true });

/**
 * Run `fn`, but give up after `ms` and report the hang as a FAILURE.
 *
 * This is not decoration. On the UNMODIFIED code the hanging stub never settles
 * and `prepareFullText` never returns, so a plain `await` would hang the whole
 * test file — and `test/run.mjs` spawns each file synchronously, so one hung
 * file would stall the entire suite instead of failing it. The deadline turns
 * the defect into the assertion failure it is.
 */
async function withDeadline(fn, ms, label) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ hung: true }), ms);
  });
  try {
    const raced = await Promise.race([fn().then((value) => ({ value })), deadline]);
    if (raced.hung) {
      check(`${label}: the call RETURNED instead of hanging`, false, `still running after ${ms} ms`);
      return { problem: null, used: null, hung: true };
    }
    return raced.value;
  } finally {
    clearTimeout(timer);
  }
}

const DOI = '10.1038/nature14539';
const EMAIL = 'someone@example.org';

/**
 * A work with NO OA locations, so the ONLY candidate is the Unpaywall lookup —
 * which is exactly the path under test. A location would let the loop succeed
 * before ever reaching Unpaywall.
 */
const work = { doi: DOI, title: 'A paper with no listed OA location', publication_year: 2015 };

/** Replace fetch with a router that records the init and can hang on demand. */
function installHangingFetch({ hangUnpaywall = true, servePdfAfter = false } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push({ url, init });
    if (url.includes('api.unpaywall.org')) {
      if (hangUnpaywall) {
        // Never settles — the stub from the audit. It must be ABANDONED by the
        // abort signal, not awaited.
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ best_oa_location: { url_for_pdf: 'https://example.org/paper.pdf' } }),
        text: async () => '{}',
      };
    }
    if (url.includes('example.org/paper.pdf') && servePdfAfter) {
      const body = fakePdf();
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => Buffer.from(body),
        text: async () => body,
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not mocked', json: async () => ({}) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ── 1. The structural fix: the request carries an abort signal ─────────────
{
  const mock = installHangingFetch({ hangUnpaywall: false });
  const h = await prepareFullText({
    work, identifier: DOI, email: EMAIL, converter: { name: 'x', path: '/bin/true', from: 'test' },
    root, findArxiv: async () => null, lookupTimeoutMs: 2000,
  });
  mock.restore();
  const unpaywallCall = mock.calls.find((c) => c.url.includes('api.unpaywall.org'));
  check('the Unpaywall request was actually made', Boolean(unpaywallCall),
    mock.calls.map((c) => c.url).join(' | ') || 'no calls');
  check('the Unpaywall request carries an AbortSignal',
    Boolean(unpaywallCall?.init?.signal),
    JSON.stringify(Object.keys(unpaywallCall?.init ?? {})));
  check('the signal is a real AbortSignal, not a placeholder',
    unpaywallCall?.init?.signal instanceof AbortSignal,
    String(unpaywallCall?.init?.signal));
  // The lookup succeeded here, so the failure is downstream (no converter) —
  // what matters is that the lookup itself did not fail.
  check('a responsive Unpaywall is not reported as a timeout',
    !/timeout/i.test(h.problem ?? ''),
    h.problem ?? '(none)');
}

// ── 2. THE DEFECT: a stub that never settles must be abandoned ─────────────
{
  const mock = installHangingFetch({ hangUnpaywall: true });
  const started = Date.now();
  const h = await withDeadline(() => prepareFullText({
    work, identifier: DOI, email: EMAIL, converter: { name: 'x', path: '/bin/true', from: 'test' },
    root, findArxiv: async () => null, lookupTimeoutMs: 300,
  }), 4000, 'a hanging Unpaywall');
  const elapsed = Date.now() - started;
  mock.restore();

  check('it returned close to the bound, not after the stub',
    elapsed < 5000,
    `${elapsed} ms with a 300 ms bound`);
  check('the failure is reported', typeof h.problem === 'string', String(h.problem));
  check('the failure names the TIMEOUT, not an opaque AbortError',
    /timeout/i.test(h.problem ?? ''),
    h.problem ?? '(none)');
  check('the failure states the bound in seconds',
    /timeout > \d+ s/.test(h.problem ?? ''),
    h.problem ?? '(none)');
  check('the failure does not leak the raw "aborted" wording',
    !/aborted/i.test(h.problem ?? ''),
    h.problem ?? '(none)');
}

// ── 3. A timed-out Unpaywall does not cost the other candidates ────────────
//
// The loop must move on. Here the work HAS an OA location, so after Unpaywall
// times out the location must still be tried and the PDF still downloaded.
{
  const workWithLocation = {
    doi: DOI,
    title: 'A paper with an OA location',
    publication_year: 2015,
    open_access: { is_oa: true, oa_status: 'green' },
    locations: [{ is_oa: true, pdf_url: 'https://example.org/paper.pdf', source: { display_name: 'Test' } }],
  };
  const mock = installHangingFetch({ hangUnpaywall: true, servePdfAfter: true });
  const started = Date.now();
  const h = await withDeadline(() => prepareFullText({
    work: workWithLocation, identifier: DOI, email: EMAIL,
    converter: { name: 'x', path: '/bin/true', from: 'test' },
    root, findArxiv: async () => null, lookupTimeoutMs: 300,
  }), 4000, 'a hanging Unpaywall with another candidate');
  const elapsed = Date.now() - started;
  mock.restore();

  check('the other candidates are still tried after the timeout',
    h.used?.from === 'openalex',
    `used=${JSON.stringify(h.used)} problem=${h.problem ?? '(none)'}`);
  check('the PDF really was downloaded', h.used?.bytes > 0, String(h.used?.bytes));
  check('the whole call stayed bounded', elapsed < 5000, `${elapsed} ms`);
}

// ── 4. No email means no Unpaywall call at all (unchanged behaviour) ───────
{
  const mock = installHangingFetch({ hangUnpaywall: true });
  const h = await prepareFullText({
    work, identifier: DOI, email: null, converter: { name: 'x', path: '/bin/true', from: 'test' },
    root, findArxiv: async () => null, lookupTimeoutMs: 300,
  });
  mock.restore();
  check('without an email, Unpaywall is never called',
    !mock.calls.some((c) => c.url.includes('api.unpaywall.org')),
    mock.calls.map((c) => c.url).join(' | ') || 'no calls');
  check('without an email the problem is "no open-access copy"',
    /no open-access copy/i.test(h.problem ?? ''),
    h.problem ?? '(none)');
}

rmSync(root, { recursive: true, force: true });
done('D43 Unpaywall lookup had no timeout');
