// test/d18-credential-seam-absent.mjs — D18: with NO credential seam the plugin
// must still load and still read its own three paths.
//
// The seam is OPTIONAL in DSH: a bare harness has no provider, and
// `llm-pi-ai` declares `inject = ['llm']` while still using
// `ctx.get('credentials')` (packages/llm/llm-pi-ai/src/index.ts:221). Adding
// `credentials` to `inject` would make this plugin refuse to load without the
// seam — a regression for every user who has not configured one.
//
// So this file is the no-regression fence for the fix: the three existing
// credential paths (plugin config, process.env, the upstream CLI's .env) must
// keep working exactly as before when `ctx.get('credentials')` is undefined.
//
// Run: node test/d18-credential-seam-absent.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, installFetch, loadTools } from './harness.mjs';

const emptyRoutes = (url) => {
  if (url.includes('api.openalex.org')) return { body: { results: [], meta: { count: 0 } } };
  return { body: {} };
};

/** Run one OpenAlex search with no seam and return every URL it requested. */
async function urlsFor(config) {
  const mock = installFetch(emptyRoutes);
  try {
    const tools = loadTools({ cache: false, ...config });
    await tools.get('paper_search').execute({ query: 'literature', sources: 'openalex' });
  } finally {
    mock.restore();
  }
  return mock.calls.map((c) => c.url).join('\n');
}

// ── The plugin loads at all without the seam ────────────────────────────────
{
  let threw = null;
  let tools = null;
  try {
    tools = loadTools({ cache: false });
  } catch (e) {
    threw = e;
  }
  check('the plugin loads with no credential seam', threw === null, threw ? String(threw.message) : '');
  check('all six tools are registered without the seam',
    tools !== null && ['paper_search', 'paper_status', 'paper_detail', 'paper_citations', 'paper_oa', 'paper_fulltext']
      .every((n) => tools.has(n)),
    tools === null ? 'no tools' : [...tools.keys()].join(', '));
}

// ── Path 1: plugin config ───────────────────────────────────────────────────
{
  const urls = await urlsFor({ OPENALEX_API_KEY: 'FROM-PLUGIN-CONFIG' });
  check('without the seam, plugin config still supplies the key',
    urls.includes('api_key=FROM-PLUGIN-CONFIG'), urls.split('\n')[0] ?? 'no request');
}

// ── Path 2: process.env, both the prefixed and the bare name ────────────────
{
  const saved = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'FROM-PROCESS-ENV';
  let urls = '';
  try {
    urls = await urlsFor({});
  } finally {
    if (saved === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = saved;
  }
  check('without the seam, process.env still supplies the key',
    urls.includes('api_key=FROM-PROCESS-ENV'), urls.split('\n')[0] ?? 'no request');
}

{
  const saved = process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY;
  process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY = 'FROM-PREFIXED-ENV';
  let urls = '';
  try {
    urls = await urlsFor({});
  } finally {
    if (saved === undefined) delete process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY;
    else process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY = saved;
  }
  check('without the seam, the PAPER_SEARCH_MCP_ prefixed name still wins over the bare one',
    urls.includes('api_key=FROM-PREFIXED-ENV'), urls.split('\n')[0] ?? 'no request');
}

// ── Path 3: the upstream CLI's .env ─────────────────────────────────────────
// The plugin reads `~/.config/paper-search-mcp/.env`, owned by the upstream
// `paper-search-mcp` CLI, so a machine already set up for that CLI must keep
// working — the seam's own `dotenvFallback` does not read that path.
//
// `os.homedir()` reads `$HOME` at call time on Linux, so the test points HOME at
// a temporary directory instead of writing into the real one. That keeps the
// assertion real (it exercises the actual file-reading path) without ever
// touching a developer's own keys.
{
  const fakeHome = mkdtempSync(join(tmpdir(), 'paper-search-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  let urls = '';
  try {
    mkdirSync(join(fakeHome, '.config', 'paper-search-mcp'), { recursive: true });
    writeFileSync(join(fakeHome, '.config', 'paper-search-mcp', '.env'), 'OPENALEX_API_KEY=FROM-UPSTREAM-DOTENV\n');
    urls = await urlsFor({});
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
  check('without the seam, the upstream CLI .env still supplies the key',
    urls.includes('api_key=FROM-UPSTREAM-DOTENV'), urls.split('\n')[0] ?? 'no request');
}

console.log(process.exitCode ? '\nFAILED' : '\nOK');
