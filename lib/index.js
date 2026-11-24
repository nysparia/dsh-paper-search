// lib/index.js — the `dsh-paper-search` DSH plugin.
//
// SIX THINGS THIS PLUGIN DOES:
//   1. registers the `paper-search` skill through `ctx.get('skills')`, at rank 450
//      so it LOSES to files in `~/.dsh/skills` (rank 400) — so the user's edits
//      always win, and this registration is only a fallback for when the preset
//      provider is dead (e.g. the "Creator mode" preset);
//   2. tool `paper_search` — literature search across sources;
//   3. tool `paper_status` — "doctor": which sources answer, which credentials
//      are readable, and which PDF->Markdown converter is installed;
//   4. tool `paper_detail` — metadata + abstract for ONE paper or MANY at once,
//      through OpenAlex, free and keyless (added in 0.6.0; see `detailTool`);
//   5. tools `paper_citations` + `paper_oa` — the citation graph and open-access
//      copies through OpenAlex (adoption of upstream PR #96);
//   6. tool `paper_fulltext` — download the open-access PDF (arXiv first, PR #124)
//      then convert it to Markdown so the agent can read its FULL content.
//
// THE NUMBER OF TOOLS IS DELIBERATELY SMALL. Upstream `openags/paper-search-mcp`
// exposes 57 tools over MCP (PR #97), and that is **12,342 tokens on EVERY
// request** — measured 28 Sep 2026. Here there are six tools (10,050 characters
// of schema, ~2,513 tokens, measured 23 Nov 2026), and two of them share a
// schema.
//
// CREDENTIALS: this package carries no keys. The read order is
//   1. plugin config (from the user profile)
//   2. environment variables PAPER_SEARCH_MCP_<NAME>, then <NAME>
//   3. file ~/.config/paper-search-mcp/.env  (owned by the upstream CLI)
// Step 3 exists so a machine already set up for `paper-search-mcp` does not need
// to be configured again.

import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES, SOURCE_IDS, DEFAULT_IDS, DEFAULT_OFF, INTERNATIONAL_IDS, INDONESIA_IDS, searchSource, dedup, findSource, isDoi,
  resolveWork, summarizeWork, summarizeOA, worksCiting, worksCited, isWorkId, REFERENCE_LIMIT, arxivWork, isArxivId,
  mapCandidates, worksFromIds, parseIdentifier, resolveWorks, detailOfWork, identifierMatches } from './sources.js';
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

/**
 * The OpenAlex API key, or null.
 *
 * This is the credential that actually raises OpenAlex's limits: a free key
 * gives a 10x daily budget and 30 requests/second instead of 10, and it is
 * required for cursor paging. Without it the budget is shared by every caller on
 * the same IP address — which is exactly how this machine got rate-limited
 * during the 0.6.2 audit (HTTP 429, then ECONNRESET).
 *
 * Read through the same credential reader as everything else, so all three
 * sources work: plugin config, `PAPER_SEARCH_MCP_OPENALEX_API_KEY` /
 * `OPENALEX_API_KEY` in the environment, and the upstream CLI's `.env` file.
 */
function openAlexKey(get) {
  return get('OPENALEX_API_KEY').value || null;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Translate the user's choice into a list of source ids. */
function selectSources(request) {
  const t = String(request ?? '').trim().toLowerCase();
  // A bare call runs DEFAULT_IDS, not every registered id: `pmc` and `ios` are
  // registered but off by default (see DEFAULT_OFF in sources.js for the
  // measured reasons). Naming them explicitly still works.
  //
  // The GROUP keywords respect the same rule. "off by default" has to mean off
  // in every default set, otherwise `sources: "indonesia"` would quietly bring
  // back the one source that never answers — the exact cost this change exists
  // to remove. `sources: "ios"` still runs it.
  if (!t || t === 'all' || t === '*') return { valid: DEFAULT_IDS, unknown: [], explicit: false };
  if (t === 'international') return { valid: INTERNATIONAL_IDS.filter((id) => !DEFAULT_OFF.includes(id)), unknown: [], explicit: false };
  if (t === 'indonesia') return { valid: INDONESIA_IDS.filter((id) => !DEFAULT_OFF.includes(id)), unknown: [], explicit: false };
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
  //
  // A source whose `credit` says REQUIRED cannot work at all without its
  // credential: it throws before making a single request. Reporting that as
  // FAILED told the model a source "failed" when in truth it was never
  // configured. Measured 24 Nov 2026, a bare `paper_search` with no credentials:
  //
  //   FAILED CORE   api   CORE_API_KEY is required — without a key CORE answers
  //                       HTTP 429 with an empty body
  //
  // CORE stays in DEFAULT_IDS — with a key it must still run by default — so the
  // fix is to SKIP it here, with the reason stated, instead of paying for a
  // guaranteed failure line on every search. `paper_status` keeps reporting the
  // missing credential; that is its job, not this one's.
  //
  // `needs` is a LIST because a source may accept any one of several
  // credentials: `unpaywall()` takes `politeEmail()`, which falls back from
  // UNPAYWALL_EMAIL to OPENALEX_EMAIL. Checking only the first name would skip a
  // source that is in fact fully configured.
  const missingCredential = (source) => {
    const needs = [source?.needs ?? []].flat().filter(Boolean);
    if (!/REQUIRED/i.test(String(source?.credit ?? '')) || needs.length === 0) return null;
    return needs.some((n) => credentials(n).value) ? null : needs.join(' or ');
  };
  const ids = [];
  const skipped = [];
  const skippedNoCredential = [];
  for (const id of choice.valid) {
    const source = findSource(id);
    // The DOI-input rule is checked FIRST: for a keyword query that is the real
    // reason the source does not run, and its note already explains it.
    if (!queryIsDoi && source?.input === 'doi' && !choice.explicit) { skipped.push(id); continue; }
    const missing = missingCredential(source);
    if (missing) { skippedNoCredential.push({ id, credential: missing }); continue; }
    ids.push(id);
  }
  if (ids.length === 0) {
    // NOT an error when the only reason is a missing credential: the caller asked
    // for a source that is registered and healthy, it simply is not configured.
    // The reply then says exactly that (see `formatResult`) instead of failing the
    // call — a thrown error here would be indistinguishable from a broken tool.
    if (skippedNoCredential.length) {
      return {
        query, rows: 0, ids: [], unknown: choice.unknown, skipped, skippedNoCredential,
        perSource: [], papers: [], forceRefresh: false, fromCache: 0,
        filter: {
          minCitations: null, invalidCitations: false, kind: null, unknownKinds: [], sort: 'relevance',
          invalidSort: false, invalidSortValue: null, yearFrom: null, yearUnknown: 0, droppedByOa: 0,
          dropped: { noCitations: 0, lowCitations: 0, kindMismatch: 0, kindUnknown: 0 },
        },
      };
    }
    throw new Error(
      `every selected source takes a DOI input (${skipped.join(', ')}), while this query is not a DOI. `
      + 'Include another source, or supply the DOI.',
    );
  }

  const rows = Math.min(Math.max(Number(args?.max_results) || 5, 1), 50);
  const email = politeEmail(credentials);
  const apiKey = openAlexKey(credentials);

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
    // `apiKey` here is OpenAlex's — the Semantic Scholar key has its own field
    // below. Both used to be called `apiKey` in different scopes, which is why
    // the OpenAlex one was never wired through.
    apiKey,
    semanticApiKey: credentials('SEMANTIC_SCHOLAR_API_KEY').value,
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
  // `open_access_only` drops works whose OA status is UNKNOWN, because `makePaper`
  // coerces a missing flag to `false`. That is defensible — the caller asked for
  // open access and an unknown is not a yes — but it must be COUNTED and stated.
  // Measured 23 Nov 2026: `sources: "crossref", open_access_only: true` reported
  // "1 results" from Crossref and then listed 0 papers, with nothing explaining
  // the gap. Crossref has no OA flag at all, so that source can never satisfy
  // this filter.
  const beforeOa = papers.length;
  if (args?.open_access_only) papers = papers.filter((p) => p.openAccess);
  const droppedByOa = beforeOa - papers.length;
  const year = Number(args?.year_from);
  // A work whose year the source did NOT report is KEPT, not dropped: "unknown
  // year" is not "before the cutoff". That is the same rule `min_citations` and
  // `kind` follow, and it is now stated in the parameter description and in the
  // reply, so the count is not a surprise.
  const yearUnknown = [];
  if (Number.isFinite(year) && year > 1500) {
    papers = papers.filter((p) => {
      if (!p.year) { yearUnknown.push(p); return true; }
      return p.year >= year;
    });
  }

  const filtered = filterAndSort(papers, { minCitations, kind, sort });
  papers = filtered.papers;

  return {
    query,
    rows,
    ids,
    unknown: choice.unknown,
    skipped,
    skippedNoCredential,
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
      yearFrom: Number.isFinite(year) && year > 1500 ? year : null,
      yearUnknown: yearUnknown.length,
      droppedByOa,
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
  if (f?.droppedByOa > 0) {
    lines.push(`Open-access filter: ${f.droppedByOa} work(s) DROPPED because the source does not report an open-access status (Crossref, ACM, IEEE and PubMed never do). That is not evidence they are paywalled.`);
  }
  if (f?.yearFrom != null) {
    lines.push(`Year filter: >= ${f.yearFrom} — ${f.yearUnknown} work(s) with NO reported year are still shown (unknown is not "too old").`);
  }
  if (f?.sort && f.sort !== 'relevance') {
    lines.push(`Order: ${f.sort === 'citations' ? 'most cited first' : 'newest first'} — works whose number the source does not report are placed last.`);
  }
  if (result.unknown?.length) lines.push(`WARNING: unknown source (ignored): ${result.unknown.join(', ')}`);
  if (result.skipped?.length) {
    lines.push(`NOTE: ${result.skipped.join(', ')} skipped because this query is not a DOI — that source really does search by DOI, not by keyword.`);
  }
  // A source that needs a credential it does not have was SKIPPED, not failed —
  // and the difference matters: "failed" invites a retry, "not configured" tells
  // the reader what to do. It is stated here so a short list is never a mystery.
  if (result.skippedNoCredential?.length) {
    const list = result.skippedNoCredential.map((s) => `${s.id} (needs ${s.credential})`).join(', ');
    lines.push(`NOTE: ${list} skipped — no credential configured, so the source was never called. That is NOT a failure and NOT "no results": set the credential to include it.`);
  }
  // RETRACTION. `paper_detail` has always warned about this; the search path did
  // not, because `makePaper` never carried the flag (fixed 24 Nov 2026). The
  // warning is printed BEFORE the list so it cannot be missed, and the papers
  // themselves stay in the list — a retracted work is exactly the one a reader
  // most needs to see, flagged, not one to hide.
  const retracted = papers.filter((p) => p.isRetracted);
  if (retracted.length) {
    lines.push(`WARNING: ${retracted.length} of these ${papers.length} papers ${retracted.length === 1 ? 'IS' : 'ARE'} RETRACTED according to OpenAlex — they are still listed below, marked, because a retracted paper is the one you most need to know about. Do NOT cite them as valid findings.`);
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
    // WHY the list is empty matters more than the fact that it is. The filter
    // notes above are printed BEFORE this branch, so they are already visible —
    // but the summary line has to point at them, otherwise "0 results" reads as
    // "the search found nothing" when the sources actually answered.
    const answered = perSource.filter((h) => !h.error && h.papers.length > 0).length;
    if (answered > 0) {
      lines.push(`${answered} source(s) DID return papers — they were removed by the filters listed above, not by the search.`);
    }
    lines.push('Before concluding "there is no literature": retry once, then try other sources.');
    return lines.join('\n');
  }

  // DISPLAY_CAP is a hard limit on how many papers the reply lists, independent
  // of `max_results` (which is PER SOURCE). It exists because the reply is sent
  // to the model: 21 sources x 50 results can dedup to hundreds of records, and
  // listing them all would cost more tokens than the search is worth.
  //
  // It used to be a bare `40` with no explanation anywhere — measured 23 Nov
  // 2026: `max_results: 50` returned 40 papers and said nothing about why. The
  // count is now stated in the reply whenever it actually truncates.
  const DISPLAY_CAP = 40;
  papers.slice(0, DISPLAY_CAP).forEach((p, i) => {
    const authors = p.authors.length ? p.authors.slice(0, 3).join('; ') + (p.authors.length > 3 ? ' et al' : '') : '(authors not reported)';
    lines.push(`${i + 1}. ${p.title}`);
    lines.push(`   ${p.year ?? '?'} · ${p.journal ?? 'journal not reported'} · ${authors}`);
    lines.push(`   source: ${p.sources.join(', ')}${p.openAccess ? ' · open access' : ''}${p.citedBy != null ? ` · ${p.citedBy} citations` : ''}`);
    // The marker sits on the paper itself, not only in the summary line above:
    // a reader who skims the list must still see which entry is retracted.
    if (p.isRetracted) lines.push('   ⚠ RETRACTED — OpenAlex flags this work as retracted. Do not cite it as a valid finding.');
    if (p.doi) lines.push(`   doi: ${p.doi}`);
    else if (p.url) lines.push(`   url: ${p.url}`);
    if (p.abstract) lines.push(`   abstract: ${p.abstract}`);
  });
  if (papers.length > DISPLAY_CAP) {
    lines.push(`… and ${papers.length - DISPLAY_CAP} more NOT LISTED. The reply lists at most ${DISPLAY_CAP} papers however high max_results is set — max_results is PER SOURCE, this cap is on the merged list. Narrow the query, lower max_results, or use paper_detail on the ones you want.`);
  }
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
 * and `render` wraps it into a content block (`[{ type: 'text', text: '...' }]`).
 */
function textOutput(description) {
  return {
    schema: { type: 'string', description },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  };
}

/**
 * Report the arguments a mode does not read, instead of silently dropping them.
 *
 * WHY. Measured 23 Nov 2026: `paper_status({ query: 'CRISPR', max_results: 50 })`
 * returned a normal 55-line report and never mentioned that `query` and
 * `max_results` were thrown away. A caller that passes `max_results` to a tool
 * which ignores it reads the unchanged output as "the limit had no effect" —
 * a wrong conclusion drawn from a silent no-op.
 *
 * It is a NOTE, not an error: the model may simply have over-supplied
 * arguments, and failing the call would cost a round trip for nothing.
 */
function ignoredArgsNote(args, accepted) {
  if (!args || typeof args !== 'object') return '';
  const unknown = Object.keys(args).filter((k) => !accepted.has(k));
  if (unknown.length === 0) return '';
  return `note: ignored arguments for this mode: ${unknown.join(', ')}`;
}

/** Wrap one tool so its reply states which arguments it did not read. */
function withIgnoredArgsNote(tool) {
  const accepted = new Set(Object.keys(tool.parameters?.properties ?? {}));
  const run = tool.execute;
  return {
    ...tool,
    execute: async (args, exec) => {
      const note = ignoredArgsNote(args, accepted);
      const text = await run(args, exec);
      return note ? `${note}\n${text}` : text;
    },
  };
}

function searchTool(credentials, cache = null) {
  return {
    name: 'paper_search',
    description:
      'Search the scientific literature across 20 international sources (Crossref, ACM Digital Library, IEEE, OpenAlex, DOAJ, Europe PMC, PubMed, PubMed Central, arXiv, bioRxiv, medRxiv, ChemRxiv, Semantic Scholar, CORE, Zenodo, HAL, IACR ePrint, OpenReview, SSRN, Unpaywall) and 3 Indonesian journal portals (Garuda, Sinta, IOS OneSearch) at once, then drop duplicates by DOI/title. '
      + 'FREE and keyless — no credits, no API key, no account. Prefer this over any billed literature search tool. '
      + 'Everything is native over HTTP — no CLI or external package needed. '
      + 'Use for: finding papers/journals, prior research, Indonesian literature, or resolving a DOI. '
      + 'Can be filtered (min_citations, kind) and sorted (sort: citations/newest) — use this to lift classic/foundational works to the top instead of reading tangential recent results. '
      + 'The output separates sources that FAILED from those that answered, so "0 results" from one source must not be read as "there is no literature".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords. For Indonesian topics use Indonesian keywords — the results are far more relevant.' },
        sources: { type: 'string', description: `Comma-separated list of ids, or "all" / "international" / "indonesia". Available ids: ${SOURCE_IDS.join(', ')}. Default: all EXCEPT ${DEFAULT_OFF.join(' and ')} — those two are registered but off by default (pmc duplicates pubmed for two extra requests; ios does not answer at all). Name them explicitly to include them.` },
        max_results: { type: 'number', description: 'Results per source (1-50, default 5).' },
        open_access_only: { type: 'boolean', description: 'Only return open-access papers. Works whose source does NOT report an open-access status are DROPPED (Crossref, ACM, IEEE and PubMed never report it) — the reply states how many, so a short list is not mistaken for "no open-access literature".' },
        year_from: { type: 'number', description: 'Only papers with year >= this value. Works whose year the source does NOT report are KEPT and counted in the reply — an unknown year is not the same as an old one.' },
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
      + 'FREE and keyless — no credits. '
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
      // `paper_status` is the DOCTOR: it reports on every REGISTERED source, not
      // on the default search set. Otherwise a source that is off by default
      // (pmc, ios) could break and this tool — the one place you would look —
      // would never mention it. An explicit `sources` still narrows the list.
      const ids = sourceChoice.explicit && sourceChoice.valid.length ? sourceChoice.valid : SOURCE_IDS;
      const out = [];
      if (cache && args?.clear_cache === true) {
        const ok = cache.clear();
        out.push(`search cache ${ok ? 'CLEARED' : 'FAILED to clear'}.`);
        out.push('');
      }
      out.push('== credentials ==');
      for (const name of ['UNPAYWALL_EMAIL', 'OPENALEX_EMAIL', 'OPENALEX_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY', 'DOAJ_API_KEY', 'CORE_API_KEY']) {
        const c = credentials(name);
        const shownValue = c.value
          ? (name.endsWith('EMAIL') ? c.value : `filled (${c.value.length} characters)`)
          : 'EMPTY';
        out.push(`  ${name.padEnd(30)} ${shownValue}${c.from ? `  ← ${c.from}` : ''}`);
      }
      // Say what the OpenAlex key is FOR, because it is the one credential whose
      // absence is felt as "the tool is broken" rather than "a limit was hit".
      if (!credentials('OPENALEX_API_KEY').value) {
        out.push('  note: OPENALEX_API_KEY is EMPTY — OpenAlex then shares one daily budget across');
        out.push('        every caller on this IP address, at 10 req/s. A free key gives 10x the');
        out.push('        budget and 30 req/s: https://openalex.org/settings/api-key');
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
        // Same defect as the startup note: a cache file that cannot be written
        // must not be reported as a working cache. `set()` fails silently by
        // design, so this line is the only place the user can learn that every
        // search is paying full price.
        if (!cs.writable) {
          out.push('  state    : DISABLED — the file is not writable (read-only library root?), so nothing is ever stored and every search pays full price');
          out.push('             fix: set config libraryRoot to a writable directory');
        }
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
        // Mark the sources a bare `paper_search` does NOT run, so the doctor
        // report never implies they are part of the default set.
        const off = DEFAULT_OFF.includes(id) ? ' [off by default]' : '';
        if (!probe) {
          out.push(`  ?     ${src.label.padEnd(18)} ${kindLabel} registered${off} (not probed — pass probe:true to test it)`);
          continue;
        }
        // DOI-input sources are tested with a real DOI — tested with a keyword
        // they always return 0, and that reads as if the source were broken.
        const query = src.input === 'doi' ? '10.1038/s41580-023-00697-6' : 'literature';
        const h = await searchSource(id, query, options);
        out.push(sourceLine(src.label, h, kindLabel) + off);
      }

      // The number uses the count that was ACTUALLY checked (`ids`), not the total
// number of sources. Measured 2 Oct 2026: with `sources: "doaj"` the output
// said "23 sources above" while the list itself had only one line — a number
// that does not match its own list.
      out.push(`note: ${ids.length} of ${SOURCES.length} sources checked above — all of them NATIVE, without a CLI or a third-party server.`);
      out.push(`note: a bare paper_search runs ${DEFAULT_IDS.length} of ${SOURCES.length} sources. OFF BY DEFAULT: ${DEFAULT_OFF.join(', ')} — registered and callable by name, but not part of "all".`);

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
async function structureMap({ work, summary, input, direction, email, apiKey, args }) {
  const limit = Math.min(Math.max(Number(args?.max_candidates) || 40, 5), 50);
  const strongThreshold = Number.isFinite(Number(args?.strong_threshold)) && Number(args.strong_threshold) > 0 ? Number(args.strong_threshold) : 0.15;
  const minSharedStrong = Number.isFinite(Number(args?.min_shared_strong)) && Number(args.min_shared_strong) > 0 ? Math.floor(Number(args.min_shared_strong)) : 3;

  const out = workHeader(summary, input);
  // The SEED lookup already happened before this function was called (the caller
  // resolved `identifier` into `work`), and it cost one request. It used to be
  // left out of the tally, so the report said "1 request" for a run that made 2 —
  // measured 23 Nov 2026 with a mocked API. A cost fence that under-reports is
  // worse than no fence, because the reader budgets against a number that is wrong.
  let requests = 1;

  const batch = await mapCandidates(work, { direction, max: limit, email, apiKey });
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
    const refWorks = await worksFromIds(needTitles.map((x) => x.id), { email, apiKey });
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
    // `?` when NO member reports a citation count — `0` would be a claim the
    // data does not support (see `summarizeCluster`).
    out.push(`  cluster ${i + 1}: ${r.size} works · ${r.yearMin ?? '?'}-${r.yearMax ?? '?'} · total ${r.totalCitations ?? '?'} citations`);
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

/**
 * Render ONE detail record as the text report.
 *
 * Kept separate from the tool so the batch path can reuse it verbatim — a batch
 * reply must look EXACTLY like N single replies, otherwise the model has to
 * learn two output shapes for the same information.
 */
function detailLines(d, index = null) {
  const out = [];
  const head = index === null ? '' : `${index + 1}. `;
  out.push(`${head}${d.title ?? '(title not reported)'}`);
  const meta = [d.year ?? '?', d.venue ?? 'venue not reported', d.type ?? 'type not reported'].filter(Boolean).join(' · ');
  out.push(`   ${meta}`);
  if (d.citedBy != null) {
    const extra = [];
    if (d.fwci != null) extra.push(`FWCI ${d.fwci.toFixed(2)}`);
    if (d.percentile != null) extra.push(`top ${Math.max(1, Math.round((1 - d.percentile) * 100))}% in field`);
    out.push(`   cited ${d.citedBy} times${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
  }
  if (d.isRetracted) out.push('   ⚠ RETRACTED — OpenAlex flags this work as retracted.');
  if (d.authors.length) {
    const shown = d.authors.slice(0, 6).map((a) => a.name + (a.corresponding ? '*' : ''));
    out.push(`   ${shown.join('; ')}${d.authors.length > 6 ? ` et al (${d.authors.length} authors)` : ''}`);
    const affs = [...new Set(d.authors.flatMap((a) => a.institutions))].slice(0, 4);
    if (affs.length) out.push(`   ${affs.join(' · ')}`);
  }
  const ids = [];
  if (d.doi) ids.push(`doi: ${d.doi}`);
  if (d.ids.pmid) ids.push(`PMID: ${d.ids.pmid}`);
  if (d.ids.pmcid) ids.push(`PMCID: ${d.ids.pmcid}`);
  if (d.ids.arxiv) ids.push(`arXiv: ${d.ids.arxiv}`);
  if (d.id) ids.push(`OpenAlex: ${d.id}`);
  if (ids.length) out.push(`   ${ids.join(' · ')}`);
  const b = d.biblio ?? {};
  if (b.volume || b.issue || b.firstPage) {
    const pages = b.firstPage ? (b.lastPage && b.lastPage !== b.firstPage ? `${b.firstPage}-${b.lastPage}` : b.firstPage) : null;
    out.push(`   ${[b.volume ? `vol ${b.volume}` : null, b.issue ? `no ${b.issue}` : null, pages ? `pp ${pages}` : null].filter(Boolean).join(' · ')}`);
  }
  if (d.referenceCount != null) out.push(`   references: ${d.referenceCount}`);
  if (d.topics.length) out.push(`   topics: ${d.topics.join(' · ')}`);
  if (d.keywords.length) out.push(`   keywords: ${d.keywords.join(', ')}`);
  const oa = d.openAccess;
  if (oa?.isOa) {
    out.push(`   open access: ${oa.status ?? 'yes'}`);
    for (const loc of (oa.locations ?? []).slice(0, 3)) {
      const link = loc.pdf ?? loc.landing;
      if (link) out.push(`     ${loc.pdf ? 'PDF ' : 'page'} ${link}${loc.license ? ` (${loc.license})` : ''}`);
    }
  } else {
    out.push(`   open access: NO${oa?.status ? ` (${oa.status})` : ''} — no free copy in OpenAlex`);
  }
  if (d.abstract) out.push(`   abstract: ${d.abstract}`);
  else out.push('   abstract: (OpenAlex has no abstract for this work)');
  return out;
}

/**
 * `paper_detail` — metadata + abstract for ONE paper, or MANY at once.
 *
 * WHY IT EXISTS. On this machine `get_semantic_paper_detail` was the most
 * expensive tool in use: 60 calls / 60 credits, 31% of all billed spend, and 15
 * of those were CONSECUTIVE calls that one batch would have answered for 2
 * credits. OpenAlex carries the same metadata for free, so the lookup belongs
 * here.
 *
 * WHAT IT CANNOT DO, stated in the description so the model does not over-trust
 * it: OpenAlex has no S2 paperId/corpusId, no citation contexts or intents, and
 * no SPECTER2 embeddings. A caller that needs to chain into another Semantic
 * Scholar tool must still resolve the paper there.
 */
function detailTool(credentials) {
  return {
    name: 'paper_detail',
    description:
      // The requirement is stated FIRST because the schema cannot state it.
      // `required` cannot name either field (they are alternatives, so requiring
      // both would be wrong), and DSH's enforced schema subset has no way to say
      // "one of these two": `anyOf` is rejected outright
      // (`schema.anyOf is not a supported keyword`), and a root `oneOf` cannot
      // carry `type: 'object'`, which the wire schema needs. Measured against
      // packages/core/tools/src/json-schema.ts on 24 Nov 2026. So the sentence
      // here is the only channel left — and it has to be the first thing read.
      'Requires `identifier` OR `identifiers` — one of the two, never neither. '
      + 'Metadata + abstract for one paper, or MANY papers in ONE call — through OpenAlex, free, no key, no email. '
      + 'Accepts a DOI (10.…), a PMID (PMID:123), a PMCID (PMC123), an arXiv id (1706.03762), an OpenAlex id (W…), or a TITLE. '
      + 'PREFER THE BATCH: pass `identifiers` with every id you already have instead of calling this once per paper — the cost is TWO requests per identifier TYPE (one for ordinary works, one for retracted ones), not one per paper, so 15 DOIs cost 2 requests instead of 15. '
      + 'Returns title, authors + institutions, year/date, venue, publisher, citation count, FWCI, field percentile, retraction flag, volume/issue/pages, topics, keywords, open-access copies, and the full abstract. '
      + 'Use for: reading a paper\'s abstract, checking its metadata before citing it, confirming a DOI resolves to the paper you mean, or getting the abstract of several search results at once. '
      + 'LIMITS: OpenAlex has no Semantic Scholar paperId/corpusId, no citation contexts or intents, and no SPECTER2 embeddings — use the Semantic Scholar tools for those. '
      + 'A TITLE may resolve to the wrong record (OpenAlex holds duplicates); the output always states which work was really used, so check it first.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'ONE paper: DOI (10.…), PMID:123, PMC123, arXiv id (1706.03762), OpenAlex id (W…), or the TITLE. Alternative to `identifiers` — supply one or the other.' },
        identifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'MANY papers at once (max 50). Same formats as `identifier`. Alternative to `identifier` — supply one or the other. Use this instead of calling the tool repeatedly — the cost is two requests per identifier TYPE, not one per paper.',
        },
        abstract_chars: { type: 'number', description: 'Truncate each abstract to this many characters (default 1200, 0 = no limit). Abstracts are the bulk of the reply; lower this when fetching many papers.' },
      },
      // Deliberately empty: `identifier` and `identifiers` are ALTERNATIVES, so
      // naming either one here would make the other unusable. The requirement is
      // carried by the description instead — see the comment on `description`.
      required: [],
    },
    output: textOutput('Text report: for each paper — title, year/venue/type, citation count with FWCI and field percentile, retraction flag, authors with institutions, all identifiers (DOI/PMID/PMCID/arXiv/OpenAlex), volume/issue/pages, reference count, topics, keywords, open-access copies, and the abstract.'),
    execute: async (args) => {
      const email = politeEmail(credentials);
      const apiKey = openAlexKey(credentials);
      const abstractChars = Number.isFinite(Number(args?.abstract_chars)) ? Math.max(0, Math.trunc(Number(args.abstract_chars))) : 1200;

      // Accept both shapes. When BOTH are given, `identifiers` wins — but the
      // dropped `identifier` is REPORTED, not silently discarded.
      //
      // Measured 23 Nov 2026: `{ identifier: "10.9999/ignored", identifiers: [A, B] }`
      // returned A and B and never mentioned that the third paper was thrown away.
      // A caller who fills both fields has made a mistake, and the reply has to say
      // so — otherwise the missing paper looks like "OpenAlex does not have it".
      const hasArray = Array.isArray(args?.identifiers) && args.identifiers.length > 0;
      const hasSingle = typeof args?.identifier === 'string' && args.identifier.trim() !== '';
      const ignoredSingle = hasArray && hasSingle ? String(args.identifier).trim() : null;
      const list = hasArray
        ? args.identifiers.map((x) => String(x ?? '').trim()).filter(Boolean)
        : (hasSingle ? [String(args.identifier).trim()] : []);

      if (list.length === 0) {
        return 'identifier or identifiers is required: a DOI (10.…), PMID:123, PMC123, arXiv id, OpenAlex id (W…), or a paper title.';
      }
      if (list.length > 50) {
        return `too many identifiers (${list.length}) — at most 50 per call. Split the list and call again.`;
      }

      const out = [];
      const batch = list.length > 1;

      // Identifiers go through the batch resolver (grouped by prefix, one request
      // per type). Anything that is NOT an identifier — a title — has to be
      // searched one at a time, and that is stated rather than hidden.
      const idLike = list.filter((x) => parseIdentifier(x));
      const titleLike = list.filter((x) => !parseIdentifier(x));

      const found = [];
      let requests = 0;
      const unresolved = [];
      if (idLike.length) {
        const r = await resolveWorks(idLike, { email, apiKey });
        found.push(...r.works);
        requests += r.requests;
        unresolved.push(...r.unresolved);
      }

      for (const title of titleLike) {
        try {
          const w = await resolveWork(title, { email, apiKey });
          found.push(w);
          requests += 1;
        } catch (e) {
          unresolved.push(title);
          if (!batch) return `FAILED: ${e.message}`;
        }
      }

      if (found.length === 0) {
        out.push('NO work found in OpenAlex for:');
        for (const u of unresolved) out.push(`  · ${u}`);
        out.push('');
        out.push('Check the identifier, or pass the paper TITLE instead — OpenAlex can search by title.');
        return out.join('\n');
      }

      // ── Restore the CALLER'S order ──
      //
      // `resolveWorks` groups identifiers by prefix and issues one request per
      // group, so the works come back grouped by TYPE, not in the order they were
      // asked for. Measured 23 Nov 2026 with a mocked API that returned the filter
      // in reverse: asking for [A, B, C] produced [C, B, A]. A batch reply whose
      // numbering does not match the caller's list is actively misleading — the
      // reader matches "3." to their third identifier and gets a different paper.
      //
      // So each work is placed back at the index of the identifier that produced
      // it. Anything that cannot be matched keeps its arrival order at the end,
      // which is visible rather than silently shuffled.
      const ordered = [];
      const unmatched = [];
      for (const w of found) {
        const at = list.findIndex((raw) => {
          const p = parseIdentifier(raw);
          if (!p) return false;
          return identifierMatches(w, p.prefix, p.value);
        });
        if (at >= 0 && ordered[at] === undefined) ordered[at] = w;
        else unmatched.push(w);
      }
      for (const w of unmatched) ordered.push(w);
      const details = ordered.filter(Boolean).map((w) => detailOfWork(w));

      if (batch) {
        out.push(`${details.length} paper${details.length === 1 ? '' : 's'} · ${requests} OpenAlex request${requests === 1 ? '' : 's'} · free, no key`);
        out.push('');
      }
      if (ignoredSingle) {
        out.push(`WARNING: \`identifier\` was IGNORED because \`identifiers\` was also given — "${ignoredSingle}" was NOT looked up. Pass it inside \`identifiers\` if you meant to include it.`);
        out.push('');
      }
      details.forEach((d, i) => {
        if (abstractChars > 0 && d.abstract && d.abstract.length > abstractChars) {
          d.abstract = `${d.abstract.slice(0, abstractChars - 1)}…`;
        }
        out.push(...detailLines(d, batch ? i : null));
        if (i < details.length - 1) out.push('');
      });

      if (unresolved.length) {
        out.push('');
        out.push(`NOT FOUND in OpenAlex (${unresolved.length}):`);
        for (const u of unresolved) out.push(`  · ${u}`);
        out.push('These are genuinely absent from OpenAlex — that does NOT mean the paper does not exist.');
      }
      if (titleLike.length) {
        out.push('');
        out.push(`NOTE: ${titleLike.length} input${titleLike.length === 1 ? ' was a TITLE' : 's were TITLES'} — each needed its own search request, and a title can resolve to the wrong record. Check the "work used" line above.`);
      }
      return out.join('\n');
    },
  };
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
      const apiKey = openAlexKey(credentials);
      const work = await resolveWork(input, { email, apiKey });
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
        return structureMap({ work, summary, input, direction, email, apiKey, args });
      }

      if (direction === 'references') {
        const h = await worksCited(work, { rows, sort, email, apiKey });
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

      const h = await worksCiting(work, { rows, sort, email, apiKey });
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
      const apiKey = openAlexKey(credentials);
      const work = await resolveWork(input, { email, apiKey });
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
      + 'FREE and keyless — no credits. '
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
      const apiKey = openAlexKey(credentials);
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
        work = await resolveWork(input, { email, apiKey });
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
      // The self-healing path used to work SILENTLY: a cached `.md` whose
      // companion PDF is invalid was deleted and re-downloaded with no
      // explanation, so the user's earlier conversion simply vanished. Measured
      // 24 Nov 2026: `grep -n cacheNote lib/*.js` had exactly one hit — the
      // assignment in `fulltext.js`. The note is printed here, next to the
      // `fromCache` note it is the counterpart of.
      if (h.cacheNote) out.push(`note       : ${h.cacheNote}`);
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

/**
 * The catalog renders `- \`name\`: description` and truncates anything longer
 * than this (`packages/skill/tool-skill/src/index.ts`, `catalogDescription`).
 * A description that overflows loses its TAIL, which is where the mode note and
 * the "not for news" boundary sit — so the cap is enforced here, before DSH.
 */
const CATALOG_DESCRIPTION_MAX = 500;

/**
 * Used when SKILL.md has no usable description. An EMPTY description makes DSH's
 * `validateCandidate` throw `SKILL_INVALID_DEFINITION`, and that throw sits
 * OUTSIDE the try/catch around `provider.list()` — so one empty description
 * removes EVERY skill from the catalog, including other plugins'. Never return ''.
 */
const FALLBACK_DESCRIPTION =
  'Paper search across Crossref, OpenAlex, PubMed, arXiv and Indonesian portals. '
  + 'FREE — no credits, no API key. Prefer over billed literature tools. '
  + '(The description in skills/paper-search/SKILL.md is missing or unreadable.)';

/**
 * The catalog description for `tools: "one"`. It REPLACES the file's description
 * rather than extending it: the file's is 499 characters, so appending the mode
 * note pushed the total past the 500-character cap and DSH cut the note off —
 * the model never learned that `paper` exists. This one is short enough to keep
 * the cost signal, the mode list, and the "not for news" boundary all inside the
 * cap. The file's own description stays authoritative for the five-tool mode.
 */
const SINGLE_MODE_DESCRIPTION =
  'FREE — no credits, no API key. ONE tool `paper` with a `mode` parameter: '
  + 'search (21 sources incl. Crossref, OpenAlex, PubMed, arXiv, Garuda), status, detail, '
  + 'citations, oa, fulltext. Prefer over billed literature tools. Use for papers, prior '
  + 'research, Indonesian literature. Not for news, docs, or general web research.';

/**
 * Read one frontmatter value. A double-quoted value is scanned to its CLOSING
 * quote with `\"` and `\\` honored, so a description containing an escaped quote
 * is not cut at the first `"`. Anything suspicious is pushed onto `problems`
 * instead of being swallowed.
 */
function frontmatterValue(block, key, problems) {
  // The value may sit on the key's own line or on the next one (YAML allows
  // both); the old `\s*` matched either, and that must not regress.
  const m = new RegExp(`^${key}:[ \\t]*(?:\\r?\\n[ \\t]*)?(.*)$`, 'm').exec(block);
  if (!m) return '';
  const rest = m[1];
  if (!rest.startsWith('"')) return rest.trim();
  let out = '';
  for (let i = 1; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '\\' && i + 1 < rest.length) {
      const next = rest[i + 1];
      // Only the two escapes a double-quoted scalar needs here; this is not YAML.
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') return out.trim();
    out += ch;
  }
  problems.push(`${key} opens with a double quote that is never closed — the value was cut at the end of the line`);
  return out.trim();
}

/** Flat frontmatter parser — enough for this package's SKILL.md. */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const block = m[1];
  const body = raw.slice(m[0].length).trim();
  const problems = [];
  const get = (key) => frontmatterValue(block, key, problems);
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
    problems,
  };
}

/**
 * A named logger, or a no-op when the context has none. `ctx.logger` is the
 * cordis LoggerService (callable: `ctx.logger(name)`); `ctx.get('logger')` is
 * undefined. Mock contexts in the test suites have neither, so this must never
 * throw — a logger that cannot be built must not take the plugin down with it.
 *
 * This is the ONE place the plugin acquires a logger. Both the skill subsystem
 * and `apply()`'s startup notes go through it, so the two cannot drift apart.
 */
function pluginLogger(ctx) {
  try {
    const service = ctx?.logger;
    if (typeof service === 'function') {
      const named = service('paper-search');
      if (named && typeof named.warn === 'function') return named;
    }
    if (service && typeof service.warn === 'function') return service;
  } catch {
    // fall through to the no-op
  }
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * Call `onChange` when SKILL.md changes, so the catalog is rebuilt instead of
 * serving a cached revision until DSH restarts. Watches the DIRECTORY, not the
 * file: editors and `git checkout` replace the file by rename, which silently
 * kills a watcher bound to the old inode. Returns a disposer; never throws.
 */
function watchSkillFile(onChange, log) {
  const dir = dirname(SKILL_FILE);
  const target = basename(SKILL_FILE);
  let timer = null;
  let watcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // `filename` is null on some platforms; the directory holds only SKILL.md.
      if (filename && String(filename) !== target) return;
      // Coalesce the burst of events a single save produces.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 50);
      timer.unref?.();
    });
    watcher.on?.('error', (error) => {
      log.warn(`stopped watching ${SKILL_FILE}: ${error?.message ?? String(error)} — edits to it now need a DSH restart`);
    });
    watcher.unref?.();
  } catch (error) {
    log.warn(`cannot watch ${SKILL_FILE}: ${error?.message ?? String(error)} — edits to it need a DSH restart to reach the skill catalog`);
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}

function registerSkill(ctx, notes, toolMode = 'five') {
  const log = pluginLogger(ctx);
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
        if (!existsSync(SKILL_FILE)) {
          log.warn(`skill file ${SKILL_FILE} does not exist — the paper-search skill is not in the catalog`);
          return null;
        }
        raw = readFileSync(SKILL_FILE, 'utf8');
      }
      const content = parseFrontmatter(raw);
      if (!content) {
        log.warn(`skill file ${SKILL_FILE} has no usable frontmatter (a leading "---" block with a name) — the paper-search skill is not in the catalog`);
        return null;
      }
      for (const problem of content.problems) log.warn(`skill file ${SKILL_FILE}: ${problem}`);
      // The name in the frontmatter must match — otherwise this is not our skill.
      if (content.name !== 'paper-search') {
        log.warn(`skill file ${SKILL_FILE} declares name "${content.name}", not "paper-search" — ignored`);
        return null;
      }
      return content;
    } catch (error) {
      // Returning null keeps the plugin alive, but the REASON must be visible:
      // a silent null makes the skill vanish from the catalog with no trace.
      log.warn(`skill file ${SKILL_FILE} could not be read: ${error?.message ?? String(error)}`);
      return null;
    }
  };
  /**
   * The catalog entry. `whenToUse` is deliberately NOT included: DSH renders only
   * `- \`name\`: description`, so it would be 446 characters of dead payload on
   * every `list()`. `get()` below still returns it, where it costs nothing.
   */
  const summarize = (content) => {
    // Single-door mode uses its OWN short description instead of appending a note
    // to the file's: the file's is already 499 characters, and the 500-character
    // catalog cap would cut the note off — which is exactly how the model used to
    // end up never learning that `paper` exists. See SINGLE_MODE_DESCRIPTION.
    let description = String(toolMode === 'one' ? SINGLE_MODE_DESCRIPTION : content.description ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (description.length === 0) {
      log.warn(`skill description is empty in ${SKILL_FILE} — using the built-in fallback so the catalog survives`);
      description = FALLBACK_DESCRIPTION;
    }
    if (description.length > CATALOG_DESCRIPTION_MAX) {
      log.warn(`skill description is ${description.length} characters, over the ${CATALOG_DESCRIPTION_MAX}-character catalog cap — truncated`);
      description = `${description.slice(0, CATALOG_DESCRIPTION_MAX - 3)}...`;
    }
    return {
      name: content.name,
      description,
      invocation: { modelInvocable: content.modelInvocable, userInvocable: content.userInvocable },
      source: 'runtime',
      provider: 'paper-search-runtime',
      // Rank 450: ABOVE 400 (~/.dsh/skills) so it loses to files the user edits,
      // but still wins over user-agents/bundled (500/600).
      rank: 450,
      locator: { file: SKILL_FILE },
    };
  };

  ctx.effect(() => {
    let control = null;
    const disposeProvider = skills.registerProvider((c) => {
      control = c;
      return {
        name: 'paper-search-runtime',
        // `read()` re-reads the file on every call, but DSH caches the collected
        // catalog by revision — so a re-read alone is invisible. The watcher below
        // calls `control.invalidate()` to bump that revision; without it an edit to
        // SKILL.md only appears after a DSH restart.
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
            // Dropped from the catalog entry, kept here: loading the skill is a
            // one-off, so the field is free and stays useful.
            ...(content.whenToUse ? { whenToUse: content.whenToUse } : {}),
            // The mode note is INSERTED here (not in the SKILL.md file) so the
            // original file still describes the DEFAULT six-tool behavior, while a
            // profile using `tools: "one"` is still told about it.
            content: (toolMode === 'one' ? SINGLE_MODE_NOTE : '') + content.body,
            resourceBase: { kind: 'directory', path: dirname(SKILL_FILE) },
          };
        },
      };
    });
    const stopWatching = watchSkillFile(() => control?.invalidate(), log);
    return () => {
      stopWatching();
      disposeProvider();
    };
  });
  notes.push('skill paper-search registered in the global layer (rank 450, fallback)');
}

// ── "Single door" mode (config option `tools: 'one'`) ────────────────────────

/** Short label for each mode, for the single-door description. */
const MODE_LABELS = {
  // Derived, not hardcoded: a bare search runs DEFAULT_IDS, not every
  // registered source. "23 sources" read as "23 requests", which it is not —
  // `pmc` and `ios` are registered but off by default.
  search: `search the literature across ${DEFAULT_IDS.length} sources (${SOURCES.length} registered)`,
  status: 'check source health, credentials, and converters',
  detail: 'metadata + abstract for one paper or many at once (free, OpenAlex)',
  citations: 'citation graph (who cites / cites whom)',
  oa: 'find open-access copies',
  fulltext: 'download the open-access PDF then convert it to Markdown',
};

/** The note INSERTED into the skill body when the profile uses single-door mode. */
const SINGLE_MODE_NOTE =
  '> ⚠️ **This profile installs the plugin with `tools: "one"`.** All six capabilities '
  + 'are called through **ONE tool named `paper`** with a `mode` parameter '
  + '(`search` · `status` · `detail` · `citations` · `oa` · `fulltext`). Separate tool names '
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
 * Merge the per-mode descriptions of every parameter into ONE description.
 *
 * WHY. The first version of this function did `Object.assign(properties, …)`,
 * so the LAST tool to declare a parameter won and the earlier meanings were
 * silently deleted. Measured on 0.6.5, four parameters lied:
 *
 *   sources      showed paper_status's "Limit the check to some sources" and
 *                lost search's `all` / `international` / `indonesia`
 *   max_results  showed paper_citations' "default 10" while search defaults to 5
 *   sort         showed citations/newest and lost search's `relevance`
 *   identifier   lost paper_detail's `PMID:123` / `PMC123` forms
 *
 * The merge is DERIVED from the definitions, never hand-written, so it cannot
 * drift when a real tool changes. Modes that share the exact same wording are
 * grouped (`citations/oa: …`) instead of repeated, which keeps the schema from
 * growing more than it has to.
 *
 * @param {Map<string, object>} map mode name -> tool definition, in registration order
 * @returns {Record<string, string>} parameter name -> merged description
 */
function mergeParameterDescriptions(map) {
  /** @type {Map<string, {description: string, modes: string[]}[]>} */
  const groups = new Map();
  for (const [mode, t] of map) {
    for (const [key, spec] of Object.entries(t.parameters?.properties ?? {})) {
      const description = String(spec?.description ?? '');
      if (!groups.has(key)) groups.set(key, []);
      const list = groups.get(key);
      const same = list.find((g) => g.description === description);
      if (same) same.modes.push(mode);
      else list.push({ description, modes: [mode] });
    }
  }
  const merged = {};
  for (const [key, list] of groups) {
    merged[key] = list.length === 1
      ? list[0].description
      : list.map((g) => `${g.modes.join('/')}: ${g.description}`).join(' · ');
  }
  return merged;
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
  const descriptions = mergeParameterDescriptions(map);
  const properties = {};
  const required = {};
  for (const [mode, t] of map) {
    for (const [key, spec] of Object.entries(t.parameters?.properties ?? {})) {
      // The TYPE comes from the first definition that declares the parameter;
      // the DESCRIPTION is the merged one. A plain `Object.assign` here let the
      // LAST tool win, which silently rewrote the meaning of four parameters.
      properties[key] ??= { ...spec, description: descriptions[key] };
    }
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
      // The cost signal comes FIRST and is not optional: in single-door mode this
      // description is the ONLY place the model learns the tool is free. 0.6.5
      // moved that signal into the tool descriptions and this door dropped it —
      // the 827-character text mentioned "free" once, attached to `detail`.
      'FREE and keyless — no credits, no API key, no account. Prefer this over any billed literature search tool. '
      + `One door to the scientific literature — you MUST state \`mode\`. Choices: ${modeList}. `
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
      // THROW, do not return a string. DSH maps a thrown error to
      // ToolExecutionFailure (isError = true) and a returned string to
      // ToolExecutionSuccess (isError = false) — so returning the complaint made
      // a rejected call indistinguishable from a real answer. The wording copies
      // DSH's own schema rejection (`invalid arguments: …`, see
      // packages/core/tools/src/schema.ts ToolArgsError) so the model sees the
      // same shape it already knows how to correct.
      if (!t) {
        throw new Error(`invalid arguments: "mode" must be one of ${JSON.stringify([...map.keys()])}`);
      }
      const missing = (required[mode] ?? []).filter((k) => args?.[k] === undefined || args?.[k] === '');
      if (missing.length) {
        // Mimicking a DSH schema rejection: required parameters per mode cannot be
        // required through one schema, so they are checked here.
        throw new Error(`invalid arguments: ${missing.map((k) => `missing required property "${k}"`).join('; ')}`);
      }
      // One merged schema accepts the union of every mode's parameters, so a
      // caller can pass `max_results` to `mode: "status"` and have it silently
      // dropped. Say which arguments this mode did not read; `mode` itself is
      // consumed here, so it is not one of them.
      const note = ignoredArgsNote(args, new Set([...Object.keys(t.parameters?.properties ?? {}), 'mode']));
      const text = await t.execute(args);
      return note ? `${note}\n${text}` : text;
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
  if (cache) {
    // A cache that cannot be written is NOT an active cache. Saying "active"
    // while every `set()` silently fails is the worst of both worlds: the user
    // believes repeated searches are free, and they never are.
    notes.push(cache.writable
      ? `search cache active: ${cache.file} (TTL ${Math.round(cache.ttlMs / 60000)} minutes; disable with config cache=false)`
      : `search cache DISABLED — ${cache.file} is not writable (read-only library root?); every search pays full price. Set config libraryRoot to a writable directory to enable it`);
  } else notes.push('search cache DISABLED through config');

  const tools = [
    searchTool(credentials, cache),
    statusTool(credentials, config, cache),
    detailTool(credentials),
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
      // Wrapped at REGISTRATION, not in the `tools` array: `mergeIntoOne` derives
      // the single-door schema from the raw definitions and adds its own note, so
      // wrapping earlier would report the same ignored arguments twice.
      ctx.effect(() => ctx.tools.register(withIgnoredArgsNote(t)));
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
  // The default set is what a bare search actually pays for, so it is reported
  // separately — otherwise "23 sources" reads as "23 requests", which it is not.
  notes.push(`a bare search runs ${DEFAULT_IDS.length} of ${SOURCES.length} sources; off by default: ${DEFAULT_OFF.join(', ')}`);

  // ── Report the notes, and return NOTHING ──────────────────────────────────
  //
  // These notes used to be RETURNED as one 577-character string. That was a
  // latent crash, not a style problem. Cordis treats a plugin's return value as
  // an effect (`vendor/cordis/src/fiber.ts:394-401`): a function is collected
  // as a disposer, null/undefined is fine, anything else that is not an object
  // throws `TypeError: Invalid effect`. A string is neither.
  //
  // It only loaded because `export function apply` is CONSTRUCTIBLE: cordis
  // calls it with `new` (`fiber.ts:278`), and `new` discards a primitive return
  // value, so the effect came out `undefined`. Measured 24 Nov 2026:
  //
  //   function declaration  -> loaded
  //   same body, arrow fn   -> FAILED: Invalid effect
  //   same body, shorthand  -> FAILED: Invalid effect
  //
  // So any refactor to an arrow function broke plugin loading with an error
  // that pointed nowhere near the cause — and the notes themselves were thrown
  // away, because nothing ever read the return value.
  //
  // The logger comes from `pluginLogger()`, the same helper the skill subsystem
  // uses — one acquisition path, so the two cannot drift apart. It returns a
  // no-op when the context has none, so a bare test harness still loads.
  const log = pluginLogger(ctx);
  for (const note of notes) {
    try {
      // Warnings are logged as warnings so they are not buried among the
      // informational lines.
      if (/^WARNING|DISABLED/.test(note)) log.warn(note);
      else log.info(note);
    } catch {
      // Logging must never be the reason a plugin fails to load.
    }
  }
  return undefined;
}
