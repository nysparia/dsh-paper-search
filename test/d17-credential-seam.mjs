// test/d17-credential-seam.mjs — D17: the plugin ignored the DSH credential
// seam, so a key stored through the DSH configuration UI never reached it.
//
// Measured 24 Nov 2026 on baseline dbd5583, with a key stored through
// `ctx.credentials`:
//
//   key stored via ctx.credentials -> api_key sent: (NONE — plugin did not see it)
//   paper_status says: OPENALEX_API_KEY               EMPTY
//
// The UI writes `~/.dsh/.credentials.yaml`; the plugin read only its own config,
// `process.env`, and the upstream CLI's `.env`. So the user was told the key was
// stored and it was not.
//
// This file covers the defect itself and the precedence rule:
//   1. a key that exists ONLY in the seam reaches the request
//   2. the seam wins over plugin config and over process.env
//
// Run: node test/d17-credential-seam.mjs

import { check, fakeCredentials, installFetch, loadTools } from './harness.mjs';

const OA_KEY = 'OA-SEAM-KEY-789';

/** Every source answers an empty but VALID reply; only the URL is under test. */
const emptyRoutes = (url) => {
  if (url.includes('api.openalex.org')) return { body: { results: [], meta: { count: 0 } } };
  return { body: {} };
};

// ── 1. The defect: a key stored only in the seam must reach the request ──────
{
  const mock = installFetch(emptyRoutes);
  const tools = loadTools({ cache: false }, { credentials: fakeCredentials({ OPENALEX_API_KEY: OA_KEY }) });
  await tools.get('paper_search').execute({ query: 'literature', sources: 'openalex' });
  mock.restore();

  const openAlex = mock.calls.filter((c) => c.url.includes('api.openalex.org'));
  check('the search really hit OpenAlex', openAlex.length > 0, `${openAlex.length} request(s)`);
  const withKey = openAlex.filter((c) => c.url.includes(`api_key=${OA_KEY}`));
  check('a key stored only in ctx.credentials reaches the OpenAlex request',
    withKey.length > 0 && withKey.length === openAlex.length,
    `${withKey.length} of ${openAlex.length} request(s) carried api_key`);
}

// ── 2a. The seam wins over plugin config ────────────────────────────────────
{
  const mock = installFetch(emptyRoutes);
  const tools = loadTools(
    { cache: false, OPENALEX_API_KEY: 'FROM-PLUGIN-CONFIG' },
    { credentials: fakeCredentials({ OPENALEX_API_KEY: OA_KEY }) },
  );
  await tools.get('paper_search').execute({ query: 'literature', sources: 'openalex' });
  mock.restore();

  const urls = mock.calls.map((c) => c.url).join('\n');
  check('the seam beats plugin config', urls.includes(`api_key=${OA_KEY}`) && !urls.includes('FROM-PLUGIN-CONFIG'),
    urls.includes('FROM-PLUGIN-CONFIG') ? 'the config value was sent instead' : 'seam value sent');
}

// ── 2b. The seam wins over process.env ──────────────────────────────────────
{
  const saved = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'FROM-PROCESS-ENV';
  let urls = '';
  try {
    const mock = installFetch(emptyRoutes);
    const tools = loadTools({ cache: false }, { credentials: fakeCredentials({ OPENALEX_API_KEY: OA_KEY }) });
    await tools.get('paper_search').execute({ query: 'literature', sources: 'openalex' });
    mock.restore();
    urls = mock.calls.map((c) => c.url).join('\n');
  } finally {
    if (saved === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = saved;
  }
  check('the seam beats process.env', urls.includes(`api_key=${OA_KEY}`) && !urls.includes('FROM-PROCESS-ENV'),
    urls.includes('FROM-PROCESS-ENV') ? 'the environment value was sent instead' : 'seam value sent');
}

// ── 2c. The seam wins for the OTHER credentials too, not just OpenAlex ──────
// The precedence rule is a property of the reader, so it must hold for every
// name the reader serves — a fix that special-cased OpenAlex would pass 2a/2b.
{
  const mock = installFetch((url) => {
    if (url.includes('api.semanticscholar.org')) return { body: { data: [] } };
    return { body: {} };
  });
  const tools = loadTools(
    { cache: false, SEMANTIC_SCHOLAR_API_KEY: 'S2-FROM-CONFIG' },
    { credentials: fakeCredentials({ SEMANTIC_SCHOLAR_API_KEY: 'S2-FROM-SEAM' }) },
  );
  await tools.get('paper_search').execute({ query: 'literature', sources: 'semantic' });
  mock.restore();

  // `installFetch` records the whole `init`, so the header is under `init.headers`.
  const keyOf = (c) => String(c.init?.headers?.['x-api-key'] ?? '');
  const sent = mock.calls.filter((c) => keyOf(c) === 'S2-FROM-SEAM');
  const wrong = mock.calls.filter((c) => keyOf(c) === 'S2-FROM-CONFIG');
  check('the seam beats plugin config for the Semantic Scholar key too',
    sent.length > 0 && wrong.length === 0,
    `${sent.length} request(s) with the seam key, ${wrong.length} with the config key`);
}

console.log(process.exitCode ? '\nFAILED' : '\nOK');
