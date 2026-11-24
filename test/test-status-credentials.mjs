// test/test-status-credentials.mjs — D1: `paper_status` must not send the
// Semantic Scholar key to OpenAlex, and must send it to Semantic Scholar.
//
// Baseline 864a6e8 built the probe options as
//   { rows: 1, email, apiKey: credentials('SEMANTIC_SCHOLAR_API_KEY').value, … }
// `openalex()` reads `apiKey` and puts it in the `api_key` query parameter, while
// `semantic()` reads `semanticApiKey`. So one object did both wrong things at
// once: the S2 secret went to api.openalex.org, and the S2 request carried no key.
//
// Run: node test/test-status-credentials.mjs

import { check, loadTools, mockFetch } from './harness.mjs';

const S2_KEY = 'S2-SECRET-KEY-123';
const OA_KEY = 'OA-KEY-456';

const tools = loadTools({ SEMANTIC_SCHOLAR_API_KEY: S2_KEY, OPENALEX_API_KEY: OA_KEY });
const status = tools.get('paper_status');
check('paper_status is registered', !!status);

const mock = mockFetch((url) => {
  if (url.includes('api.openalex.org')) return JSON.stringify({ results: [] });
  if (url.includes('api.semanticscholar.org')) return JSON.stringify({ data: [] });
  return '{}';
});

let reply = '';
try {
  reply = await status.execute({ probe: true, sources: 'openalex,semantic' });
} finally {
  mock.restore();
}

const openAlexCalls = mock.calls.filter((c) => c.url.includes('api.openalex.org'));
const semanticCalls = mock.calls.filter((c) => c.url.includes('api.semanticscholar.org'));

check('the probe really hit OpenAlex', openAlexCalls.length > 0, `${openAlexCalls.length} request(s)`);
check('the probe really hit Semantic Scholar', semanticCalls.length > 0, `${semanticCalls.length} request(s)`);

// ── The leak ────────────────────────────────────────────────────────────────
const leaks = openAlexCalls.filter((c) => c.url.includes(S2_KEY)
  || JSON.stringify(c.headers).includes(S2_KEY));
check('no OpenAlex request carries the Semantic Scholar key', leaks.length === 0,
  leaks.length ? leaks.map((c) => c.url).join(' | ') : 'clean');

// ── The key that was never used ─────────────────────────────────────────────
const s2WithKey = semanticCalls.filter((c) => String(c.headers['x-api-key'] ?? '') === S2_KEY);
check('the Semantic Scholar request carries x-api-key', s2WithKey.length === semanticCalls.length,
  `${s2WithKey.length} of ${semanticCalls.length} request(s)`);

// ── And the OpenAlex key is still the one OpenAlex gets ─────────────────────
const oaWithKey = openAlexCalls.filter((c) => c.url.includes(`api_key=${OA_KEY}`));
check('the OpenAlex request carries the OpenAlex key', oaWithKey.length === openAlexCalls.length,
  `${oaWithKey.length} of ${openAlexCalls.length} request(s)`);

// The reply itself must not echo a secret either.
check('the reply does not contain the S2 key', !reply.includes(S2_KEY));

console.log(process.exitCode ? '\nFAILED' : '\nOK');
