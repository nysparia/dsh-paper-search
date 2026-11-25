// test/harness.mjs — shared helpers for the regression tests.
//
// There is no test framework here on purpose: every test is a plain `.mjs` file
// run with `node test/<name>.mjs`, prints one PASS/FAIL line per assertion, and
// exits non-zero when anything failed. That keeps the suite runnable on a bare
// Node install, which is the same constraint the plugin itself follows.
//
// This file is the MERGE of three harnesses written independently by three
// defect branches. Both APIs are kept because both are in use:
//
//   check(label, ok, detail)      a single boolean assertion (sets the exit code)
//   reporter() -> {check, done}   counted assertions with a summary line
//   loadTools(config)             the registered tools, by name — SYNC
//   loadTools(config, options)    …with `options.credentials` as the seam
//   fakeCredentials(values)       a stand-in for ctx.get('credentials')
//   mockFetch(routes)             simple router, records url + headers
//   installFetch(handler)         richer router, records url + init
//   outcome(fn)                   did it throw, and with what message
//   fakePdf()                     a body that passes the %PDF- + size check
//
// `loadTools` is deliberately SYNCHRONOUS: `apply()` is synchronous, and
// `await` on a non-promise is a no-op, so callers that write `await loadTools()`
// keep working unchanged. Making it async would have forced a rewrite of every
// call site for no benefit.

import { apply } from '../lib/index.js';

/** Print one assertion. Sets the process exit code on failure. */
export function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

/** Collect assertions; `done()` prints the verdict and sets the exit code. */
export function reporter() {
  let failed = 0;
  let passed = 0;
  const checkOne = (name, ok, detail = '') => {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const done = (label) => {
    console.log();
    console.log(failed === 0
      ? `RESULT: ${passed} assertion(s) passed (${label})`
      : `RESULT: ${failed} of ${passed + failed} assertion(s) FAILED (${label})`);
    process.exit(failed === 0 ? 0 : 1);
  };
  return { check: checkOne, done };
}

/**
 * Register the plugin against a fake ctx and return the tools by name.
 *
 * `apply()` is the only exported door into the tool definitions, so the tests go
 * through it instead of reaching for internals — that way a test cannot pass on
 * a code path the plugin never actually registers, and a change that breaks
 * registration fails these tests rather than passing them.
 *
 * `cache: false` is forced (and can be overridden by `config`) so no cache file
 * is written: these tests must not touch the user's library folder.
 *
 * `options.credentials` is the DSH credential seam (`ctx.get('credentials')`).
 * It is a SEPARATE argument, not a config field, because the plugin config is
 * spread straight into `apply()` and a `credentials` key there would be read as
 * plugin configuration. Omitting it reproduces a bare harness, which is the
 * case the plugin must keep loading in.
 */
export function loadTools(config = {}, options = {}) {
  const tools = new Map();
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
    // No `skills` service: registerSkill then only records a note, which is the
    // documented behaviour for a bare harness.
    get: (name) => (name === 'credentials' ? options.credentials : undefined),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  apply(ctx, { cache: false, ...config });
  return tools;
}

/**
 * A stand-in for `ctx.get('credentials')` — the two methods this plugin uses.
 *
 * `values` is read on EVERY `resolve()`, so a test can rotate a key between two
 * tool calls and observe the per-operation rule. `source` is what the real
 * `credentials-local` reports for a stored value (`credentials-local/src/index.ts:638`).
 */
export function fakeCredentials(values, source = 'file') {
  return {
    resolve: async (ref) => (values[ref] === undefined || values[ref] === null
      ? undefined
      : { value: String(values[ref]), source }),
    describe: async (ref) => (values[ref] === undefined || values[ref] === null
      ? { configured: false, writable: true }
      : { configured: true, source, writable: true, masked: '••••••••' }),
  };
}

/** Build one fetch Response-shaped object from a body string. */
function responseOf(body, status = 200, headerMap = {}) {
  const headers = new Map(Object.entries(headerMap).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    // A real `fetch` reply carries a readable stream, and `downloadPdf` streams
    // it so the size cap can abort a transfer in progress. A stub without one
    // would leave that path untested by every test in this suite, so the stub
    // provides one — a FRESH stream per access, because a stream can only be
    // read once and some callers still use `text()`/`arrayBuffer()`.
    get body() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => Buffer.from(body),
  };
}

/**
 * Replace `globalThis.fetch` for the duration of one test.
 *
 * `routes(url, opts)` returns the response BODY as a string; every request is
 * recorded with its URL and headers so a test can assert on what was actually
 * sent — which is the whole point of the credential-leak test.
 */
export function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers ?? {} });
    const body = routes(u, opts) ?? '{}';
    return responseOf(body);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

/**
 * Replace `globalThis.fetch` with a router. `handler(url, init)` returns
 * `{ status, body, headers }`; `body` may be a string or a JSON-able value.
 * Every call is recorded so a test can assert on what was actually requested.
 */
export function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push({ url, init });
    const reply = (await handler(url, init)) ?? {};
    const status = reply.status ?? 200;
    const body = reply.body ?? '';
    return responseOf(typeof body === 'string' ? body : JSON.stringify(body), status, reply.headers ?? {});
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Run `fn` and report whether it threw, plus the message. */
export async function outcome(fn) {
  try {
    const value = await fn();
    return { threw: false, value };
  } catch (e) {
    return { threw: true, message: String(e?.message ?? e) };
  }
}

/**
 * A reply body that is a real (if tiny) PDF — passes the `%PDF-` + size check.
 *
 * The `%%EOF` trailer is not decoration: `checkPdf` requires it, because
 * `"%PDF-" + 2000 NUL bytes` used to be called a valid PDF when the magic
 * prefix was the only test. A fixture without the trailer would be testing a
 * body the plugin now (correctly) refuses.
 */
export function fakePdf() {
  return `%PDF-1.4\n${'% filler\n'.repeat(200)}%%EOF\n`;
}
