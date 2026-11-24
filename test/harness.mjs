// test/harness.mjs — shared helpers for the regression tests.
//
// There is no test framework here on purpose: every test is a plain `.mjs` file
// run with `node test/<name>.mjs`, prints one PASS/FAIL line per assertion, and
// exits non-zero when anything failed. That keeps the suite runnable on a bare
// Node install, which is the same constraint the plugin itself follows.

/** Collect assertions; `done()` prints the verdict and sets the exit code. */
export function reporter() {
  let failed = 0;
  let passed = 0;
  const check = (name, ok, detail = '') => {
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
  return { check, done };
}

/**
 * Load the plugin through its real entry point and return the registered tools.
 *
 * `apply()` is the only exported door into the tool definitions, so the tests go
 * through it instead of reaching for internals — that way a test cannot pass on
 * a code path the plugin never actually registers.
 */
export async function loadTools(config = { cache: false }) {
  const mod = await import('../lib/index.js');
  const tools = new Map();
  const ctx = {
    tools: { register: (t) => tools.set(t.name, t) },
    effect: (fn) => { fn(); return () => {}; },
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  mod.apply(ctx, config);
  return tools;
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
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      arrayBuffer: async () => Buffer.from(body),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** A reply body that is a real (if tiny) PDF — passes the `%PDF-` + size check. */
export function fakePdf() {
  return `%PDF-1.4\n${'% filler\n'.repeat(200)}`;
}
