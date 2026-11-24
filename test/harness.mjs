// test/harness.mjs — shared helpers for the plain-.mjs regression tests.
//
// No test framework: each test file is run with `node test/<name>.mjs`, prints
// one PASS/FAIL line per assertion, and exits non-zero if any assertion failed.
//
// The tools are NOT exported from lib/index.js — only `apply` is. So the tests
// go through the REAL registration path with a fake ctx, which also means a
// change that breaks registration breaks these tests instead of passing them.

import { apply } from '../lib/index.js';

/** Print one assertion. Sets the process exit code on failure. */
export function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

/**
 * Register the plugin against a fake ctx and return the tools by name.
 *
 * `cache: false` is forced so no cache file is written: these tests must not
 * touch the user's library folder.
 */
export function loadTools(config = {}) {
  const tools = new Map();
  const ctx = {
    effect: (fn) => { fn(); },
    tools: { register: (t) => { tools.set(t.name, t); } },
    // No `skills` service: registerSkill then only records a note, which is the
    // documented behaviour for a bare harness.
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  apply(ctx, { cache: false, ...config });
  return tools;
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
    return { ok: true, status: 200, text: async () => body };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
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
