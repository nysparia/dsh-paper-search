// lib/index.js — the `dsh-paper-search` DSH plugin.
//
// FIVE THINGS THIS PLUGIN DOES:
//   1. registers the `paper-search` skill through `ctx.get('skills')`, at rank 450
//      so it LOSES to files in `~/.dsh/skills` (rank 400) — so the user's edits
//      always win, and this registration is only a fallback for when the preset
//      provider is dead (e.g. the "Creator mode" preset);
//   2. tool `paper_search` — literature search across sources;
//   3. tool `paper_status` — "doctor": which sources answer, which credentials
//      are readable, and which PDF->Markdown converter is installed;
//   4. tools `paper_citations` + `paper_oa` — the citation graph and open-access
//      copies through OpenAlex (adoption of upstream PR #96);
//   5. tool `paper_fulltext` — download the open-access PDF (arXiv first, PR #124)
//      then convert it to Markdown so the agent can read its FULL content.
//
// THE NUMBER OF TOOLS IS DELIBERATELY SMALL. Upstream `openags/paper-search-mcp`
// exposes 57 tools over MCP (PR #97), and that is **12,342 tokens on EVERY
// request** — measured 28 Sep 2026. Here there are five tools, and two of them
// share a schema.
//
// CREDENTIALS: this package carries no keys. The read order is
//   1. plugin config (from the user profile)
//   2. environment variables PAPER_SEARCH_MCP_<NAME>, then <NAME>
//   3. file ~/.config/paper-search-mcp/.env  (owned by the upstream CLI)
// Step 3 exists so a machine already set up for `paper-search-mcp` does not need
// to be configured again.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES, SOURCE_IDS, INTERNATIONAL_IDS, INDONESIA_IDS, searchSource, dedup, findSource, isDoi,
  resolveWork, summarizeWork, summarizeOA, worksCiting, worksCited, isWorkId, REFERENCE_LIMIT, arxivWork, isArxivId,
  mapCandidates, worksFromIds } from './sources.js';
import { DEFAULT_ROOT, findConverter, prepareFullText } from './fulltext.js';
import { createCache, cacheKey, isCacheable, defaultCacheFile, DEFAULT_TTL_MS } from './cache.js';
import { closenessToSeed, coCitation, clusterWorks, findBridges, summarizeCluster, shortId, referenceSets, mapIsUseful } from './peta.js';

export const name = 'paper-search';
// `skills` and `fs` are deliberately NOT injected: both are optional, read
// through ctx.get(). Without them the plugin must still register its tools.
export const inject = ['tools'];

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_FILE = join(PACKAGE_DIR, 'skills', 'paper-search', 'SKILL.md');
const PREFIX = 'PAPER_SEARCH_MCP_';

// ── Credentials ──────────────────────────────────────────────────────────────

/** Read the upstream CLI's .env, if it exists. Never throws. */
function readUpstreamEnv() {
  const output = {};
  try {
    const p = join(homedir(), '.config', 'paper-search-mcp', '.env');
    if (!existsSync(p)) return output;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[2].trim()) output[m[1]] = m[2].trim();
    }
  } catch {
    // Unreadable file = no credentials from this path. Not an error.
  }
  return output;
}

function createCredentialReader(config) {
  const fromFile = readUpstreamEnv();
  return function get(name) {
    if (config && config[name]) return { value: String(config[name]), from: 'plugin config' };
    const env = process.env[PREFIX + name] ?? process.env[name];
    if (env) return { value: String(env), from: 'environment variable' };
    if (fromFile[PREFIX + name]) return { value: fromFile[PREFIX + name], from: 'upstream .env' };
    if (fromFile[name]) return { value: fromFile[name], from: 'upstream .env (old name)' };
    return { value: null, from: null };
  };
}

/** Any available email — used for the Crossref/OpenAlex "polite pool". */
function politeEmail(get) {
  return get('UNPAYWALL_EMAIL').value || get('OPENALEX_EMAIL').value || null;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Translate the user's choice into a list of source ids. */
function selectSources(request) {
  const t = String(request ?? '').trim().toLowerCase();
  if (!t || t === 'all' || t === '*') return { valid: SOURCE_IDS, unknown: [], explicit: false };
  if (t === 'international') return { valid: INTERNATIONAL_IDS, unknown: [], explicit: false };
  if (t === 'indonesia') return { valid: INDONESIA_IDS, unknown: [], explicit: false };
  const valid = [];
  const unknown = [];
  for (const id of t.split(/[,\s]+/).filter(Boolean)) (findSource(id) ? valid : unknown).push(id);
  return { valid, unknown, explicit: true };
}

/** Work kinds that may be requested through the `kind` parameter. */
export const VALID_KINDS = ['article', 'review', 'preprint'];

/**
 * Fold a platform's own `type` vocabulary onto the three kinds this tool offers.
 *
 * The sources do not agree on spelling, and the local filter has to compare
 * against what they actually return:
 *   • Crossref: `journal-article`, `posted-content`, `proceedings-article`, …
 *   • OpenAlex: `article`, `review`, `preprint`, `paratext`, …
 *   • OpenReview: `article` (derived from the `/-/Submission` invitation)
 *
 * `review` is checked FIRST because `review-article` contains both words, and a
 * review must not be reported as original research. Anything unrecognized maps
 * to `null`, which the caller treats as "not a match" — the same outcome as the
 * old substring test, but without its false positives.
 * @param type - the platform's lowercased `type` string.
 * @returns one of VALID_KINDS, or null when the platform vocabulary is unknown.
 */
export function canonicalKind(type) {
  const t = String(type ?? '').toLowerCase();
  if (!t) return null;
  if (t.includes('review')) return 'review';
  if (t.includes('preprint') || t.includes('posted-content')) return 'preprint';
  if (t.includes('article') || t.includes('proceedings')) return 'article';
  return null;
}

/** "article, REVIEW" -> { kind: ['article','review'], unknown: [] }. Empty -> null. */
export function normalizeKind(value) {
  const raw = String(value ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return null;
  return {
    kind: raw.filter((s) => VALID_KINDS.includes(s)),
    unknown: raw.filter((s) => !VALID_KINDS.includes(s)),
  };
}

/**
 * A number from a work, or `null` if it is NOT reported.
 *
 * `Number(null)` is **0** and `Number.isFinite(0)` is TRUE — so without this
 * guard, "citations unknown" reads as "0 citations" and then gets thrown away by
 * `min_citations`, when all we have is ignorance. The
 * `test-search-filter.mjs` test caught it; do not simplify it back.
 */
function workNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Filter (`min_citations`, `kind`) then sort (`sort`) — **pure**, no network, so
 * it can be tested directly without calling a single source.
 *
 * Two rules that are deliberately DIFFERENT, and the difference is explained to
 * the user:
 *  - `min_citations` is a hard numeric threshold: works without a reported
 *    citation count are **dropped**, because we cannot prove they pass.
 *  - `kind` is a coarse class: works without a reported kind are **kept**,
 *    because "not stated" does not mean "not an article" — dropping them would
 *    erase sources that never mention a kind at all (Garuda, PubMed, …).
 *
 * Everything dropped is COUNTED and returned, not silently lost.
 */
export function filterAndSort(papers, { minCitations = null, kind = null, sort = 'relevance' } = {}) {
  let output = [...papers];
  const dropped = { noCitations: 0, lowCitations: 0, kindMismatch: 0, kindUnknown: 0 };

  if (minCitations !== null) {
    const rest = [];
    for (const p of output) {
      const s = workNumber(p.citedBy);
      if (s === null) { dropped.noCitations++; continue; }
      if (s < minCitations) { dropped.lowCitations++; continue; }
      rest.push(p);
    }
    output = rest;
  }

  if (kind !== null && kind.length > 0) {
    const rest = [];
    for (const p of output) {
      const t = String(p.type ?? '').toLowerCase();
      if (!t) { dropped.kindUnknown++; rest.push(p); continue; }
      // Compare CANONICAL kinds, not raw platform strings. Two measured bugs
      // made substring matching wrong in both directions:
      //   • `kind: ["article"]` kept `review-article`, so asking for original
      //     research silently mixed reviews back in;
      //   • `kind: ["preprint"]` dropped `posted-content`, which is exactly what
      //     Crossref returns for a preprint — so the filter emptied the source.
      // `canonicalKind` folds each platform's vocabulary onto the three kinds
      // the tool actually offers, and `review` wins over `article` because
      // `review-article` contains both words.
      if (kind.includes(canonicalKind(t))) rest.push(p);
      else dropped.kindMismatch++;
    }
    output = rest;
  }

  if (sort === 'citations' || sort === 'newest') {
    const key = sort === 'citations' ? (p) => workNumber(p.citedBy) : (p) => workNumber(p.year);
    output = output
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const va = key(a.p);
        const vb = key(b.p);
        if (va === null && vb === null) return a.i - b.i;
        if (va === null) return 1; // no number always goes last, never treated as zero
        if (vb === null) return -1;
        return ((vb - va) || (a.i - b.i));
      })
      .map((x) => x.p);
  }

  return { papers: output, dropped };
}

async function runSearch(args, credentials, cache = null) {
  const query = String(args?.query ?? '').trim();
  if (!query) throw new Error('parameter "query" is required');

  const queryIsDoi = isDoi(query);
  const choice = selectSources(args?.sources);
  if (choice.valid.length === 0) {
    throw new Error(`no valid sources. Available: ${SOURCE_IDS.join(', ')}`);
  }

  // Sources with a DOI input (unpaywall) only join when the query really is a
  // DOI. If requested EXPLICITLY, it still runs — the result is empty and that is
  // explained to the user, not silently dropped.
  const ids = [];
  const skipped = [];
  for (const id of choice.valid) {
    if (!queryIsDoi && findSource(id)?.input === 'doi' && !choice.explicit) { skipped.push(id); continue; }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error(
      `every selected source takes a DOI input (${skipped.join(', ')}), while this query is not a DOI. `
      + 'Include another source, or supply the DOI.',
    );
  }

  const rows = Math.min(Math.max(Number(args?.max_results) || 5, 1), 50);
  const email = politeEmail(credentials);

  // Filtering: a value that makes no sense is treated as NOT requested, and that
  // is reported — not silently used as some other number.
  const requestedCitations = Number(args?.min_citations);
  const minCitations = Number.isFinite(requestedCitations) && requestedCitations > 0 ? Math.floor(requestedCitations) : null;
  const invalidCitations = args?.min_citations !== undefined && minCitations === null;
  const requestedKind = normalizeKind(args?.kind);
  const kind = requestedKind?.kind?.length ? requestedKind.kind : null;
  const requestedSort = String(args?.sort ?? '').toLowerCase().trim();
  const sort = ['citations', 'newest', 'relevance'].includes(requestedSort) ? requestedSort : 'relevance';
  const invalidSort = args?.sort !== undefined && requestedSort !== '' && sort === 'relevance'
    && requestedSort !== 'relevance';

  const options = {
    rows,
    email,
    apiKey: credentials('SEMANTIC_SCHOLAR_API_KEY').value,
    doajApiKey: credentials('DOAJ_API_KEY').value,
    coreApiKey: credentials('CORE_API_KEY').value,
    // Forwarded to the sources that support it, so the threshold is filtered on
    // their side (recall preserved), not merely trimmed after the results arrive.
    minCitations,
    kind,
  };

  // ── SEARCH CACHE ───────────────────────────────────────────────────────────
  // Only sources that PASS `isCacheable` are cached (keyed and DOI sources are
  // skipped), and ONLY successful answers are stored — a momentary failure must
  // not "spread" for the whole TTL.
  const forceRefresh = args?.force_refresh === true;
  const perSource = await Promise.all(ids.map(async (id) => {
    const source = findSource(id);
    if (!cache || !isCacheable(source)) return searchSource(id, query, options);

    const key = cacheKey(id, query, { rows, minCitations, kind });
    if (!forceRefresh) {
      const hit = cache.get(key);
      if (hit) return { id, papers: hit.value, error: null, ms: 0, fromCache: true, ageMs: hit.ageMs };
    }
    const h = await searchSource(id, query, options);
    if (!h.error) cache.set(key, h.papers, { count: h.papers.length });
    return h;
  }));

  let papers = dedup(perSource.flatMap((h) => h.papers));
  if (args?.open_access_only) papers = papers.filter((p) => p.openAccess);
  const year = Number(args?.year_from);
  if (Number.isFinite(year) && year > 1500) papers = papers.filter((p) => !p.year || p.year >= year);

  const filtered = filterAndSort(papers, { minCitations, kind, sort });
  papers = filtered.papers;

  return {
    query,
    rows,
    ids,
    unknown: choice.unknown,
    skipped,
    perSource,
    papers,
    forceRefresh,
    fromCache: perSource.filter((h) => h.fromCache).length,
    filter: {
      minCitations,
      invalidCitations,
      kind,
      unknownKinds: requestedKind?.unknown ?? [],
      sort,
      invalidSort,
      invalidSortValue: invalidSort ? String(args?.sort) : null,
      dropped: filtered.dropped,
    },
  };
}

/**
 * One source status line — USED BY BOTH TOOLS so the marking is identical.
 * Previously the search tool used "v/x" and the status tool used "✓/✗", and that
 * mismatch made the test itself fail. Plain text is also safer in any terminal.
 */
function sourceLine(label, h, note = '') {
  const l = String(label).padEnd(18);
  return h.error
    ? `  FAILED ${l} ${note}${h.error}`
    : `  OK     ${l} ${note}${String(h.papers.length).padStart(3)} results  (${h.ms} ms)`;
}

function formatResult(result) {
  const { perSource, papers } = result;
  const failed = perSource.filter((h) => h.error);
  const lines = [];

  lines.push(`query: ${result.query}`);
  lines.push(`${perSource.length} sources searched · ${perSource.length - failed.length} answered · ${papers.length} unique papers after dedup`);
  // A cache that cannot be seen is a cache that misleads: its age is stated,
  // and `force_refresh` is offered as the way out.
  if (result.fromCache > 0) {
    const ages = perSource.filter((h) => h.fromCache).map((h) => h.ageMs ?? 0);
    const oldest = Math.max(...ages);
    lines.push(`NOTE: ${result.fromCache} of ${perSource.length} sources were served from CACHE (oldest ${Math.round(oldest / 60000)} minutes ago) — not a fresh search. Use force_refresh:true to force a re-search.`);
  } else if (result.forceRefresh) {
    lines.push('NOTE: force_refresh active — cache bypassed, all sources searched again.');
  }
  // Filtering & sorting: ALWAYS reported as-is, including what was dropped and
  // what was requested but unrecognized — so "the results are few" never becomes
  // a mystery for the reader of the report.
  const f = result.filter;
  if (f?.invalidCitations) lines.push('NOTE: min_citations ignored — it must be a number greater than 0.');
  if (f && f.minCitations !== null && f.minCitations !== undefined) {
    lines.push(`Filter: citations >= ${f.minCitations} — ${f.dropped.lowCitations} below the threshold · ${f.dropped.noCitations} DROPPED because the source does not report a citation count.`);
  }
  if (f?.kind?.length) {
    lines.push(`Kind filter: ${f.kind.join('/')} — ${f.dropped.kindMismatch} did not match · ${f.dropped.kindUnknown} still shown (the source does not state its kind).`);
  }
  if (f?.unknownKinds?.length) {
    lines.push(`WARNING: unknown kind (ignored): ${f.unknownKinds.join(', ')} — valid: ${VALID_KINDS.join(', ')}.`);
  }
  if (f?.invalidSort) lines.push(`WARNING: sort "${f.invalidSortValue}" is not recognized — "relevance" was used. Choices: relevance, citations, newest.`);
  if (f?.sort && f.sort !== 'relevance') {
    lines.push(`Order: ${f.sort === 'citations' ? 'most cited first' : 'newest first'} — works whose number the source does not report are placed last.`);
  }
  if (result.unknown?.length) lines.push(`WARNING: unknown source (ignored): ${result.unknown.join(', ')}`);
  if (result.skipped?.length) {
    lines.push(`NOTE: ${result.skipped.join(', ')} skipped because this query is not a DOI — that source really does search by DOI, not by keyword.`);
  }
  lines.push('');
  lines.push('per source:');
  for (const h of [...perSource].sort((a, b) => (b.papers.length - a.papers.length) || a.id.localeCompare(b.id))) {
    const src = findSource(h.id);
    const kindLabel = `${src?.kind ?? ''}${src?.input === 'doi' ? '/doi' : ''}`.padEnd(8);
    lines.push(sourceLine(src?.label ?? h.id, h, kindLabel));
  }

  if (failed.length) {
    lines.push('');
    lines.push('WARNING: sources marked FAILED above MUST be mentioned when reporting the results —');
    lines.push('do not conclude "there is no literature" from a source that failed.');
  }

  lines.push('');
  if (papers.length === 0) {
    lines.push('NO results passed the filter.');
    lines.push('Before concluding "there is no literature": retry once, then try other sources.');
    return lines.join('\n');
  }

  papers.slice(0, 40).forEach((p, i) => {
    const authors = p.authors.length ? p.authors.slice(0, 3).join('; ') + (p.authors.length > 3 ? ' et al' : '') : '(authors not reported)';
    lines.push(`${i + 1}. ${p.title}`);
    lines.push(`   ${p.year ?? '?'} · ${p.journal ?? 'journal not reported'} · ${authors}`);
    lines.push(`   source: ${p.sources.join(', ')}${p.openAccess ? ' · open access' : ''}${p.citedBy != null ? ` · ${p.citedBy} citations` : ''}`);
    if (p.doi) lines.push(`   doi: ${p.doi}`);
    else if (p.url) lines.push(`   url: ${p.url}`);
    if (p.abstract) lines.push(`   abstract: ${p.abstract}`);
  });
  if (papers.length > 40) lines.push(`… and ${papers.length - 40} more (narrow the query or lower max_results).`);
  return lines.join('\n');
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * The `output` shape DSH REQUIRES for every tool.
 *
 * Found through a real boot test (`test/test-in-dsh.mjs`) — and it is a bug that
 * slipped past the fake `ctx`, because the fake `register` only collects the
 * definition. DSH throws:
 *
 *   TypeError: tool "paper_search" must declare output { schema, render,
 *   presentationMeta? }
 *
 * Because that throw happens inside `apply()`, the WHOLE plugin fails to load —
 * neither its tools nor its skill get registered at all.
 *
 * Both tools here return already-formatted TEXT, so `schema` declares a string
 * and `render` wraps it into a content block — the same shape as `txt()` from
 * `dsh-search-cascade` (`[{ type: 'text', text: '...' }]`).
 */
function textOutput(description) {
  return {
    schema: { type: 'string', description },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  };
}

function searchTool(credentials, cache = null) {
  return {
    name: 'paper_search',
    description:
      'Search the scientific literature across 20 international sources (Crossref, ACM Digital Library, IEEE, OpenAlex, DOAJ, Europe PMC, PubMed, PubMed Central, arXiv, bioRxiv, medRxiv, ChemRxiv, Semantic Scholar, CORE, Zenodo, HAL, IACR ePrint, OpenReview, SSRN, Unpaywall) and 3 Indonesian journal portals (Garuda, Sinta, IOS OneSearch) at once, then drop duplicates by DOI/title. '
      + 'Everything is native over HTTP — no CLI or external package needed. '
      + 'Use for: finding papers/journals, prior research, Indonesian literature, or resolving a DOI. '
      + 'Can be filtered (min_citations, kind) and sorted (sort: citations/newest) — use this to lift classic/foundational works to the top instead of reading tangential recent results. '
      + 'The output separates sources that FAILED from those that answered, so "0 results" from one source must not be read as "there is no literature".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords. For Indonesian topics use Indonesian keywords — the results are far more relevant.' },
        sources: { type: 'string', description: `Comma-separated list of ids, or "all" / "international" / "indonesia". Available ids: ${SOURCE_IDS.join(', ')}. Default: all.` },
        max_results: { type: 'number', description: 'Results per source (1-50, default 5).' },
        open_access_only: { type: 'boolean', description: 'Only return open-access papers (when the source reports it).' },
        year_from: { type: 'number', description: 'Only papers with year >= this value.' },
        force_refresh: { type: 'boolean', description: 'Bypass the cache and start over (default false). In search mode: re-search every source, ignoring the search cache. In fulltext mode: download & convert again even if the result already exists.' },
        sort: { type: 'string', description: 'Result order AFTER dedup: "relevance" (default — the original per-source order), "citations" (most cited first; works whose citation count the source does not report are placed last), or "newest".' },
        min_citations: { type: 'number', description: 'Only papers with a citation count >= this value. Works from sources that do NOT report citations will be DROPPED — the threshold cannot be verified — and the count is reported in the output, not hidden.' },
        kind: { type: 'string', description: 'Filter the work kind: "article", "review", "preprint" (comma-separated is allowed). Forwarded to the sources that support it (OpenAlex, Crossref/ACM) so recall is not lost, then filtered again after dedup. Works whose kind the source does not report are STILL shown, and the count is stated.' },
      },
      required: ['query'],
    },
    output: textOutput('Text report: query, number of sources that answered, number of papers after dedup, per-source status lines (OK/FAILED), then the list of papers.'),
    execute: async (args) => {
      const result = await runSearch(args ?? {}, credentials, cache);
      return formatResult(result);
    },
  };
}

function statusTool(credentials, config, cache = null) {
  return {
    name: 'paper_status',
    description:
      'Check the health of the literature search: which sources really ANSWER right now (not merely registered), which credentials are readable and where they come from, and which PDF->Markdown converter is available for paper_fulltext. '
      + 'Use before reporting "no results", or when the user asks why a search came back empty. '
      + 'By default it checks the configuration only and sends NO network request; set probe:true to also send one small request to every source. '
      + 'Probing is opt-in because it is slow: measured on this machine, a full probe of all 23 sources took 122 seconds — arXiv is self-throttled to 1 request / 3 seconds and the three HTML portals are slow — which is long enough to hit a tool timeout. '
      + 'When you do probe, pass `sources` to limit it to the few sources you actually care about.',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'Send one small request to each source to prove it is alive (default FALSE — configuration only, no network). Probing all 23 sources takes about 2 minutes; combine it with `sources` to keep it short.' },
        sources: { type: 'string', description: 'Limit the check to some sources (comma-separated ids). Default: all.' },
        clear_cache: { type: 'boolean', description: 'Delete the ENTIRE search cache (default false). Useful when search results feel stale and you want to start clean.' },
      },
      required: [],
    },
    output: textOutput('Text report: the credentials that are readable and where they come from, a status line per source (OK/FAILED with response time), and additional notes.'),
    execute: async (args) => {
      // Opt-in, not opt-out. The old default probed every source on every call,
      // which measured 122 s end to end — a tool timeout waiting to happen, and
      // the model reaches for this tool exactly when it wants a fast answer.
      const probe = args?.probe === true;
      const sourceChoice = selectSources(args?.sources);
      const ids = sourceChoice.valid.length ? sourceChoice.valid : SOURCE_IDS;
      const out = [];
      if (cache && args?.clear_cache === true) {
        const ok = cache.clear();
        out.push(`search cache ${ok ? 'CLEARED' : 'FAILED to clear'}.`);
        out.push('');
      }
      out.push('== credentials ==');
      for (const name of ['UNPAYWALL_EMAIL', 'OPENALEX_EMAIL', 'SEMANTIC_SCHOLAR_API_KEY', 'DOAJ_API_KEY', 'CORE_API_KEY']) {
        const c = credentials(name);
        const shownValue = c.value
          ? (name.endsWith('EMAIL') ? c.value : `filled (${c.value.length} characters)`)
          : 'EMPTY';
        out.push(`  ${name.padEnd(30)} ${shownValue}${c.from ? `  ← ${c.from}` : ''}`);
      }
      out.push('  note: OpenAIRE and CiteSeerX are not used by this plugin.');
      out.push('  note: IEEE IS USED since 0.3.0 — through Crossref (member:263), without an API key. Its abstracts are not available in Crossref.');
      out.push('  note: ACM IS USED — through Crossref (DOI prefix 10.1145), without an API key. Do not set PAPER_SEARCH_MCP_ACM_API_KEY: upstream that key will never hold a valid value.');

      if (cache) {
        const cs = cache.status();
        out.push('');
        out.push('== search cache ==');
        out.push(`  file     : ${cs.file}`);
        out.push(`  content  : ${cs.validCount} valid entries of ${cs.count} stored · ${Math.round(cs.bytes / 1024)} kB`);
        out.push(`  limits   : TTL ${Math.round(cs.ttlMs / 60000)} minutes · max ${cs.maxEntries} entries · max ${Math.round(cs.maxBytes / 1024)} kB`);
        if (cs.validCount > 0) {
          out.push(`  age      : newest ${Math.round(cs.newestMs / 60000)} minutes · oldest ${Math.round(cs.oldestMs / 60000)} minutes`);
        } else {
          out.push('  age      : (no valid entries yet)');
        }
        out.push(`  sources that ARE CACHED: ${SOURCES.filter(isCacheable).length} · SKIPPED (keyed/DOI): ${SOURCES.filter((s) => !isCacheable(s)).map((s) => s.id).join(', ') || '(none)'}`);
        out.push('  note: source failures are NEVER stored — only successful answers are cached.');
      }

      out.push('');
      out.push('== sources ==');
      const email = politeEmail(credentials);
      const options = { rows: 1, email, apiKey: credentials('SEMANTIC_SCHOLAR_API_KEY').value, doajApiKey: credentials('DOAJ_API_KEY').value, coreApiKey: credentials('CORE_API_KEY').value };
      for (const id of ids) {
        const src = findSource(id);
        const kindLabel = `${src.kind}${src.input === 'doi' ? '/doi' : ''}`.padEnd(8);
        if (!probe) {
          out.push(`  ?     ${src.label.padEnd(18)} ${kindLabel} registered (not probed — pass probe:true to test it)`);
          continue;
        }
        // DOI-input sources are tested with a real DOI — tested with a keyword
        // they always return 0, and that reads as if the source were broken.
        const query = src.input === 'doi' ? '10.1038/s41580-023-00697-6' : 'literature';
        const h = await searchSource(id, query, options);
        out.push(sourceLine(src.label, h, kindLabel));
      }

      // The number uses the count that was ACTUALLY checked (`ids`), not the total
// number of sources. Measured 2 Oct 2026: with `sources: "doaj"` the output
// said "23 sources above" while the list itself had only one line — a number
// that does not match its own list.
      out.push(`note: ${ids.length} of ${SOURCES.length} sources checked above — all of them NATIVE, without a CLI or a third-party server.`);

      out.push('');
      out.push('== PDF->Markdown converter (for the paper_fulltext tool) ==');
      const conv = findConverter(config ?? {});
      if (conv) {
        out.push(`  PRESENT  ${conv.name.padEnd(12)} ${conv.path}  ← ${conv.from}`);
        if (conv.name === 'markitdown') {
          out.push('  note: anydoc not found — markitdown is used. Installing anydoc is faster:');
          out.push('           npm i -g @firecrawl/anydoc');
        }
      } else {
        out.push('  NONE — paper_fulltext cannot convert PDF to Markdown yet.');
        out.push('  install one of them, then run paper_status again:');
        out.push('    npm i -g @firecrawl/anydoc     (recommended — Rust, no Python, measured ~0.4 s/paper)');
        out.push('    uv tool install markitdown     (Python)');
      }
      out.push(`  library folder: ${config?.libraryRoot ?? config?.FOLDER_TEKS_LENGKAP ?? DEFAULT_ROOT}`);
      return out.join('\n');
    },
  };
}

// ── Citation graph & open-access copies (adoption of upstream PR #96) ────────

function clampNumber(n, fallback, min = 1, max = 50) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

/** "citing" vs "references" — plus the synonyms a model reasonably uses. */
function normalizeDirection(a) {
  const t = String(a ?? '').trim().toLowerCase();
  const backward = ['references', 'reference', 'referenced', 'backward', 'cited', 'cites'];
  return backward.includes(t) ? 'references' : 'citing';
}

/** The "work used" header — MUST be shown so a wrong pick is visible. */
function workHeader(k, input, { fromArxiv = null } = {}) {
  const lines = [];
  lines.push('work used:');
  lines.push(`  ${k.title ?? '(title not reported)'}${k.year ? ` (${k.year})` : ''}`);
  lines.push(`  id: ${k.id ?? '-'}${k.doi ? ` · doi: ${k.doi}` : ''}`);
  lines.push(`  ${k.journal ?? 'journal not reported'}${k.citedBy != null ? ` · cited ${k.citedBy} times` : ''}`);
  if (fromArxiv) {
    // The input really is an arXiv id — must NOT get a "picked from the title" warning.
    lines.push(`  arXiv: ${fromArxiv}`);
  } else if (!isDoi(input) && !isWorkId(input)) {
    lines.push('  NOTE: this work was picked from the TITLE — check first whether it is really the paper meant.');
  }
  return lines;
}

function paperLines(p, i) {
  const authors = p.authors?.length
    ? p.authors.slice(0, 3).join('; ') + (p.authors.length > 3 ? ' et al' : '')
    : null;
  const lines = [`${String(i + 1).padStart(2)}. ${p.title}`];
  lines.push(`    ${p.year ?? '?'} · ${p.journal ?? 'journal not reported'}${p.citedBy != null ? ` · ${p.citedBy} citations` : ''}`);
  if (authors) lines.push(`    ${authors}`);
  if (p.doi) lines.push(`    doi: ${p.doi}`);
  else if (p.url) lines.push(`    url: ${p.url}`);
  return lines;
}

/**
 * Truncate long text for the report + drop leftover HTML wrappers.
 *
 * The original `truncate()` lives in `lib/sources.js` (not exported because it is
 * used internally there). I once called it from here and a real test caught it
 * immediately: `ReferenceError: truncate is not defined`. This helper is
 * deliberately small and local so nothing has to be exported from sources.js.
 */
function truncate(text, n) {
  const t = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '(no title)';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * CITATION STRUCTURE MAP (upstream issue #122) — coupling, co-citation,
 * clustering, bridges.
 *
 * THE MATH lives in `lib/peta.js` (pure, tested without the network); here there
 * is only data fetching + report assembly.
 *
 * Deliberate COST FENCES, REPORTED to the user:
 *   • at most 50 candidates;
 *   • at most 3 OpenAlex requests (seed + candidates + shared reference titles);
 *   • no unbounded chained traversal — `depth` is only 1 or 2.
 */
async function structureMap({ work, summary, input, direction, email, args }) {
  const limit = Math.min(Math.max(Number(args?.max_candidates) || 40, 5), 50);
  const strongThreshold = Number.isFinite(Number(args?.strong_threshold)) && Number(args.strong_threshold) > 0 ? Number(args.strong_threshold) : 0.15;
  const minSharedStrong = Number.isFinite(Number(args?.min_shared_strong)) && Number(args.min_shared_strong) > 0 ? Math.floor(Number(args.min_shared_strong)) : 3;

  const out = workHeader(summary, input);
  let requests = 0;

  const batch = await mapCandidates(work, { direction, max: limit, email });
  requests += batch.requests;

  out.push('');
  out.push('== citation structure map ==');
  out.push(`candidate direction: ${direction === 'references' ? 'the seed\'s references (backward snowballing)' : 'works citing the seed (forward snowballing)'}`);
  out.push(`candidates checked: ${batch.works.length} of ${batch.total} recorded by OpenAlex` + (batch.total > batch.works.length ? ` (capped at ${limit})` : ''));
  out.push(`clustering threshold: cosine >= ${strongThreshold} AND >= ${minSharedStrong} shared references`);

  if (batch.works.length < 2) {
    out.push('');
    out.push('Fewer than 2 candidates, so no structure can be formed.');
    out.push('If the "citing" direction returns little: that is normal for a new paper — citation indexes always lag by several months.');
    return out.join('\n');
  }

  const seedRefs = referenceSets([work]).get(shortId(work?.id)) ?? new Set();
  out.push(`references recorded on the seed: ${seedRefs.size}` + (seedRefs.size === 0 ? ' (OpenAlex does NOT record them)' : ''));

  // Real incident 2 Oct 2026: the map was run on a recently published Indonesian
  // journal article — OpenAlex recorded 0 references and only 2 citing works, so
  // the ENTIRE map section was empty. Output that only says "0" made its user
  // think the tool was broken. So it is stated plainly + a way out is given.
  if (!mapIsUseful({ seedRefs: seedRefs.size, candidates: batch.works.length }).useful) {
    out.push('');
    out.push('!! THE MAP IS NOT USEFUL FOR THIS SEED !!');
    out.push(`   OpenAlex records ${seedRefs.size} references for this work and only ${batch.works.length} citing works.`);
    out.push('   Coupling & co-citation are computed FROM THE REFERENCE LIST, so without references there is nothing to measure.');
    out.push('   This is not a tool failure, and it does not mean the paper has no bibliography —');
    out.push('   it means OpenAlex has not indexed this work\'s references yet (normal for new/regional publications).');
    out.push('');
    out.push('   WHAT CAN BE DONE:');
    out.push('   1. Use a more established seed (an older, heavily cited international work) —');
    out.push('      find one first with paper({ mode: "search", sort: "citations", min_citations: 50 }).');
    out.push('   2. Or use the normal mode: paper({ mode: "citations", direction: "citing" }) — the citing list');
    out.push('      is still useful even when it is short.');
    return out.join('\n');
  }

  // ── 1. Closeness to the seed (bibliographic coupling) ──
  const closeness = closenessToSeed(batch.works, seedRefs);
  const withCoupling = closeness.filter((d) => d.coupling > 0);
  out.push('');
  out.push('-- most in the same field as the seed (the SAME references) --');
  if (withCoupling.length === 0) {
    out.push('  (not one candidate shares a reference with the seed)');
  } else {
    for (const [i, d] of withCoupling.slice(0, 8).entries()) {
      out.push(`  ${String(i + 1).padStart(2)}. [${d.coupling.toFixed(3)}] ${truncate(d.title, 78)}`);
      out.push(`      ${d.year ?? '?'} · ${d.citedBy ?? '?'} citations · ${d.shared} shared references of ${d.refs} · ${d.id}`);
    }
  }

  // ── 2. Co-citation: the shared foundation of this field ──
  const cc = coCitation(batch.works, seedRefs);
  const withCoCitation = cc.filter((x) => x.by > 0);
  out.push('');
  out.push('-- shared foundation (most often cited TOGETHER by the candidates) --');
  if (withCoCitation.length === 0) {
    out.push('  (no seed reference is cited together by the candidates)');
  } else {
    // Titles of the shared references need ONE extra request — and it is worth it:
    // without titles, a list of OpenAlex ids is nearly useless to a reader.
    const needTitles = withCoCitation.slice(0, 10);
    const refWorks = await worksFromIds(needTitles.map((x) => x.id), { email });
    requests += 1;
    const titleBy = new Map(refWorks.map((w) => [shortId(w.id), w]));
    for (const [i, x] of needTitles.entries()) {
      const w = titleBy.get(x.id);
      out.push(`  ${String(i + 1).padStart(2)}. [${x.by}x] ${truncate(w?.title ?? '(title unreadable)', 76)}`);
      out.push(`      ${w?.publication_year ?? '?'} · ${w?.cited_by_count ?? '?'} citations · ${x.id}`);
    }
  }

  // ── 3. Clusters ──
  const clusters = clusterWorks(batch.works, { threshold: strongThreshold, minShared: minSharedStrong });
  out.push('');
  out.push(`-- field clusters: ${clusters.clusters.length} groups --`);
  const titleByWork = new Map(batch.works.map((w) => [shortId(w.id), w]));
  clusters.clusters.slice(0, 6).forEach((members, i) => {
    const r = summarizeCluster(batch.works, members);
    out.push(`  cluster ${i + 1}: ${r.size} works · ${r.yearMin ?? '?'}-${r.yearMax ?? '?'} · total ${r.totalCitations} citations`);
    for (const w of r.top.slice(0, 3)) out.push(`      · ${truncate(w.title, 74)} (${w.publication_year ?? '?'})`);
  });
  const large = clusters.clusters.filter((x) => x.length > 1).length;
  if (large === 0) {
    out.push('  Note: NOT ONE pair of candidates is close enough — try lowering strong_threshold/min_shared_strong.');
  }

  // ── 4. Bridges between clusters ──
  const bridge = findBridges(batch.works, { strongThreshold, minSharedStrong });
  out.push('');
  out.push('-- bridges between clusters (nearly in two fields at once) --');
  out.push(`   (condition: cosine >= ${bridge.weakThreshold} AND >= ${bridge.minSharedWeak} shared references at the loose threshold)`);
  if (bridge.bridges.length === 0) {
    out.push('  (none — every candidate clearly sits in one field)');
  } else {
    const suspicious = bridge.bridges.filter((j) => j.suspicious);
    for (const j of bridge.bridges.slice(0, 6)) {
      const w = titleByWork.get(j.id);
      out.push(`  · ${truncate(w?.title ?? '(title unreadable)', 76)}`);
      out.push(`      connects ${j.otherClusters} clusters · ${j.degree} neighboring works · ${j.refs} references · ${w?.publication_year ?? '?'}${j.suspicious ? ' · ⚠️ VERY LONG REFERENCE LIST' : ''}`);
      out.push(`      ${j.id}`);
    }
    if (suspicious.length) {
      out.push(`  ⚠️ ${suspicious.length} of them have > ${bridge.reasonableRefLimit} references — usually CONTAINER records (proceedings/conference bundles),`);
      out.push('     not a single paper. A container really is "close to everything", so do NOT treat it as a finding.');
    }
  }

  // ── 5. Limits that MUST be read, not hidden ──
  out.push('');
  out.push(`OpenAlex requests: ${requests} (fence: at most 3)`);
  out.push('LIMITS TO BE AWARE OF before concluding anything:');
  out.push('  · coupling & co-citation are PROXIES for similarity, not proof of a relationship. Two works can be very similar without citing each other, and vice versa.');
  out.push('  · works with NO reference list in OpenAlex show up with closeness 0 — that is "unknown", not "dissimilar".');
  out.push('  · clusters depend on the threshold. State the threshold when reporting, because the cluster count is not a fact of nature.');
  out.push('  · "bridge" means nearly in two fields ACCORDING TO REFERENCES — not a judgment of quality or novelty.');
  return out.join('\n');
}

function citationsTool(credentials) {
  return {
    name: 'paper_citations',
    description:
      'Traverse the CITATION GRAPH of one paper through OpenAlex — free, no key, no email. '
      + 'Two directions: "citing" = papers that CITE this work (follow-up research, forward snowballing) · "references" = works CITED by this paper (theoretical foundation, reading list, backward snowballing). '
      + 'Accepts a DOI, an OpenAlex id/link (W…), or a TITLE. '
      + 'Use for: expanding the literature from one key paper, finding follow-up research, or checking a paper\'s theoretical foundation. '
      + 'If only a TITLE is given, OpenAlex may pick the wrong work — the output always states which work was really used, so check that first before concluding.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'DOI (10.…), OpenAlex id/link (W…), or the paper TITLE.' },
        direction: { type: 'string', description: '"citing" (default) = papers that cite this work · "references" = works this paper cites.' },
        max_results: { type: 'number', description: 'Number of results (1-50, default 10).' },
        sort: { type: 'string', description: '"citations" (default) = most cited first · "newest" = most recently published first.' },
        analysis: { type: 'string', description: '"list" (default) = the usual paper list · "map" = CITATION STRUCTURE MAP: groups works into field clusters, measures how close each work is to the seed through SHARED references (bibliographic coupling), computes co-citation, and flags BRIDGE works between clusters — useful for finding research gaps in a literature review.' },
        strong_threshold: { type: 'number', description: 'For analysis "map" only: the cosine threshold (0-1) for TIGHT clustering, default 0.15. Raise it if the clusters are too loose.' },
        min_shared_strong: { type: 'number', description: 'For analysis "map" only: the minimum number of shared references to cluster, default 3. This is the fence against a high cosine coming from just 1 reference.' },
        max_candidates: { type: 'number', description: 'For analysis "map" only: how many works to check (5-50, default 40). More = richer clusters, but the cost stays one extra request.' },
      },
      required: ['identifier'],
    },
    output: textOutput('Text report: the work used (title, id, DOI, citation count), the traversal direction, the total in OpenAlex, then the list of papers (title, year, journal, authors, DOI, citations).'),
    execute: async (args) => {
      const input = args?.identifier;
      const email = politeEmail(credentials);
      const work = await resolveWork(input, { email });
      const summary = summarizeWork(work);
      const rows = clampNumber(args?.max_results, 10);
      const requestedSort = String(args?.sort ?? '').trim().toLowerCase();
      const sort = requestedSort === 'newest' ? 'newest' : 'citations';
      const direction = normalizeDirection(args?.direction);
      const sortText = sort === 'newest' ? 'newest first' : 'most cited first';

      const out = workHeader(summary, input);
      out.push('');

      // Citation structure map (upstream issue #122) — run BEFORE the ordinary
      // list, because its output is a completely different shape.
      const requestedAnalysis = String(args?.analysis ?? '').trim().toLowerCase();
      if (requestedAnalysis === 'map' || requestedAnalysis === 'peta') {
        return structureMap({ work, summary, input, direction, email, args });
      }

      if (direction === 'references') {
        const h = await worksCited(work, { rows, sort, email });
        out.push('direction: references — works CITED by the paper above');
        out.push(`this work records ${h.total} references in OpenAlex · checked ${h.checked} · showing ${h.papers.length} (${sortText})`);
        if (h.total === 0) {
          out.push('');
          out.push('OpenAlex does NOT record a single reference for this work.');
          out.push('That means the data is empty in OpenAlex — it does NOT mean the paper cites nothing.');
          return out.join('\n');
        }
        if (h.total > h.checked) {
          out.push(`NOTE: only the first ${h.checked} references were checked (limit ${REFERENCE_LIMIT} per call), so "most cited" applies among those checked.`);
        }
        out.push('');
        h.papers.forEach((p, i) => out.push(...paperLines(p, i)));
        return out.join('\n');
      }

      const h = await worksCiting(work, { rows, sort, email });
      out.push('direction: citing — papers that CITE the work above');
      out.push(`total in OpenAlex: ${h.total} · showing ${h.papers.length} (${sortText})`);
      if (h.total === 0) {
        out.push('');
        out.push('Nothing cites it yet according to OpenAlex. For a new paper that is normal — citation indexes always lag by several months.');
        return out.join('\n');
      }
      out.push('');
      h.papers.forEach((p, i) => out.push(...paperLines(p, i)));
      return out.join('\n');
    },
  };
}

function oaTool(credentials) {
  return {
    name: 'paper_oa',
    description:
      'Find an OPEN-ACCESS copy (free & legal) of one paper through OpenAlex — no Unpaywall email needed. '
      + 'Accepts a DOI, an OpenAlex id/link (W…), or a TITLE. '
      + 'The output states the access status (gold/green/hybrid/bronze/closed) and the PDF or landing-page link of each copy, along with its license. '
      + 'Use for: checking whether a paper can be read for free, fetching a legal PDF, or when Unpaywall refuses because no email is set. '
      + 'This plugin does NOT download the PDF — it only shows the links.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'DOI (10.…), OpenAlex id/link (W…), or the paper TITLE.' },
      },
      required: ['identifier'],
    },
    output: textOutput('Text report: the work used, the open-access status (gold/green/hybrid/bronze/closed), and the list of OA copies (PDF/landing link, license, version, source).'),
    execute: async (args) => {
      const input = args?.identifier;
      const email = politeEmail(credentials);
      const work = await resolveWork(input, { email });
      const oa = summarizeOA(work);
      const out = workHeader(summarizeWork(work), input);
      out.push('');

      if (!oa.isOa) {
        out.push(`access status: NOT OPEN ACCESS${oa.status ? ` (${oa.status})` : ''} — OpenAlex sees no free copy.`);
        out.push('');
        out.push('next steps:');
        out.push('  - paper_search with this DOI (unpaywall source) — needs UNPAYWALL_EMAIL filled in');
        out.push('  - paper_search with its title (arxiv source) — the preprint version is often available');
        out.push('  - the rest through the campus library; this plugin does NOT break through paywalls');
        return out.join('\n');
      }

      out.push(`access status: OPEN ACCESS${oa.status ? ` (${oa.status})` : ''}`);
      if (oa.locations.length === 0) {
        out.push('copies: OpenAlex marks it open access, but does not detail the locations.');
        if (oa.oaUrl) out.push(`link: ${oa.oaUrl}`);
        return out.join('\n');
      }
      out.push(`copies found: ${oa.locations.length}`);
      oa.locations.forEach((loc, i) => {
        out.push(`${String(i + 1).padStart(2)}. ${loc.pdf ? 'PDF  ' : 'page'} ${loc.pdf ?? loc.landing}`);
        const meta = [loc.license, loc.version, loc.source].filter(Boolean).join(' · ');
        if (meta) out.push(`    ${meta}`);
        if (loc.pdf && loc.landing) out.push(`    page: ${loc.landing}`);
      });
      out.push('');
      out.push('NOTE: this plugin does not download the PDF — the links above are for you to open yourself.');
      return out.join('\n');
    },
  };
}

// ── Full text: PDF -> Markdown ──────────────────────────────────────────────
//
// Adoption of upstream PR #124 (arXiv as a fallback OA repository) PLUS one step
// upstream does not have: the PDF is converted to Markdown, because the model
// cannot read a raw PDF and one whole paper does not fit in a single send.

const INLINE_MAX_CHARS = 20000;
const PREVIEW_CHARS = 1500;

function fulltextTool(credentials, config) {
  const root = config?.libraryRoot ?? config?.FOLDER_TEKS_LENGKAP ?? DEFAULT_ROOT;
  return {
    name: 'paper_fulltext',
    description:
      'Fetch the FULL CONTENT of a paper: find its OPEN-ACCESS copy (the arXiv version first, then the OpenAlex/Unpaywall OA locations), download the PDF, then convert it to Markdown with anydoc so the agent can read it WHOLE. '
      + 'Accepts a DOI, an OpenAlex id/link (W…), an arXiv id (1706.03762), or a TITLE. '
      + 'Use for: reading a paper\'s content, extracting the methodology/results/numbers, quoting a specific passage, or checking a paper\'s claims. '
      + 'The Markdown and PDF files are stored in the library folder and their paths are returned — if the content is long, read it in slices with the read tool (offset/limit). '
      + 'Does NOT break through paywalls: if there is no legal copy, that is stated plainly.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'DOI (10.…), OpenAlex id/link (W…), arXiv id (1706.03762), or the paper TITLE.' },
        force_refresh: { type: 'boolean', description: 'Bypass the cache and start over (default false). In search mode: re-search every source, ignoring the search cache. In fulltext mode: download & convert again even if the result already exists.' },
      },
      required: ['identifier'],
    },
    output: textOutput('Text report: the work used, the Markdown + PDF file paths with their sizes, the PDF source and the converter used, then the FULL CONTENT (if it fits) or a preview + how to read the rest with the read tool.'),
    execute: async (args) => {
      const input = String(args?.identifier ?? '').trim();
      if (!input) throw new Error('identifier is required: DOI, OpenAlex id (W…), arXiv id, or paper title');
      const email = politeEmail(credentials);
      const converter = findConverter(config ?? {});

      // A direct arXiv id: do not ask OpenAlex (it may not be there at all).
      const arxivMatch = isArxivId(input);
      let work;
      let arxivRequested = null;
      if (arxivMatch) {
        arxivRequested = arxivMatch.id;
        const p = await arxivWork(arxivMatch.id);
        work = {
          title: p?.title ?? `arXiv:${arxivMatch.id}`,
          doi: p?.doi ?? null,
          publication_year: p?.year ?? null,
          open_access: { is_oa: true, oa_status: 'green' },
          locations: [{ is_oa: true, pdf_url: `https://arxiv.org/pdf/${arxivMatch.id}`, landing_page_url: p?.url ?? null, source: { display_name: 'arXiv' } }],
        };
      } else {
        work = await resolveWork(input, { email });
      }

      const out = workHeader(summarizeWork(work), input, { fromArxiv: arxivRequested });
      out.push('');

      const h = await prepareFullText({
        work, identifier: input, email, converter, root, forceRefresh: args?.force_refresh === true,
      });

      if (h.problem) {
        out.push(`FAILED: ${h.problem}`);
        if (h.candidates?.length) {
          out.push('');
          out.push('PDF candidates tried:');
          for (const cand of h.candidates) out.push(`  - ${cand.from}: ${cand.url}`);
        }
        out.push('');
        out.push('what this plugin does NOT do: break through paywalls, Sci-Hub, or Anna\'s Archive.');
        out.push('next steps: paper_oa (check other copies) · paper_search with this DOI (unpaywall source) · the campus library.');
        return out.join('\n');
      }

      const text = readFileSync(h.md, 'utf8');
      const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
      out.push('files:');
      out.push(`  markdown : ${h.md}`);
      out.push(`             ${kb(statSync(h.md).size)} · ${text.length} characters`);
      out.push(`  pdf      : ${h.pdf}${existsSync(h.pdf) ? ` (${kb(statSync(h.pdf).size)})` : ' (not stored)'}`);
      out.push(`PDF source : ${h.used?.from ?? '-'}${h.used?.note ? ` — ${h.used.note}` : ''}`);
      out.push(`converter  : ${h.converter?.name ?? '-'} (${h.converter?.from ?? '-'})`);
      if (h.fromCache) {
        out.push('note       : this file ALREADY EXISTED from before — not downloaded again.');
        out.push('             use force_refresh: true if you really want to refresh it.');
      }
      if (h.arxivId) {
        out.push(`arXiv archive: ${h.arxivId}${h.arxivFromTitle
          ? ` (FOUND FROM THE TITLE${h.arxivExact === false ? ', partial similarity' : ''} — check first whether it is the same paper)`
          : ''}`);
      }
      if (h.arxivNote) out.push(`note       : ${h.arxivNote}`);
      out.push('');

      if (text.length <= INLINE_MAX_CHARS) {
        out.push(`--- FULL CONTENT (${text.length} characters — fits in one send) ---`);
        out.push(text);
        return out.join('\n');
      }
      out.push(`--- preview of the first ${PREVIEW_CHARS} characters (full content ${text.length} characters) ---`);
      out.push(text.slice(0, PREVIEW_CHARS));
      out.push('');
      out.push('how to read the rest — do NOT ask for the whole content at once:');
      out.push(`  read({ file_path: "${h.md.replace(/\\/g, '/')}", offset: 1, limit: 400 })`);
      out.push('  then continue the offset until the end.');
      return out.join('\n');
    },
  };
}

// ── Skill ────────────────────────────────────────────────────────────────────

/** Flat frontmatter parser — enough for this package's SKILL.md. */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const block = m[1];
  const body = raw.slice(m[0].length).trim();
  const get = (key) => {
    const a = new RegExp(`^${key}:\\s*"([^"]*)"`, 'm').exec(block);
    if (a) return a[1].trim();
    const b = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block);
    return b ? b[1].trim() : '';
  };
  const name = get('name');
  if (!name) return null;
  return {
    name,
    description: get('description'),
    whenToUse: get('whenToUse'),
    // The invocation policy is honored FROM THE FILE, do not force `true`.
    modelInvocable: get('disable-model-invocation').toLowerCase() !== 'true',
    userInvocable: get('user-invocable').toLowerCase() !== 'false',
    body,
  };
}

function registerSkill(ctx, notes, toolMode = 'five') {
  const skills = ctx.get('skills');
  if (!skills || typeof skills.registerProvider !== 'function') {
    notes.push('skills service unavailable — the skill is only read from the file');
    return;
  }
  const read = async () => {
    try {
      const fsSvc = ctx.get('fs');
      let raw;
      if (fsSvc && typeof fsSvc.readText === 'function') {
        raw = await fsSvc.readText(await fsSvc.resolve(SKILL_FILE));
      } else {
        if (!existsSync(SKILL_FILE)) return null;
        raw = readFileSync(SKILL_FILE, 'utf8');
      }
      const content = parseFrontmatter(raw);
      // The name in the frontmatter must match — otherwise this is not our skill.
      return content && content.name === 'paper-search' ? content : null;
    } catch {
      return null;
    }
  };
  const summarize = (content) => ({
    name: content.name,
    // In single-door mode the catalog description gets a short note so the model
    // does not look for tool names that really do not exist in this profile.
    // Its length is kept <= 500 characters (the catalog limit) — tested in
    // test/test-single-door.mjs.
    description: toolMode === 'one'
      ? `${content.description || ''} (one \`paper\` tool + \`mode\`)`
      : (content.description || ''),
    ...(content.whenToUse ? { whenToUse: content.whenToUse } : {}),
    invocation: { modelInvocable: content.modelInvocable, userInvocable: content.userInvocable },
    source: 'runtime',
    provider: 'paper-search-runtime',
    // Rank 450: ABOVE 400 (~/.dsh/skills) so it loses to files the user edits,
    // but still wins over user-agents/bundled (500/600).
    rank: 450,
    locator: { file: SKILL_FILE },
  });

  ctx.effect(() => skills.registerProvider(() => ({
    name: 'paper-search-runtime',
    // Read EVERY time (not cached) so edits to SKILL.md take effect immediately
    // without restarting DSH.
    list: async () => {
      const content = await read();
      return content ? [summarize(content)] : [];
    },
    get: async (candidate) => {
      if (candidate?.name !== 'paper-search') return undefined;
      const content = await read();
      if (!content) return undefined;
      return {
        ...summarize(content),
        // The mode note is INSERTED here (not in the SKILL.md file) so the
        // original file still describes the DEFAULT five-tool behavior, while a
        // profile using `tools: "one"` is still told about it.
        content: (toolMode === 'one' ? SINGLE_MODE_NOTE : '') + content.body,
        resourceBase: { kind: 'directory', path: dirname(SKILL_FILE) },
      };
    },
  })));
  notes.push('skill paper-search registered in the global layer (rank 450, fallback)');
}

// ── "Single door" mode (config option `tools: 'one'`) ────────────────────────

/** Short label for each mode, for the single-door description. */
const MODE_LABELS = {
  search: 'search the literature across 23 sources',
  status: 'check source health, credentials, and converters',
  citations: 'citation graph (who cites / cites whom)',
  oa: 'find open-access copies',
  fulltext: 'download the open-access PDF then convert it to Markdown',
};

/** The note INSERTED into the skill body when the profile uses single-door mode. */
const SINGLE_MODE_NOTE =
  '> ⚠️ **This profile installs the plugin with `tools: "one"`.** All five capabilities '
  + 'are called through **ONE tool named `paper`** with a `mode` parameter '
  + '(`search` · `status` · `citations` · `oa` · `fulltext`). Separate tool names '
  + 'such as `paper_fulltext` **do not exist** in this profile — wherever this document '
  + 'mentions `paper_xxx`, call `paper({ mode: "xxx" })`.\n\n';

/**
 * `tools`: `'five'` (default — the old behavior) or `'one'` (single door).
 * An unknown value must NOT be silently used: return the default + a note.
 */
function normalizeTools(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'one') return { mode: 'one', note: null };
  if (v === '' || v === 'five') return { mode: 'five', note: null };
  return {
    mode: 'five',
    note: `config tools="${value}" is not recognized — the default "five" is used (choose "five" or "one")`,
  };
}

/**
 * Merge the five tool definitions into ONE door with a `mode` parameter.
 *
 * WHY IT EXISTS. All five tool definitions are sent to the model on EVERY
 * request — measured 29 Sep 2026: 4,877 characters ≈ 1,219 tokens. One door cuts
 * that by about 70%, at a price that must be understood: the tool name stops
 * explaining itself, and the schema becomes loose so the required-parameter guard
 * has to move from DSH into this function.
 *
 * The schema (`properties`) and required parameters are DERIVED from the original
 * definitions, not copied — so the two cannot drift apart when the real tool
 * changes. Because one schema cannot require different parameters per mode, that
 * requirement is checked in `execute` with a message resembling a DSH schema
 * rejection.
 */
function mergeIntoOne(list) {
  const modeName = (n) => n.replace(/^paper_/, '');
  const map = new Map(list.map((t) => [modeName(t.name), t]));
  const properties = {};
  const required = {};
  for (const [mode, t] of map) {
    Object.assign(properties, t.parameters?.properties ?? {});
    const needed = t.parameters?.required ?? [];
    if (needed.length) required[mode] = needed;
  }
  const modeList = [...map].map(([mode, t]) => {
    const needed = (t.parameters?.required ?? []).join(' + ');
    const label = MODE_LABELS[mode] ?? t.description.split('.')[0];
    return `${mode} = ${label}${needed ? ` (needs ${needed})` : ' (no required parameters)'}`;
  }).join(' · ');

  return {
    name: 'paper',
    description:
      `One door to the scientific literature — you MUST state \`mode\`. Choices: ${modeList}. `
      + 'Run `mode: "search"` first; if the result is empty, run `mode: "status"` before concluding "no results". '
      + 'For citations/oa/fulltext, `identifier` may be a DOI, an arXiv id, an OpenAlex id (W…), or a title. '
      + 'Mode `fulltext` only works for open-access copies and does not break through paywalls.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [...map.keys()],
          description: 'The capability being called. Required.',
        },
        ...properties,
      },
      required: ['mode'],
    },
    output: textOutput('Text report — its shape follows the chosen `mode` (the same as the separate tool\'s report).'),
    execute: async (args) => {
      const mode = String(args?.mode ?? '').trim();
      const t = map.get(mode);
      if (!t) {
        return `unknown mode: "${mode}" — choose one of: ${[...map.keys()].join(', ')}.`;
      }
      const missing = (required[mode] ?? []).filter((k) => args?.[k] === undefined || args?.[k] === '');
      if (missing.length) {
        // Mimicking a DSH schema rejection: required parameters per mode cannot be
        // required through one schema, so they are checked here.
        return `mode "${mode}" needs ${missing.map((k) => `\`${k}\``).join(' and ')} — not filled in yet.`;
      }
      return t.execute(args);
    },
  };
}

// ── apply ────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const notes = [];
  const credentials = createCredentialReader(config);

  // Search cache: ON by default (TTL 30 minutes). If it were off by default the
  // feature would never be used — and the same search repeated within one session
  // is exactly the most common thing that happens.
  // It can be turned off through config `cache: false`, and every use is
  // ALWAYS reported + can be force-refreshed per call.
  const libraryRoot = config?.libraryRoot ?? config?.FOLDER_TEKS_LENGKAP ?? DEFAULT_ROOT;
  const cacheDisabled = config?.cache === false || String(config?.cache ?? '').toLowerCase() === 'off';
  const cache = cacheDisabled ? null : createCache({
    file: config?.cacheFile ?? config?.berkasCache ?? defaultCacheFile(libraryRoot),
    ttlMs: Number(config?.cacheTtlMs) > 0 ? Number(config.cacheTtlMs) : DEFAULT_TTL_MS,
  });
  if (cache) notes.push(`search cache active: ${cache.file} (TTL ${Math.round(cache.ttlMs / 60000)} minutes; disable with config cache=false)`);
  else notes.push('search cache DISABLED through config');

  const tools = [
    searchTool(credentials, cache),
    statusTool(credentials, config, cache),
    citationsTool(credentials),
    oaTool(credentials),
    fulltextTool(credentials, config),
  ];
  const choice = normalizeTools(config?.tools);
  if (choice.note) notes.push(choice.note);
  if (choice.mode === 'one') {
    const single = mergeIntoOne(tools);
    ctx.effect(() => ctx.tools.register(single));
    notes.push(`tool ${single.name} (single door) registered — config tools="one"`);
  } else {
    for (const t of tools) {
      ctx.effect(() => ctx.tools.register(t));
      notes.push(`tool ${t.name} registered`);
    }
  }
  const conv = findConverter(config ?? {});
  notes.push(conv ? `PDF->Markdown converter: ${conv.name} (${conv.from})` : 'WARNING: no PDF->Markdown converter — paper_fulltext will refuse with a clear message');

  registerSkill(ctx, notes, choice.mode);

  if (SOURCES.length !== 23) {
    // Guard: the package description, README, SKILL.md, CHANGELOG, and the
    // catalog entry all state the NUMBER of sources. If this list changes, all
    // five must follow — and the catalog reviewer really does match the number in
    // the description against the code.
    notes.push(`WARNING: source count is ${SOURCES.length}, not 23 — update the package.json description, README, SKILL.md, CHANGELOG, catalog entry, and test/test-sources.mjs`);
  }
  notes.push(`${INTERNATIONAL_IDS.length} international sources + ${INDONESIA_IDS.length} Indonesian sources`);
  return notes.join(' · ');
}
