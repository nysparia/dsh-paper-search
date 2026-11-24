// test/d21-credential-rotation.mjs — D21: a rotated key must reach the NEXT tool
// call without re-instantiating the plugin.
//
// The seam's contract is "resolve a reference once per operation, so a changed
// credential reaches the next operation without any plugin restart"
// (packages/credentials/credentials/src/index.ts:1-8). `resolve()` is async, so
// the plugin cannot call it from its synchronous getter — but it must not
// resolve once per PROCESS either, which would pin the first key forever.
//
// The fix takes a per-execution snapshot: at the start of each tool's
// `execute`, the six known references are resolved, and the existing sync getter
// reads that snapshot. This file proves the snapshot is per-execution by
// rotating the value between two calls on the SAME plugin instance.
//
// Run: node test/d21-credential-rotation.mjs

import { check, installFetch, loadTools } from './harness.mjs';

const emptyRoutes = (url) => {
  if (url.includes('api.openalex.org')) return { body: { results: [], meta: { count: 0 } } };
  return { body: {} };
};

// A seam whose stored value the test can change between calls — exactly what a
// user does by saving a new key in the configuration UI.
const store = { OPENALEX_API_KEY: 'OA-FIRST-KEY' };
const credentials = {
  resolve: async (ref) => (store[ref] === undefined ? undefined : { value: store[ref], source: 'file' }),
  describe: async (ref) => (store[ref] === undefined
    ? { configured: false, writable: true }
    : { configured: true, source: 'file', writable: true, masked: '••••••••' }),
};

// ONE plugin instance for both calls. Re-instantiating would hide the defect:
// a per-process cache would still pick up the new key on a fresh `apply()`.
const tools = loadTools({ cache: false }, { credentials });
const search = tools.get('paper_search');

const first = installFetch(emptyRoutes);
await search.execute({ query: 'literature', sources: 'openalex' });
first.restore();
const firstUrls = first.calls.map((c) => c.url).join('\n');
check('the first call sends the first key', firstUrls.includes('api_key=OA-FIRST-KEY'),
  firstUrls.split('\n')[0] ?? 'no request');

// Rotate the stored key, as the configuration UI would.
store.OPENALEX_API_KEY = 'OA-SECOND-KEY';

const second = installFetch(emptyRoutes);
await search.execute({ query: 'literature', sources: 'openalex' });
second.restore();
const secondUrls = second.calls.map((c) => c.url).join('\n');
check('the next call on the SAME instance sends the rotated key',
  secondUrls.includes('api_key=OA-SECOND-KEY'), secondUrls.split('\n')[0] ?? 'no request');
check('the next call does not still send the old key',
  !secondUrls.includes('OA-FIRST-KEY'), secondUrls.split('\n')[0] ?? 'no request');

// ── The same rule for a DIFFERENT tool, not just paper_search ──────────────
// Each tool's `execute` is its own operation, so a rotation must be visible
// across tools too — a snapshot taken once in `apply()` would fail here.
{
  store.OPENALEX_API_KEY = 'OA-THIRD-KEY';
  const mock = installFetch((url) => {
    if (url.includes('api.openalex.org')) {
      return { body: { id: 'https://openalex.org/W1', title: 'A paper', cited_by_count: 0 } };
    }
    return { body: {} };
  });
  let threw = null;
  try {
    await tools.get('paper_detail').execute({ identifier: '10.1038/nature14539' });
  } catch (e) {
    threw = e;
  } finally {
    mock.restore();
  }
  const urls = mock.calls.map((c) => c.url).join('\n');
  check('paper_detail sends the rotated key', urls.includes('api_key=OA-THIRD-KEY'),
    threw ? `threw: ${threw.message}` : (urls.split('\n')[0] ?? 'no request'));
}

// ── And a key REMOVED from the seam stops being sent ───────────────────────
// The other direction of the same rule: unsetting a key must take effect too,
// otherwise the snapshot is really a process-wide cache.
{
  delete store.OPENALEX_API_KEY;
  const mock = installFetch(emptyRoutes);
  await search.execute({ query: 'literature', sources: 'openalex' });
  mock.restore();
  const urls = mock.calls.map((c) => c.url).join('\n');
  check('a key removed from the seam is no longer sent', !urls.includes('api_key='),
    urls.split('\n')[0] ?? 'no request');
}

console.log(process.exitCode ? '\nFAILED' : '\nOK');
