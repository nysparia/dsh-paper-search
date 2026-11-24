// test/d19-credential-key-shape.mjs — D19: a key that cannot go in an HTTP
// header must be rejected where the reference can be named.
//
// `packages/credentials/credentials/src/api-key.ts` defines the transport
// invariant: a key must be printable ASCII with no space (`/^[\x21-\x7E]+$/`),
// because `fetch` cannot build a header from anything else. A key with a
// newline currently surfaces as an opaque 401 or a `fetch` error, neither of
// which names the reference to fix.
//
// Two rules from the spec:
//   - surrounding whitespace is trimmed SILENTLY (a padded key has one reading)
//   - anything else is rejected with a message naming the reference and saying
//     what is wrong, and the message must NOT contain the key value
//
// Run: node test/d19-credential-key-shape.mjs

import { check, fakeCredentials, installFetch, loadTools, outcome } from './harness.mjs';

const emptyRoutes = (url) => {
  if (url.includes('api.openalex.org')) return { body: { results: [], meta: { count: 0 } } };
  return { body: {} };
};

/** Run one OpenAlex search with `key` in the seam; report the outcome + URLs. */
async function searchWith(key) {
  const mock = installFetch(emptyRoutes);
  let result;
  try {
    const tools = loadTools({ cache: false }, { credentials: fakeCredentials({ OPENALEX_API_KEY: key }) });
    result = await outcome(() => tools.get('paper_search').execute({ query: 'literature', sources: 'openalex' }));
  } finally {
    mock.restore();
  }
  return { ...result, urls: mock.calls.map((c) => c.url).join('\n') };
}

// ── A newline is rejected, and the message names the reference ──────────────
{
  const bad = 'OA-KEY-WITH\nNEWLINE';
  const r = await searchWith(bad);
  check('a key containing a newline is rejected', r.threw, r.threw ? r.message : 'the call succeeded');
  if (r.threw) {
    check('the rejection names the reference', r.message.includes('OPENALEX_API_KEY'), r.message);
    check('the rejection does not contain the key value', !r.message.includes('OA-KEY-WITH'), r.message);
    check('the rejection says what is wrong with it',
      /character|header|printable|space/i.test(r.message), r.message);
  }
  check('the rejected key never reaches the network', !r.urls.includes('OA-KEY-WITH'),
    r.urls.split('\n')[0] ?? 'no request');
}

// ── A space inside the key is rejected too ─────────────────────────────────
{
  const bad = 'OA KEY WITH SPACES';
  const r = await searchWith(bad);
  check('a key containing a space is rejected', r.threw, r.threw ? r.message : 'the call succeeded');
  if (r.threw) {
    check('the space rejection names the reference', r.message.includes('OPENALEX_API_KEY'), r.message);
    check('the space rejection does not contain the key value', !r.message.includes('OA KEY'), r.message);
  }
}

// ── Surrounding whitespace is trimmed SILENTLY, not rejected ───────────────
// A padded key has exactly one reading, so failing on it would be a refusal
// with no decision behind it.
{
  const r = await searchWith('  OA-PADDED-KEY  ');
  check('a padded key is accepted, not rejected', !r.threw, r.threw ? r.message : '');
  check('a padded key is trimmed before it is sent',
    r.urls.includes('api_key=OA-PADDED-KEY') && !r.urls.includes('api_key=++OA-PADDED-KEY'),
    r.urls.split('\n')[0] ?? 'no request');
}

// ── The same rule applies to a key from plugin config, not just the seam ───
// The invariant is about the transport, so it cannot depend on which layer
// supplied the value.
{
  const mock = installFetch(emptyRoutes);
  let r;
  try {
    const tools = loadTools({ cache: false, OPENALEX_API_KEY: 'CONFIG-KEY\nBROKEN' });
    r = await outcome(() => tools.get('paper_search').execute({ query: 'literature', sources: 'openalex' }));
  } finally {
    mock.restore();
  }
  check('a malformed key from plugin config is rejected too', r.threw, r.threw ? r.message : 'the call succeeded');
  if (r.threw) check('the config rejection names the reference', r.message.includes('OPENALEX_API_KEY'), r.message);
}

// ── `paper_status` reports a malformed key instead of failing ──────────────
// The doctor is the tool a user reaches for precisely when a key is not
// working, so it must survive one that is malformed — and it must not send it.
{
  const mock = installFetch((url) => (url.includes('api.openalex.org') ? { body: { results: [] } } : { body: {} }));
  let report = '';
  let threw = null;
  try {
    const tools = loadTools({ cache: false }, { credentials: fakeCredentials({ OPENALEX_API_KEY: 'BAD\nKEY' }) });
    report = await tools.get('paper_status').execute({ probe: true, sources: 'openalex' });
  } catch (e) {
    threw = e;
  } finally {
    mock.restore();
  }
  check('paper_status does not throw on a malformed key', threw === null, threw ? String(threw.message) : '');
  check('paper_status marks the malformed key REJECTED', /REJECTED/.test(report),
    report.split('\n').filter((l) => /OPENALEX_API_KEY|REJECTED/.test(l)).join(' | '));
  check('paper_status does not print the malformed value', !report.includes('BAD'));
  check('the probe does not send the malformed key', !mock.calls.some((c) => c.url.includes('BAD')),
    mock.calls.map((c) => c.url).join(' | ') || 'no request');
}

console.log(process.exitCode ? '\nFAILED' : '\nOK');
