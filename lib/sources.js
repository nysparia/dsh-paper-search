// lib/sources.js — literature source connectors for dsh-paper-search.
//
// TWO KINDS OF SOURCE, and the difference matters (do not blur it):
//
//   kind: 'api'  — public REST API that returns JSON. Stable, has a schema.
//   kind: 'html' — public web page that MUST be parsed. Fragile by nature:
//                  the operator can change the markup at any time and this parser
//                  will return 0 results. That is why its failures MUST be
//                  reported as they are (see `searchSource`), not turned
//                  into "no results".
//
// THE RULE THIS WHOLE FILE FOLLOWS: a failure must not disguise itself as
// emptiness. Every non-2xx throws an error with the status and a body snippet;
// `searchSource` catches it and returns it as `error`, separate
// from `papers`. This is the lesson from upstream `paper-search-mcp`, which
// returns `[]` for EVERY status != 200 without a trace — so an arXiv
// answering 406 looks like "no papers".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The User-Agent carries the REAL version, read from package.json.
//
// It used to be hardcoded as `dsh-paper-search/0.1` while the package was at
// 0.6.1 — measured 23 Nov 2026. That matters beyond cosmetics: Crossref and
// OpenAlex route "polite pool" traffic by User-Agent, and a client that reports
// a version it is not running is a client the operator cannot identify when it
// misbehaves. Reading the manifest keeps the two from drifting again.
const PACKAGE_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const UA = `dsh-paper-search/${PACKAGE_VERSION} (+https://github.com/nysparia/dsh-paper-search)`;
const TIMEOUT_MS = 25000;

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function getText(url, { headers = {}, accept, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}), ...headers },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      // `body` is for the MESSAGE (short). `fullBody` is stored SEPARATELY so that
      // reply content that is still useful can be salvaged — measured on arXiv:
      // HTTP 406 sometimes actually carries a VALID Atom feed (issue #121).
      err.body = text.slice(0, 160).replace(/\s+/g, ' ');
      err.fullBody = text.slice(0, 512 * 1024);
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  return JSON.parse(await getText(url, { ...opts, accept: 'application/json' }));
}

// ── Uniform result shape ─────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function cleanText(s) {
  if (!s) return null;
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, k) => ENTITIES[k.toLowerCase()] ?? (k[0] === '#' ? String.fromCharCode(Number(k.slice(1))) : m))
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function truncate(s, n) {
  const t = cleanText(s);
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Normalize an author list from any shape into an ARRAY of names. Never
 * throws; always returns an array (possibly empty).
 *
 * This is the answer to three upstream bugs that really happened
 * (issue #109, #110, #112): a connector passed a **string** into a field typed
 * as a list, and the consumer then `join`ed that string so every name was split
 * per character — `"TAN, Kwan Hong"` became `"T; A; N; ,;  ; K; w; a; n; …"`.
 * Other shapes that also show up in the field: arrays of objects (`{name}`,
 * `{display_name}`, `{given, family}`), and fields missing entirely.
 *
 * DELIBERATELY does NOT split on COMMAS: `"TAN, Kwan Hong"` is ONE author, and
 * splitting it would actually corrupt the name. Only semicolons are used as
 * separators.
 */
export function authorList(x) {
  const output = [];
  const add = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (typeof v === 'object') {
      // A nested shape that is real in the field: OpenAlex wraps authors
      // as `{ author: { display_name } }`.
      if (v.author) { add(v.author); return; }
      add(v.name ?? v.display_name ?? v.raw_author_name ?? v.fullName ?? v.fullname ?? v.full_name
        ?? [v.given, v.family].filter(Boolean).join(' '));
      return;
    }
    if (typeof v === 'string') {
      for (const part of v.split(';')) {
        const b = cleanText(part);
        if (b) output.push(b);
      }
      return;
    }
    const s = cleanText(v);
    if (s) output.push(s);
  };
  add(x);
  return output.slice(0, 50);
}

/** DOI normalized without the URL prefix — so that dedup works. */
export function normalizeDoi(doi) {
  if (!doi) return null;
  const d = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return d.length > 3 ? d.toLowerCase() : null;
}

/**
 * Garuda writes titles inside an <xmp> element with SEVERAL repetition shapes,
 * and repeats them to fill the display width. All four were measured 28 Sep 2026
 * from **50 real titles** (5 queries):
 *
 *   A. exact period          "X X X X X X"                         (255 characters)
 *   B. repeated after ": "   "X: X"                                (194 characters)
 *   C. prefix then "X: X"    "NLP, Machine Learning X: X"          (270 characters)
 *   D. phrase repeated at the start  "IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI …"
 *
 * What must NOT be touched — and was checked on those 50 samples: VALID titles
 * shaped "Title: subtitle", "Title: (case study)", and "Title: keywords".
 * That is why rule (c) requires the part after ": " to be genuinely THE SAME as
 * the tail of the previous part — not merely that a colon is present. On the 50
 * samples, not a single valid title was truncated.
 *
 * Deliberately conservative: an over-long title is better than a wrongly truncated one.
 */
export function collapseTitle(s) {
  // The period search below is O(n^2): an outer scan over n/2 candidate periods
  // and an inner scan over n characters. Measured on this machine: 5,000 chars
  // 32 ms, 20,000 chars 433 ms, 50,000 chars 2,753 ms, 100,000 chars 12,964 ms.
  // `makePaper` only truncates to 300 chars AFTER this runs, so a source that
  // returns an oversized `title` field (a full abstract, a concatenated record)
  // would stall the whole search. No real title is anywhere near this long, so
  // clamping first is free and removes the stall.
  const MAX_TITLE_CHARS = 2000;
  let t = (s ?? '').trim().slice(0, MAX_TITLE_CHARS);
  for (let round = 0; round < 4; round++) {
    const before = t;

    // (A) exact period: find the smallest period, leave one copy.
    const n = t.length;
    for (let p = 10; p <= Math.floor(n / 2); p++) {
      let matches = true;
      for (let i = p; i < n; i++) {
        if (t[i] !== t[i % p]) { matches = false; break; }
      }
      if (matches) { t = t.slice(0, p).trim(); break; }
    }

    // (D) phrase repeated at the start: "A A rest" -> "A rest".
    // `A` must end on a word boundary, so it does not cut mid-word.
    for (let p = 8; p <= Math.floor(t.length / 2); p++) {
      const a = t.slice(0, p);
      if (!/[\s.)\]]$/.test(a)) continue;
      if (t.startsWith(a + a)) { t = (a + t.slice(2 * p)).trim(); break; }
    }

    // (B)/(C) repeated after the last ": " — compared WITHOUT regard to upper/
    // lower case, because Garuda often repeats a title with different capitalization.
    const splitAt = t.lastIndexOf(': ');
    if (splitAt > 0) {
      const tail = t.slice(splitAt + 2).trim();
      const head = t.slice(0, splitAt).trim();
      if (tail.length >= 20 && head.toLowerCase().endsWith(tail.toLowerCase())) t = head;
    }

    if (t === before) break;
  }
  return t;
}

function makePaper(p) {
  const doi = normalizeDoi(p.doi);
  const citations = Number(p.citedBy);
  return {
    title: truncate(collapseTitle(cleanText(p.title) ?? ''), 300),
    authors: authorList(p.authors).slice(0, 15),
    year: Number.isFinite(Number(p.year)) && Number(p.year) > 1500 ? Number(p.year) : null,
    source: p.source,
    doi,
    url: p.url || (doi ? `https://doi.org/${doi}` : null),
    journal: cleanText(p.journal),
    abstract: truncate(p.abstract, 900),
    openAccess: !!p.openAccess,
    // The citation count is only reported by some sources (OpenAlex, Semantic Scholar).
    // `null` = UNKNOWN, and that differs from 0 — do not let consumers show it
    // as "0 citations".
    citedBy: Number.isFinite(citations) ? citations : null,
    // Work type — ONLY if the source genuinely reports it. `null`
    // means "not reported", and that is DIFFERENT from "not an article": the
    // `kind` filter deliberately still shows the null ones (see `filterAndSort`).
    type: p.type ? String(p.type).toLowerCase() : null,
  };
}

// ── INTERNATIONAL sources (JSON API) ─────────────────────────────────────────

const CROSSREF_FIELDS = 'DOI,title,container-title,author,issued,abstract,URL,type';

/**
 * Translate `kind` (our vocabulary: article/review/preprint) into Crossref's
 * vocabulary. Crossref **has no** "review" kind — review articles there are
 * still `journal-article` — so a `review` request is deliberately NOT forced:
 * filtering it with `journal-article` would return ALL articles, which is the
 * opposite of what was asked. `review` filtering happens after the results
 * arrive, from a field the source genuinely reports.
 *
 * The same filter is written REPEATEDLY for several kinds — that is how Crossref
 * expresses OR on a single field.
 */
function crossrefFilter(kind) {
  const map = { article: 'journal-article', preprint: 'posted-content' };
  const t = (kind ?? []).map((j) => map[j]).filter(Boolean);
  return t.length ? t.map((x) => `type:${x}`).join(',') : null;
}

/**
 * One Crossref item -> one paper. USED BY TWO SOURCES (`crossref` and `acm`),
 * so the two cannot drift apart from each other.
 */
function fromCrossrefItem(it, source) {
  return makePaper({
    title: it.title?.[0],
    authors: authorList(it.author),
    year: it.issued?.['date-parts']?.[0]?.[0],
    source,
    doi: it.DOI,
    url: it.URL,
    type: it.type,
    journal: it['container-title']?.[0],
    abstract: it.abstract,
  });
}

async function crossref(query, { rows, email, kind = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  u.searchParams.set('select', CROSSREF_FIELDS);
  const kindFilter = crossrefFilter(kind);
  if (kindFilter) u.searchParams.set('filter', kindFilter);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => fromCrossrefItem(it, 'crossref')).filter((p) => p.title);
}

/**
 * ACM Digital Library — via Crossref, filtered to the DOI prefix `10.1145`.
 * **Without an API key.** This adopts upstream PR **#123**: there `acm.py` is a
 * skeleton that always throws `NotImplementedError`, so the source could never
 * be brought to life with a key (`PAPER_SEARCH_MCP_ACM_API_KEY` could never be
 * filled with a valid value). ACM has no public search API — but its entire
 * output is registered in Crossref under a single DOI prefix, and that prefix
 * can be filtered.
 *
 * Measured 28 Sep 2026: `filter=prefix:10.1145` answers HTTP 200 and **every**
 * result carries a `10.1145/…` DOI (7.6 million works in Crossref).
 *
 * What is DELIBERATELY **NOT** CLAIMED: that the results are open access. Upstream
 * PR #123 says ACM DL has been open since 1 Jan 2026, but **re-measured here**:
 * `HEAD https://dl.acm.org/doi/pdf/<2026 doi>` answers **HTTP 403**, and only
 * **9 of 20** ACM 2026 publications have a `license` field in Crossref. So
 * `openAccess` is left as it is (false) — a source that claims OA without
 * evidence is worse than one that does not claim it.
 */
async function acm(query, { rows, email, kind = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  const kindFilter = crossrefFilter(kind);
  // The literal form `'prefix:10.1145'` is DELIBERATELY preserved: an old test
  // checks exactly that string, and the `kind` filter is only APPENDED behind it —
  // deviating from that form would blind the guard for no reason.
  u.searchParams.set('filter', 'prefix:10.1145' + (kindFilter ? `,${kindFilter}` : ''));
  u.searchParams.set('select', CROSSREF_FIELDS);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => fromCrossrefItem(it, 'acm')).filter((p) => p.title);
}

/** OpenAlex stores abstracts as an inverted index — it must be reassembled. */
function openAlexAbstract(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const pos = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = word;
  return pos.filter(Boolean).join(' ') || null;
}

/** One OpenAlex work -> the uniform paper shape. Used by search AND the citation graph. */
function fromOpenAlexWork(w, source = 'openalex') {
  return makePaper({
    title: w.title,
    authors: authorList(w.authorships),
    year: w.publication_year,
    source,
    doi: w.doi,
    url: w.doi || w.id,
    journal: w.primary_location?.source?.display_name,
    abstract: openAlexAbstract(w.abstract_inverted_index),
    openAccess: !!w.open_access?.is_oa,
    citedBy: w.cited_by_count,
    type: w.type,
  });
}

async function openalex(query, { rows, email, apiKey = null, minCitations = null, kind = null }) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', query);
  u.searchParams.set('per-page', String(rows));
  // Push-down: the citation threshold and the kind are handled by OpenAlex itself,
  // so that `max_results` is still filled with results that PASSED the filter —
  // not trimmed after arrival (which leaves only a few results).
  const filter = [];
  if (Number.isFinite(minCitations) && minCitations > 0) filter.push(`cited_by_count:>${Math.max(0, Math.floor(minCitations) - 1)}`);
  const t = (kind ?? []).filter((j) => ['article', 'review', 'preprint'].includes(j));
  if (t.length) filter.push(`type:${t.join('|')}`);
  if (filter.length) u.searchParams.set('filter', filter.join(','));
  if (email) u.searchParams.set('mailto', email);
  if (apiKey) u.searchParams.set('api_key', String(apiKey));
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((w) => fromOpenAlexWork(w)).filter((p) => p.title);
}

// ── OpenAlex citation graph (upstream PR #96) ────────────────────────────────
//
// THREE things PR #96 added upstream, and here they are realized as
// TWO tools + one `paper_oa` function:
//   get_citing_papers     -> `paper_citations` direction "citing"
//   get_referenced_papers -> `paper_citations` direction "references"
//   find_open_access_pdf  -> `paper_oa`
//
// Why NOT three separate tools like upstream: every registered tool is also sent
// BACK to the model on EVERY request. Upstream does not count that cost (PR #97
// there exposes 57 tools). Here the two citation directions share
// one schema because their input shape is identical.

const OPENALEX = 'https://api.openalex.org';

/** Limit on how many references are actually fetched — a cost fence, not an API limit. */
export const REFERENCE_LIMIT = 100;

/**
 * Build an OpenAlex URL.
 *
 * TWO optional credentials, and they do different things:
 *
 *   `apiKey` — the real lever. Sent as the `api_key` query parameter (OpenAlex
 *     also accepts `Authorization: Bearer`, but the query parameter keeps this
 *     function's shape identical to the `mailto` handling that was already here).
 *     A free key raises the daily budget 10x and the per-second limit from 10 to
 *     30, and it is REQUIRED for cursor paging past the first page. Measured
 *     23 Nov 2026: `?api_key=FAKE` answers HTTP 401 "API key not found", so a
 *     wrong key is reported rather than silently ignored.
 *
 *   `email` — `mailto`, the old "polite pool" convention. Kept because it costs
 *     nothing and some deployments still set it, but it is NOT what raises the
 *     limit any more: the current OpenAlex authentication docs do not mention
 *     `mailto` at all, and the 429 body names the missing KEY as the reason.
 *     The error message below used to claim otherwise and was wrong.
 */
function openAlexUrl(path, params = {}, email, apiKey = null) {
  const u = new URL(OPENALEX + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (email) u.searchParams.set('mailto', email);
  if (apiKey) u.searchParams.set('api_key', String(apiKey));
  return u.toString();
}

/**
 * All OpenAlex calls go through here so that the error messages are consistent.
 * HTTP 429 from OpenAlex is **transient** and has been measured several times in
 * this project; a raw "HTTP 429" does not tell the consumer what to do.
 * 404 is deliberately NOT translated here — each caller has its own, more
 * precise message (DOI vs OpenAlex id vs title).
 */
async function openAlexJson(path, params, email, apiKey = null) {
  try {
    return await getJson(openAlexUrl(path, params, email, apiKey));
  } catch (e) {
    if (e?.status === 429) {
      // The advice depends on whether a key is already in use: telling someone
      // who HAS a key to "set a key" is useless, and telling someone without one
      // to "wait 10 seconds" hides the actual fix.
      throw new Error(apiKey
        ? 'OpenAlex is rate-limiting (HTTP 429) — the daily budget or the per-second limit is spent. Check it with GET https://api.openalex.org/rate-limit?api_key=… ; the daily budget resets at midnight UTC.'
        : 'OpenAlex is rate-limiting (HTTP 429) — without an API key the daily budget is shared by everyone on this network\'s IP address. Set OPENALEX_API_KEY (free: https://openalex.org/settings/api-key) for a 10x budget and 30 req/s instead of 10.');
    }
    if (e?.status === 401) {
      // A wrong key must not look like a transient failure.
      throw new Error('OpenAlex rejected the API key (HTTP 401) — check OPENALEX_API_KEY. A key only works after its email address is verified.');
    }
    // Measured 29 Sep 2026: `works/doi:…` was once answered with HTTP 504
    // "Gateway timeout" plus an explanatory JSON body (`reason: query_timeout`).
    // Untranslated, the consumer only sees "HTTP 504" without knowing
    // that it is transient and simply needs a retry.
    if (e?.status === 504 || e?.status === 503) {
      throw new Error(`OpenAlex is slow right now (HTTP ${e.status}) — this is transient, retry in a moment`);
    }
    throw e;
  }
}

/** Short OpenAlex id: "https://openalex.org/W123" -> "W123". */
export function workId(w) {
  return String(w?.id ?? '').split('/').pop() || null;
}

/** Is this input an OpenAlex id (W…), not a DOI and not a title? */
export function isWorkId(t) {
  return /^(?:https?:\/\/openalex\.org\/)?W\d+$/i.test(String(t ?? '').trim());
}

/** Summary of one OpenAlex work — used by the citation-graph & OA output header. */
export function summarizeWork(w) {
  const citations = Number(w?.cited_by_count);
  return {
    id: workId(w),
    title: cleanText(w?.title),
    year: w?.publication_year ?? null,
    doi: normalizeDoi(w?.doi),
    journal: cleanText(w?.primary_location?.source?.display_name),
    authors: authorList(w?.authorships),
    citedBy: Number.isFinite(citations) ? citations : null,
  };
}

/**
 * DOI / OpenAlex id / TITLE -> ONE OpenAlex work.
 *
 * A title is accepted because the model often only has the title. But selecting
 * by title can be WRONG — measured 28 Sep 2026: the title query
 * *"Attention is all you need"* returned `W2626778328`, a duplicate record with a
 * strange DOI, not the original record. That is why the caller MUST
 * show the work that was actually selected (see `summarizeWork`), so that a
 * wrong pick is visible rather than disguised.
 */
export async function resolveWork(identifier, { email, apiKey = null } = {}) {
  const t = String(identifier ?? '').trim();
  if (!t) throw new Error('identifier is required: DOI (10.…), OpenAlex id (W…), or paper title');

  if (isWorkId(t)) {
    const id = t.split('/').pop();
    try {
      return await openAlexJson(`/works/${id}`, {}, email, apiKey);
    } catch (e) {
      if (e.status === 404) throw new Error(`OpenAlex id ${id} not found`);
      throw e;
    }
  }

  // IMPORTANT: what decides "this is a DOI" is `isDoi()`, NOT `normalizeDoi()`.
  // `normalizeDoi()` only strips the URL prefix and then checks the length — it
  // accepts ALMOST any text, so using it here would treat every title as a DOI
  // (caught by the smoke test 29 Sep 2026: "zzzqqqxxyy cannot possibly exist" was
  // answered with "DOI … not found" instead of being searched as a title).
  // `normalizeDoi()` is used AFTER it passes, to strip the `https://doi.org/` prefix.
  const doi = isDoi(normalizeDoi(t) ?? '') ? normalizeDoi(t) : null;
  if (doi) {
    try {
      return await openAlexJson(`/works/doi:${encodeURI(doi)}`, {}, email, apiKey);
    } catch (e) {
      // OpenAlex's 404 is an HTML page, not JSON — the message must be
      // translated, otherwise the consumer sees "<!doctype html>".
      if (e.status === 404) throw new Error(`DOI ${doi} not found in OpenAlex — try giving its title, or check the DOI`);
      throw e;
    }
  }

  const j = await openAlexJson('/works', { search: t, 'per-page': 1 }, email, apiKey);
  const w = j?.results?.[0];
  if (!w) throw new Error(`no OpenAlex work matches "${truncate(t, 80)}"`);
  return w;
}

// ── Single-work DETAIL (the free replacement for a billed S2 detail call) ────
//
// WHY THIS EXISTS. `get_semantic_paper_detail` was the single most expensive
// tool in this machine's history: 60 calls / 60 credits, 31% of all billed
// spend, and 15 of them were CONSECUTIVE calls that a single batch would have
// answered for 2 credits. OpenAlex carries the same metadata for free, so the
// detail lookup belongs here rather than behind a credit meter.
//
// WHAT OPENALEX DOES *NOT* HAVE, and therefore what this cannot return:
//   · the Semantic Scholar `paperId` / `corpusId` / S2 URL — those exist only
//     in S2's own graph. A caller that needs to chain into another S2 tool must
//     still resolve the paper there.
//   · citation CONTEXTS and INTENTS (the sentence that cites, and whether the
//     citation is background/method/result). OpenAlex stores only the edge.
//   · SPECTER2 embeddings and TLDR summaries.
// Everything else — title, authors, year, date, venue, citation count, DOI,
// PMID, PMCID, abstract, OA locations, topics, retraction flag — is here.

/**
 * The fields a detail reply needs. `select` is not cosmetic: a full OpenAlex
 * work carries 59 fields (measured 23 Nov 2026), most of them irrelevant to a
 * reader, and the abstract alone can be several kB.
 */
const DETAIL_FIELDS = [
  'id', 'doi', 'title', 'display_name', 'publication_year', 'publication_date',
  'type', 'cited_by_count', 'authorships', 'primary_location', 'best_oa_location',
  'locations', 'open_access', 'ids', 'abstract_inverted_index',
  'referenced_works_count', 'is_retracted', 'language', 'biblio',
  'topics', 'keywords', 'fwci', 'citation_normalized_percentile',
].join(',');

/**
 * Parse ONE identifier into the OpenAlex filter prefix it belongs to.
 *
 * Returns `{ prefix, value }` or `null` when the input is not an identifier at
 * all (a title, say) — the caller then falls back to a search.
 *
 * The five prefixes are the ones OpenAlex actually accepts in `filter=`. They
 * were each verified against the live API on 23 Nov 2026:
 *   doi:10.3390/info15060294|10.1038/…      -> 200, 2 works
 *   pmid:37074525|36568739                  -> 200, 2 works
 *   pmcid:PMC8371605|PMC10113978            -> 200, 2 works
 *   arxiv:1706.03762|2106.12345             -> 200, 2 works
 *   openalex_id:W3177828909|W4398222754     -> 200, 2 works
 *
 * MIXING prefixes in one filter is NOT allowed — OpenAlex answers HTTP 400
 * ("trying to do an OR query between filters"). Measured 23 Nov 2026. So a
 * mixed batch must be split into one request per prefix, which is what
 * `resolveWorks` does.
 */
export function parseIdentifier(input) {
  const t = String(input ?? '').trim();
  if (!t) return null;

  // OpenAlex id: W123, or the full https://openalex.org/W123 URL.
  if (isWorkId(t)) return { prefix: 'openalex_id', value: t.split('/').pop() };

  // Explicit prefixes the model may pass through from another tool's output.
  const explicit = /^(doi|pmid|pmcid|arxiv|openalex_id)\s*:\s*(.+)$/i.exec(t);
  if (explicit) {
    const prefix = explicit[1].toLowerCase();
    const value = explicit[2].trim();
    if (!value) return null;
    if (prefix === 'doi') return isDoi(value) ? { prefix, value: normalizeDoi(value) } : null;
    if (prefix === 'arxiv') {
      const a = isArxivId(value);
      return a ? { prefix, value: a.id } : null;
    }
    if (prefix === 'openalex_id') return isWorkId(value) ? { prefix, value: value.split('/').pop() } : null;
    // pmid / pmcid: digits, or PMC-prefixed for pmcid.
    if (prefix === 'pmcid') {
      const m = /^(?:pmc)?(\d+)$/i.exec(value);
      return m ? { prefix, value: `PMC${m[1]}` } : null;
    }
    return /^\d+$/.test(value) ? { prefix, value } : null;
  }

  // A bare DOI.
  if (isDoi(t)) return { prefix: 'doi', value: normalizeDoi(t) };

  // A bare arXiv id (1706.03762 / arXiv:1706.03762v2).
  const a = isArxivId(t);
  if (a) return { prefix: 'arxiv', value: a.id };

  // A bare PMID / PMCID is deliberately NOT guessed from digits alone: a bare
  // number is far more likely to be a year, a count, or a typo than a PMID, and
  // silently querying `pmid:2024` would return a wrong paper with no warning.
  return null;
}

/**
 * Many identifiers -> many OpenAlex works, in as few requests as possible.
 *
 * Grouped by prefix because OpenAlex rejects a mixed-prefix OR (HTTP 400,
 * measured 23 Nov 2026). At most 50 values per request — the same fence
 * `worksFromIds` uses, and well under OpenAlex's own URL limit.
 *
 * ── THE RETRACTED-WORK TRAP (found 23 Nov 2026, the hard way) ───────────────
 *
 * OpenAlex's LIST endpoint (`/works?filter=…`) **silently omits retracted
 * works** unless `is_retracted:true` is added to the filter. The single-work
 * endpoint (`/works/doi:…`) does NOT — it returns them normally.
 *
 * Measured with `10.1016/S0140-6736(20)31180-6` (the retracted
 * hydroxychloroquine Lancet paper):
 *
 *   GET /works/doi:10.1016/S0140-6736(20)31180-6        -> 200, is_retracted: true
 *   GET /works?filter=doi:10.1016/S0140-6736(20)31180-6 -> 200, count: 0
 *   GET /works?filter=openalex_id:W3027680906           -> 200, count: 0
 *   GET /works?filter=openalex_id:W3027680906,is_retracted:true -> 200, count: 1
 *
 * There are **91,863** retracted works in OpenAlex (measured the same day), and
 * every one of them was invisible to a batch lookup. That is the worst possible
 * failure mode for this tool: a retracted paper is exactly the paper a reader
 * most needs to be warned about, and the batch would have reported it as
 * "not found in OpenAlex" — which the reply explicitly says does NOT mean the
 * paper does not exist, but which a reader would reasonably read as "no record".
 *
 * FIX: every batch request asks for retracted works too, and the reply keeps
 * the `is_retracted` flag so `detailLines` can print the warning.
 *
 * Returns `{ works, requests, unresolved }`:
 *   · `works`      — the OpenAlex records that were found, in request order;
 *   · `requests`   — how many HTTP calls this actually cost (reported to the
 *                    caller so a "free" claim stays honest);
 *   · `unresolved` — the inputs OpenAlex had no record for, so the caller can
 *                    say WHICH one is missing instead of silently returning a
 *                    shorter list.
 */
export async function resolveWorks(inputs, { email, apiKey = null } = {}) {
  const parsed = [];
  const unresolved = [];
  for (const raw of inputs ?? []) {
    const p = parseIdentifier(raw);
    if (p) parsed.push({ raw, ...p });
    else unresolved.push(String(raw ?? ''));
  }

  const groups = new Map();
  for (const p of parsed) {
    if (!groups.has(p.prefix)) groups.set(p.prefix, []);
    groups.get(p.prefix).push(p);
  }

  const works = [];
  let requests = 0;
  for (const [prefix, items] of groups) {
    // De-duplicate within the group: the same DOI twice must not be fetched twice.
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const key = it.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const ids = chunk.map((c) => c.value).join('|');

      // TWO requests per chunk, and both are necessary.
      //
      // `is_retracted:true` is AND-ed with the identifier filter, NOT OR-ed —
      // measured 23 Nov 2026 with one retracted and one normal DOI:
      //   filter=doi:A|B                  -> 1 work  (the NORMAL one)
      //   filter=doi:A|B,is_retracted:true -> 1 work  (the RETRACTED one)
      // So neither request alone sees both. The first finds the ordinary works,
      // the second finds the retracted ones, and the union is the truth.
      //
      // This doubles the request count for a batch. That is the correct trade:
      // the alternative is silently reporting a retracted paper as "not found",
      // which is the one error this tool must never make.
      const found = [];
      for (const extra of ['', ',is_retracted:true']) {
        const j = await openAlexJson('/works', {
          filter: `${prefix}:${ids}${extra}`, 'per-page': chunk.length, select: DETAIL_FIELDS,
        }, email, apiKey);
        requests += 1;
        for (const w of j?.results ?? []) {
          // The two requests are disjoint by construction, but a work can be
          // returned twice if OpenAlex ever changes that — keep it once.
          if (!found.some((x) => String(x?.id) === String(w?.id))) found.push(w);
        }
      }
      works.push(...found);
      // Anything neither request returned is genuinely absent from OpenAlex.
      // Matched by the id field the prefix refers to, NOT by position: OpenAlex
      // does not promise to preserve the order of an OR filter.
      if (found.length < chunk.length) {
        for (const c of chunk) {
          if (!found.some((w) => identifierMatches(w, prefix, c.value))) unresolved.push(c.raw);
        }
      }
    }
  }
  return { works, requests, unresolved };
}

/** Does this OpenAlex work carry the given identifier? Used to detect misses. */
export function identifierMatches(work, prefix, value) {
  const v = String(value ?? '').toLowerCase();
  if (prefix === 'openalex_id') return String(work?.id ?? '').split('/').pop().toLowerCase() === v;
  if (prefix === 'doi') return normalizeDoi(work?.doi) === v;
  if (prefix === 'pmid') return String(work?.ids?.pmid ?? '').split('/').pop() === v;
  if (prefix === 'pmcid') return String(work?.ids?.pmcid ?? '').split('/').pop().toLowerCase() === v;
  if (prefix === 'arxiv') return String(work?.ids?.arxiv ?? '').split('/').pop().toLowerCase() === v;
  return false;
}

/**
 * ONE OpenAlex work -> the full detail record the model reads.
 *
 * Deliberately NOT `summarizeWork`: that shape is the compact header used by the
 * citation graph, and it drops the abstract, the ids, the topics and the OA
 * locations — exactly the fields a detail reply exists to provide.
 */
export function detailOfWork(w) {
  const ids = w?.ids ?? {};
  const shortId = (u) => (u ? String(u).split('/').pop() : null);
  const authors = (w?.authorships ?? []).map((a) => ({
    name: cleanText(a?.author?.display_name) ?? null,
    orcid: a?.author?.orcid ?? null,
    institutions: (a?.institutions ?? []).map((i) => cleanText(i?.display_name)).filter(Boolean),
    corresponding: a?.is_corresponding === true,
  })).filter((a) => a.name);

  const oa = summarizeOA(w);
  const biblio = w?.biblio ?? {};
  const percentile = w?.citation_normalized_percentile;

  return {
    id: workId(w),
    doi: normalizeDoi(w?.doi),
    title: cleanText(w?.title ?? w?.display_name),
    year: w?.publication_year ?? null,
    date: w?.publication_date ?? null,
    type: w?.type ? String(w.type).toLowerCase() : null,
    language: w?.language ?? null,
    venue: cleanText(w?.primary_location?.source?.display_name),
    publisher: cleanText(w?.primary_location?.source?.host_organization_name),
    citedBy: Number.isFinite(Number(w?.cited_by_count)) ? Number(w.cited_by_count) : null,
    // `fwci` is OpenAlex's field-weighted citation impact: 1.0 = world average
    // for that field/year. Reported as-is, never rounded into a verdict.
    fwci: Number.isFinite(Number(w?.fwci)) ? Number(w.fwci) : null,
    percentile: Number.isFinite(Number(percentile?.value)) ? Number(percentile.value) : null,
    isRetracted: w?.is_retracted === true,
    authors,
    abstract: openAlexAbstract(w?.abstract_inverted_index),
    biblio: {
      volume: biblio?.volume ?? null,
      issue: biblio?.issue ?? null,
      firstPage: biblio?.first_page ?? null,
      lastPage: biblio?.last_page ?? null,
    },
    ids: {
      openalex: workId(w),
      doi: normalizeDoi(w?.doi),
      pmid: shortId(ids?.pmid),
      pmcid: shortId(ids?.pmcid),
      arxiv: shortId(ids?.arxiv),
      mag: ids?.mag ?? null,
    },
    topics: (w?.topics ?? []).slice(0, 5).map((t) => cleanText(t?.display_name)).filter(Boolean),
    keywords: (w?.keywords ?? []).slice(0, 8).map((k) => cleanText(k?.display_name)).filter(Boolean),
    referenceCount: Number.isFinite(Number(w?.referenced_works_count)) ? Number(w.referenced_works_count) : null,
    openAccess: oa,
  };
}

/**
 * The OpenAlex fields the citation map needs. `referenced_works` MUST be there —
 * that is the input for the coupling computation — and `select` keeps the reply
 * small (measured 2 Oct 2026: ~52 kB for 50 works complete with their reference
 * lists, versus hundreds of kB without `select`).
 */
const MAP_FIELDS = 'id,doi,title,publication_year,cited_by_count,referenced_works';

/**
 * Candidates for the CITATION MAP (upstream issue #122) — works that cite the
 * seed, or the seed's references — COMPLETE with their `referenced_works`.
 *
 * Returns RAW works, not the uniform paper shape: the map needs each work's
 * reference list, and the uniform shape deliberately does not store it.
 *
 * Deliberate cost fence: at most 50 candidates and at most ONE list request
 * (those works are fetched all at once via `filter=openalex_id:W1|W2|…`,
 * not one by one).
 */
export async function mapCandidates(work, { direction = 'citing', max = 40, email, apiKey = null } = {}) {
  const id = workId(work);
  if (!id) throw new Error('this work has no OpenAlex id — the citation map cannot run');
  const limit = Math.min(Math.max(Number(max) || 40, 2), 50);

  if (direction === 'references') {
    const all = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
    const ids = all.slice(0, limit).map((x) => String(x).split('/').pop()).filter(Boolean);
    if (ids.length === 0) return { works: [], total: all.length, checked: 0, requests: 0 };
    const j = await openAlexJson('/works', { filter: `openalex_id:${ids.join('|')}`, 'per-page': ids.length, select: MAP_FIELDS }, email, apiKey);
    return { works: j?.results ?? [], total: all.length, checked: ids.length, requests: 1 };
  }

  const j = await openAlexJson('/works', { filter: `cites:${id}`, sort: 'cited_by_count:desc', 'per-page': limit, select: MAP_FIELDS }, email, apiKey);
  return { works: j?.results ?? [], total: Number(j?.meta?.count ?? 0), checked: limit, requests: 1 };
}

/**
 * Works by a list of OpenAlex ids — used to give TITLES to shared references
 * (which appear in the map only as ids). One request, at most 50 ids.
 */
export async function worksFromIds(ids, { email, apiKey = null } = {}) {
  const clean = [...new Set((ids ?? []).map((x) => String(x).split('/').pop()).filter(Boolean))].slice(0, 50);
  if (clean.length === 0) return [];
  const j = await openAlexJson('/works', { filter: `openalex_id:${clean.join('|')}`, 'per-page': clean.length, select: MAP_FIELDS }, email, apiKey);
  return j?.results ?? [];
}

/** Works that CITE a work — forward snowballing. */
export async function worksCiting(work, { rows = 10, sort = 'citations', email, apiKey = null } = {}) {
  const id = workId(work);
  if (!id) throw new Error('this work has no OpenAlex id — citation traversal cannot run');
  const order = sort === 'newest' ? 'publication_date:desc' : 'cited_by_count:desc';
  const j = await openAlexJson('/works', { filter: `cites:${id}`, sort: order, 'per-page': rows }, email, apiKey);
  const total = Number(j?.meta?.count ?? 0);
  const papers = (j?.results ?? []).map((w) => fromOpenAlexWork(w)).filter((p) => p.title);
  return {
    total,
    // `checked` is how many records this call actually looked at — NOT the
    // platform total. Reporting `total` here made a 3-row page claim it had
    // examined all 49,296 citing works, which would turn any "most cited first"
    // statement into a lie the moment a caller printed it.
    checked: papers.length,
    papers,
  };
}

/**
 * Works CITED BY a work — its reference list (backward snowballing).
 *
 * TWO LIMITS THAT MUST BE REPORTED AS THEY ARE, not hidden:
 *   1. at most `REFERENCE_LIMIT` (100) references are fetched;
 *   2. filtering/sorting happens AFTER fetching, so "most cited" only holds
 *      among the ones that were checked.
 */
export async function worksCited(work, { rows = 10, sort = 'citations', email, apiKey = null } = {}) {
  const all = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
  const taken = all.slice(0, REFERENCE_LIMIT).map((x) => String(x).split('/').pop()).filter(Boolean);
  if (taken.length === 0) return { total: all.length, checked: 0, papers: [] };

  const collected = [];
  for (let i = 0; i < taken.length; i += 50) {
    const j = await openAlexJson('/works', {
      filter: `openalex_id:${taken.slice(i, i + 50).join('|')}`,
      'per-page': 50,
    }, email, apiKey);
    collected.push(...(j?.results ?? []));
  }

  const papers = collected
    .map((w) => fromOpenAlexWork(w))
    .filter((p) => p.title)
    .sort((a, b) => (sort === 'newest'
      ? (b.year ?? 0) - (a.year ?? 0)
      : (b.citedBy ?? -1) - (a.citedBy ?? -1)));

  return { total: all.length, checked: taken.length, papers: papers.slice(0, rows) };
}

/**
 * The open-access copy of a work. Pure (no network) so it can be tested
 * without calling the API.
 *
 * Measured OpenAlex location fields: `is_oa, pdf_url, landing_page_url, license,
 * version, source.display_name` — duplicate locations are dropped by URL.
 */
export function summarizeOA(work) {
  const oa = work?.open_access ?? {};
  const locations = [];
  const seen = new Set();
  for (const l of work?.locations ?? []) {
    if (!l?.is_oa) continue;
    const url = l.pdf_url || l.landing_page_url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    locations.push({
      pdf: l.pdf_url ?? null,
      landing: l.landing_page_url ?? null,
      license: l.license ?? null,
      version: l.version ?? null,
      source: l.source?.display_name ?? null,
    });
    if (locations.length >= 10) break;
  }
  return { isOa: !!oa.is_oa, status: oa.oa_status ?? null, oaUrl: oa.oa_url ?? null, locations };
}

// ── arXiv fallback (upstream PR #124) ────────────────────────────────────────
//
// PR #124 adds arXiv to the OA repository fallback chain: an arXiv copy is
// often the only free version of a DOI-bearing paper that is not OA.
//
// WHAT WAS MEASURED 29 Sep 2026, and the shape of it determines the code below:
//   - OpenAlex does **not** store an arXiv id (`ids` only has openalex/doi/mag), so
//     the id has to be derived from the DOI `10.48550/arXiv.<id>` or from a location URL;
//   - if there is none, the arXiv version is searched **by TITLE** — and that is
//     where the danger is: a loose filter accepts a DIFFERENT paper. Measured with
//     a "contains" rule: the title *"Attention Is All You Need"* also accepted
//     *"Not All Attention Is All You Need"* and *"Element-wise Attention Is
//     All You Need"*. That is why `titleSimilarity()` below is **strict**: exactly
//     equal after normalization, or contained with a length ratio >= 0.92.

function normalizeTitle(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 1 = titles exactly equal after normalization · 0.95 = contained but nearly as long · 0 = not similar. */
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length >= 20 && longer.includes(shorter) && shorter.length / longer.length >= 0.92) return 0.95;
  return 0;
}

/** Acceptance threshold for an arXiv match. Strict on purpose — see the note above. */
export const ARXIV_TITLE_THRESHOLD = 0.9;

/**
 * Metadata for one arXiv work from its ID (`1706.03762` or `1706.03762v7`).
 * Used when the user gives an arXiv id directly — without this its title is
 * unknown and the report only says "arXiv:1706.03762".
 */
export async function arxivWork(id) {
  const clean = String(id ?? '').trim();
  if (!clean) return null;
  await arxivWait();
  try {
    const xml = await getText(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(clean)}&max_results=1`,
      { accept: 'application/atom+xml' },
    );
    return parseArxiv(xml, 1)[0] ?? null;
  } finally {
    arxivLastRequest = Date.now();
  }
}

/** Is the input shaped like an arXiv id (`1706.03762`, `arXiv:1706.03762v2`)? */
export function isArxivId(t) {
  const m = /^(?:arxiv[:/\s]*)?(\d{4}\.\d{4,5})(v\d+)?$/i.exec(String(t ?? '').trim());
  return m ? { id: m[1] + (m[2] ?? '') } : null;
}
/** arXiv id from an arxiv.org URL (abs or pdf). */
export function arxivIdFromUrl(url) {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/** arXiv id ALREADY listed on the OpenAlex work — no search needed. */
export function arxivIdFromWork(work) {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(normalizeDoi(work?.doi) ?? '');
  if (m) return m[1];
  for (const l of work?.locations ?? []) {
    const id = arxivIdFromUrl(l?.pdf_url) ?? arxivIdFromUrl(l?.landing_page_url);
    if (id) return id;
  }
  return null;
}

/**
 * Find an arXiv match from the TITLE. `null` = nothing similar enough.
 * Deliberately uses the same arXiv rate driver as a normal search
 * (their TOU: 1 request / 3 seconds).
 */
export async function arxivMatch(title, { rows = 5 } = {}) {
  const t = String(title ?? '').trim();
  if (t.length < 8) return null;
  await arxivWait();
  let result;
  try {
    // The title is interpolated into arXiv's query syntax, where a double quote
    // closes the `ti:"…"` phrase and `OR`/`AND` become operators. Measured: the
    // title `Attention" OR all:"x` produced
    // `search_query=ti:"Attention" OR all:"x"`, which searches something else
    // entirely — and the wrong paper would then be reported as "the arXiv
    // version of this one". Strip the syntax characters instead of escaping
    // them: arXiv has no escape sequence for a quote inside a phrase.
    const safe = t.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
    result = await fetchArxiv(`ti:"${safe}"`, rows);
  } finally {
    arxivLastRequest = Date.now();
  }
  for (const p of result) {
    const score = titleSimilarity(t, p.title);
    if (score < ARXIV_TITLE_THRESHOLD) continue;
    const id = arxivIdFromUrl(p.url);
    if (id) return { id, title: p.title, year: p.year, score, exact: score === 1 };
  }
  return null;
}

async function doaj(query, { rows, doajApiKey }) {
  // The DOAJ query lives in the PATH, not in the query string.
  //
  // `DOAJ_API_KEY` was read from the credentials store and passed all the way
  // here — and then IGNORED. Measured 23 Nov 2026: the request with a key and the
  // request without one were byte-identical, so the documented "raises DOAJ's
  // hourly limit" never happened. DOAJ takes the key as an `api_key` query
  // parameter (verified: the endpoint answers 200 with and without it, so a
  // wrong key cannot be detected from the status alone).
  const u = new URL(`https://doaj.org/api/search/articles/${encodeURIComponent(query)}`);
  u.searchParams.set('pageSize', String(rows));
  if (doajApiKey) u.searchParams.set('api_key', String(doajApiKey));
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((r) => {
    const b = r.bibjson ?? {};
    return makePaper({
      title: b.title,
      authors: authorList(b.author),
      year: b.year,
      source: 'doaj',
      doi: (b.identifier ?? []).find((x) => x.type === 'doi')?.id,
      url: (b.link ?? []).find((x) => x.type === 'fulltext')?.url,
      journal: b.journal?.title,
      abstract: b.abstract,
      openAccess: true,
    });
  }).filter((p) => p.title);
}

async function europepmc(query, { rows, kind = null }) {
  // Preprint push-down: Europe PMC marks preprints with `SRC:PPR`.
  // Measured 1 Oct 2026 — "digital literacy AND SRC:PPR" → 2,775 results;
  // "digital literacy AND NOT SRC:PPR" → 85,096. This addition ONLY happens
  // when preprints are actually requested via `kind`; there is no "NOT" logic
  // that could silently drop results.
  const extra = (kind ?? []).includes('preprint') ? ' AND SRC:PPR' : '';
  const u = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query + extra)}&format=json&pageSize=${rows}`;
  const j = await getJson(u);
  return (j?.resultList?.result ?? []).map((r) => makePaper({
    title: r.title,
    // DOAJ gives an `authorString` that IS comma-separated ("A, B, C"), so the
    // splitting is done here first — `authorList` itself deliberately does not
    // split commas, so that "TAN, Kwan Hong" (one author) is not corrupted.
    authors: authorList((r.authorString ?? '').split(/,\s*/)),
    year: r.pubYear,
    source: 'europepmc',
    doi: r.doi,
    url: r.doi ? `https://doi.org/${r.doi}` : `https://europepmc.org/article/${r.source ?? 'MED'}/${r.id}`,
    journal: r.journalTitle,
    abstract: r.abstractText,
    openAccess: r.isOpenAccess === 'Y',
  })).filter((p) => p.title);
}

async function pubmed(query, { rows }) {
  // E-utilities needs TWO calls: esearch (ids) then esummary (metadata).
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const s = await getJson(`${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${rows}&sort=relevance&term=${encodeURIComponent(query)}`);
  const ids = s?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const d = await getJson(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`);
  return ids.map((id) => {
    const r = d?.result?.[id];
    if (!r) return null;
    return makePaper({
      title: r.title,
      authors: authorList(r.authors),
      year: String(r.pubdate ?? '').slice(0, 4),
      source: 'pubmed',
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      journal: r.fulljournalname || r.source,
    });
  }).filter((p) => p && p.title);
}

// arXiv asks for NO MORE than 1 request / 3 seconds (their TOU). Because the
// sources run in parallel, arXiv requests are serialized here on their own.
//
// ── THE RACE THIS USED TO HAVE (fixed 23 Nov 2026) ──────────────────────────
//
// The old version read `arxivLastRequest`, awaited the delay, then wrote the
// timestamp. Between the read and the write, every other caller saw the SAME
// stale value and computed the SAME delay — so they all woke up together.
// Measured with three concurrent arXiv searches: the gaps between requests were
// 3003 ms, **0 ms**, **69 ms**, 2933 ms, **1 ms** — five violations of the TOU
// in one batch, which is exactly the behaviour that gets an IP blocked.
//
// The fix is a promise CHAIN: each caller appends itself to the previous one, so
// the wait and the timestamp update happen inside the same critical section and
// no two callers can observe the same "last request" value.
let arxivChain = Promise.resolve();
let arxivLastRequest = 0;
const ARXIV_MIN_INTERVAL_MS = 3000;

function arxivWait() {
  const turn = arxivChain.then(async () => {
    const delay = ARXIV_MIN_INTERVAL_MS - (Date.now() - arxivLastRequest);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    arxivLastRequest = Date.now();
  });
  // Keep the chain alive even if a caller's own work throws later.
  arxivChain = turn.catch(() => {});
  return turn;
}

/** Parse the arXiv Atom feed into a list of papers. */
function parseArxiv(xml, rows) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? r[1] : null;
    };
    out.push(makePaper({
      title: pick('title'),
      authors: [...block.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((x) => x[1]),
      year: String(pick('published') ?? '').slice(0, 4),
      source: 'arxiv',
      doi: pick('arxiv:doi'),
      url: pick('id'),
      journal: 'arXiv (preprint)',
      abstract: pick('summary'),
      openAccess: true,
    }));
  }
  return out.filter((p) => p.title).slice(0, rows);
}

/**
 * Fetch the arXiv Atom feed, with TWO fixes taken from upstream issues:
 *
 * 1. **HTTP 406 sometimes still carries a VALID feed** (issue #121). Reported
 *    as measured: a 406 with a 5250-byte body and `Content-Type: application/atom+xml`
 *    containing 2 entries. So a 406 is not failed outright — its content is tried
 *    first. If the body really is empty, only then is it a genuine failure.
 * 2. **A multi-word query without quotes can HANG** on the arXiv backend
 *    (issue #101). That is why the precise form is used first (see `arxiv`).
 */
async function fetchArxiv(query, rows) {
  const u = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=${rows}&sortBy=relevance`;
  try {
    return parseArxiv(await getText(u, { accept: 'application/atom+xml' }), rows);
  } catch (e) {
    if (e.status === 406 && /<entry>/.test(e.fullBody ?? '')) return parseArxiv(e.fullBody, rows);
    throw e;
  }
}

/**
 * The arXiv query shape. Precise first (`all:word1 AND all:word2`), loose
 * (`all:word1 word2`) as a fallback.
 *
 * Why NOT simply copy the upstream fix that quotes the phrase:
 * **measured 28 Sep 2026** — for the Indonesian query `"literasi digital"`, the
 * quoted form and the AND form both gave **0 results**, while the loose form gave
 * **50**. arXiv is indeed an English-language corpus. Blind quoting would wipe out
 * ALL results for non-English topics, so what is used is precise-with-fallback,
 * not quote-blindly.
 *
 * ── SYNTAX INJECTION (fixed 23 Nov 2026) ────────────────────────────────────
 *
 * The user's `query` is interpolated into arXiv's query language, where `"`,
 * `(`, `)`, `[`, `]`, `:` and the bare words `AND`/`OR`/`ANDNOT` are OPERATORS.
 * Measured: the query `Attention" OR all:"x` produced
 *
 *   search_query=all:Attention" OR all:"x
 *
 * which is a different search entirely — and its results would then be reported
 * as the answer to the user's query. `arxivMatch()` already stripped these
 * characters from a TITLE (that was the earlier fix); the SEARCH path did not.
 *
 * The characters are REMOVED rather than escaped: arXiv has no escape sequence
 * for a quote inside a phrase, so there is nothing to escape into. Removing them
 * keeps the words, which is what a search is for.
 */
export function arxivQuery(query, precise) {
  // Strip the query-language metacharacters, then collapse the whitespace they
  // leave behind. `:` goes too — `all:ti:foo` is a nested field expression.
  const cleaned = String(query ?? '').replace(/["\\()[\]{}:]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  // Nothing searchable left (empty query, or only metacharacters). Return null so
  // the caller can skip the request instead of sending a query that cannot match.
  if (words.length === 0) return null;
  // A bare AND/OR/ANDNOT is an operator, not a search term. Dropping it is the
  // only reading that keeps the query meaningful.
  const terms = words.filter((w) => !/^(and|or|andnot|not)$/i.test(w));
  if (terms.length === 0) return `all:${words[0]}`;
  if (terms.length === 1) return `all:${terms[0]}`;
  return precise ? terms.map((k) => `all:${k}`).join(' AND ') : `all:${terms.join(' ')}`;
}

async function arxiv(query, { rows }) {
  // `arxivQuery` returns null when nothing searchable survives sanitization
  // (empty query, or only metacharacters). Sending `all:""` would be a request
  // that cannot match anything, so it is skipped — and skipping costs no request.
  const precise = arxivQuery(query, true);
  if (precise === null) return [];

  await arxivWait();
  let result;
  try {
    result = await fetchArxiv(precise, rows);
  } finally {
    arxivLastRequest = Date.now();
  }
  if (result.length > 0) return result;

  // Loose fallback. Only run when the precise form is genuinely empty,
  // so that arXiv requests stay frugal (their TOU: 1 request / 3 seconds).
  const loose = arxivQuery(query, false);
  if (loose === null) return [];
  await arxivWait();
  try {
    return await fetchArxiv(loose, rows);
  } finally {
    arxivLastRequest = Date.now();
  }
}

async function semantic(query, { rows, semanticApiKey }) {
  const u = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${rows}&fields=title,year,authors,externalIds,venue,abstract,openAccessPdf`;
  // `semanticApiKey`, NOT `apiKey`: the shared options object now carries
  // OpenAlex's key under `apiKey`, and reading that here would send an OpenAlex
  // key to Semantic Scholar as `x-api-key` — a credential leak to a third party.
  const j = await getJson(u, semanticApiKey ? { headers: { 'x-api-key': semanticApiKey } } : {});
  return (j?.data ?? []).map((d) => makePaper({
    title: d.title,
    authors: authorList(d.authors),
    year: d.year,
    source: 'semantic',
    doi: d.externalIds?.DOI,
    url: d.openAccessPdf?.url || (d.externalIds?.DOI ? `https://doi.org/${d.externalIds.DOI}` : null),
    journal: d.venue,
    abstract: d.abstract,
    openAccess: !!d.openAccessPdf,
  })).filter((p) => p.title);
}

/** Some APIs return a field that can be either a single value OR an array. */
function first(x) {
  return Array.isArray(x) ? x[0] : x;
}

async function pmc(query, { rows }) {
  // PubMed Central uses the same E-utilities as PubMed:
  // esearch (ids) then esummary (metadata).
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const s = await getJson(`${base}/esearch.fcgi?db=pmc&retmode=json&retmax=${rows}&sort=relevance&term=${encodeURIComponent(query)}`);
  const ids = s?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const d = await getJson(`${base}/esummary.fcgi?db=pmc&retmode=json&id=${ids.join(',')}`);
  return ids.map((id) => {
    const r = d?.result?.[id];
    if (!r) return null;
    const pmcid = (r.articleids ?? []).find((a) => a.idtype === 'pmcid')?.value ?? `PMC${id}`;
    return makePaper({
      title: r.title,
      authors: authorList(r.authors),
      year: String(r.pubdate ?? '').slice(0, 4),
      source: 'pmc',
      doi: (r.articleids ?? []).find((a) => a.idtype === 'doi')?.value,
      url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
      journal: r.fulljournalname || r.source,
      openAccess: true,
    });
  }).filter((p) => p && p.title);
}

async function core(query, { rows, coreApiKey }) {
  // CORE CANNOT be used without a key: measured 28 Sep 2026, a request without
  // `Bearer` is answered with HTTP 429 and an EMPTY body — not 401. That is why a
  // missing key is reported as an actionable message, instead of being
  // left as a confusing 429.
  if (!coreApiKey) {
    throw new Error('CORE_API_KEY is required — without a key CORE answers HTTP 429 with an empty body');
  }
  const j = await getJson(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${rows}`, {
    headers: { Authorization: `Bearer ${coreApiKey}` },
  });
  return (j?.results ?? []).map((c) => makePaper({
    title: c.title,
    authors: authorList(c.authors),
    year: c.yearPublished,
    source: 'core',
    doi: c.doi,
    url: c.downloadUrl || (c.doi ? `https://doi.org/${c.doi}` : null),
    journal: c.publisher,
    abstract: c.abstract,
    openAccess: !!c.downloadUrl,
  })).filter((p) => p.title);
}

async function zenodo(query, { rows }) {
  const j = await getJson(`https://zenodo.org/api/records?q=${encodeURIComponent(query)}&size=${rows}`);
  return (j?.hits?.hits ?? []).map((z) => makePaper({
    title: z.metadata?.title,
    authors: authorList(z.metadata?.creators),
    year: String(z.metadata?.publication_date ?? '').slice(0, 4),
    source: 'zenodo',
    doi: z.metadata?.doi ?? z.doi,
    url: z.links?.self_html ?? z.links?.self,
    journal: z.metadata?.imprint?.publisher ?? 'Zenodo',
    abstract: z.metadata?.description,
    openAccess: true,
  })).filter((p) => p.title);
}

async function hal(query, { rows }) {
  const fl = 'title_s,authFullName_s,producedDateY_i,doiId_s,uri_s,journalTitle_s,abstract_s';
  const j = await getJson(`https://api.archives-ouvertes.fr/search/?q=${encodeURIComponent(query)}&wt=json&rows=${rows}&fl=${fl}`);
  return (j?.response?.docs ?? []).map((a) => makePaper({
    title: first(a.title_s),
    authors: authorList(a.authFullName_s),
    year: a.producedDateY_i,
    source: 'hal',
    doi: first(a.doiId_s),
    url: first(a.uri_s),
    journal: first(a.journalTitle_s),
    abstract: first(a.abstract_s),
    openAccess: true,
  })).filter((p) => p.title);
}

/** IACR Cryptology ePrint Archive — the cryptology preprint archive (HTML). */
async function iacr(query, { rows }) {
  const html = await getText(`https://eprint.iacr.org/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const links = [...html.matchAll(/<a title="(\d{4}\/\d+)" class="paperlink" href="\/(\d{4}\/\d+)"/g)];
  if (links.length === 0) {
    if (!/class="paperlink"/.test(html)) throw new Error('IACR markup changed: links with class "paperlink" are no longer found');
    return [];
  }
  const out = [];
  for (let i = 0; i < links.length && out.length < rows; i++) {
    // Slice per result using the next link's position as the boundary, so the
    // regex does not cross into another result.
    const block = html.slice(links[i].index, i + 1 < links.length ? links[i + 1].index : html.length);
    const pick = (re) => { const m = re.exec(block); return m ? m[1] : null; };
    const id = links[i][1];
    out.push(makePaper({
      title: pick(/<strong>([\s\S]*?)<\/strong>/),
      authors: authorList((pick(/<span class="fst-italic">([\s\S]*?)<\/span>/) ?? '').split(/,\s*/)),
      year: id.slice(0, 4),
      source: 'iacr',
      url: `https://eprint.iacr.org/${id}`,
      journal: 'IACR Cryptology ePrint Archive',
      abstract: pick(/<p class="mb-0 mt-1 search-abstract">([\s\S]*?)<\/p>/),
      openAccess: true,
    }));
  }
  return out.filter((p) => p.title);
}

/**
 * Unpaywall — an open-access finder **by DOI**, NOT a keyword
 * search engine. Verified 28 Sep 2026: with a DOI it answers HTTP 200 and
 * finds the paper; with a keyword it genuinely returns 0.
 *
 * A query that is not a DOI is returned EMPTY WITHOUT an error — that is not a
 * failure, that is how it works. If this were thrown as an error, every keyword
 * search would write a fake FAILED line.
 */
async function unpaywall(query, { rows, email }) {
  const doi = normalizeDoi(query);
  if (!doi) return [];
  if (!email) throw new Error('UNPAYWALL_EMAIL is required — Unpaywall rejects requests without an email');
  const j = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`);
  if (!j?.title) return [];
  const oa = j.best_oa_location ?? null;
  const result = makePaper({
    title: j.title,
    authors: authorList(j.z_authors),
    year: j.year,
    source: 'unpaywall',
    doi: j.doi ?? doi,
    url: oa?.url_for_pdf ?? oa?.url ?? (j.doi ? `https://doi.org/${j.doi}` : null),
    journal: j.journal_name,
    openAccess: !!j.is_oa,
  });
  return result.title ? [result].slice(0, Math.max(1, Math.min(rows, 1))) : [];
}

// ── INDONESIAN sources (HTML parsing) ────────────────────────────────────────
//
// The patterns below were MEASURED directly from their live pages (28 Sep 2026),
// not guessed. If an operator changes the markup, the source will report 0
// results — and that will be visible, not disguised, because we keep `error`
// separate from `papers` (see `searchSource`).

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function collectHtml(html, pattern, limit) {
  const out = [];
  for (const m of html.matchAll(pattern)) {
    if (out.length >= limit) break;
    out.push(m);
  }
  return out;
}

/**
 * When the result marker is not found, there are THREE DIFFERENT possibilities:
 *   1. the portal answers "zero results"  -> `[]`, that is a VALID result
 *   2. the portal markup changed          -> error
 *   3. the portal blocks/redirects        -> error
 *
 * Before this, (1) and (2) were treated the same, so a genuinely empty portal
 * was reported as **FAILED**. That is wrong in the opposite direction:
 * reporting a failure when the result is perfectly validly empty — just as
 * misleading as hiding a failure.
 *
 * The zero-result markers were measured 28 Sep 2026 using a nonsense query, then
 * compared against a query that has results:
 *
 *   Garuda : "Found 0 documents"                (page 11,181 characters)
 *   Sinta  : the `Results for "<q>"` header is still there, zero profile links
 *            (page 34,063 characters) — Sinta does NOT write an empty message
 *   IOS    : "No Results!"                      (page 23,041 characters)
 */
function portalHasNoResults(html, ...markers) {
  return markers.some((re) => re.test(html));
}

const GARUDA_BASE = 'https://garuda.kemdiktisaintek.go.id';

/** Garuda — index of Indonesian journal articles (Kemdiktisaintek). */
async function garuda(query, { rows }) {
  const html = await getText(`${GARUDA_BASE}/documents?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const pattern = /<a[^>]*class="title-article"[^>]*href="\/documents\/detail\/(\d+)"[^>]*>\s*<xmp>([\s\S]*?)<\/xmp>/g;
  const result = collectHtml(html, pattern, rows).map((m) => makePaper({
    title: m[2],
    source: 'garuda',
    url: `${GARUDA_BASE}/documents/detail/${m[1]}`,
    journal: 'Garuda (Indonesian journal)',
    openAccess: true,
  })).filter((p) => p.title);
  // HTML parsing that finds not a single pattern can mean TWO opposite things.
  // Tell them apart: Garuda writes "Found 0 documents" when it really is empty.
  if (result.length === 0 && !/title-article/.test(html)) {
    if (portalHasNoResults(html, /Found\s+0\s+document/i)) return [];
    throw new Error('Garuda markup changed: the "title-article" marker is no longer found');
  }
  return result;
}

/** Sinta — list of ACCREDITED Indonesian JOURNALS (not articles). */
async function sinta(query, { rows }) {
  const html = await getText(`https://sinta.kemdiktisaintek.go.id/journals?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA_BROWSER } });
  const pattern = /href="https:\/\/sinta\.kemdiktisaintek\.go\.id\/journals\/profile\/(\d+)"[^>]*>([\s\S]{3,220}?)<\/a>/g;
  const result = collectHtml(html, pattern, rows).map((m) => makePaper({
    title: m[2],
    source: 'sinta',
    url: `https://sinta.kemdiktisaintek.go.id/journals/profile/${m[1]}`,
    journal: 'Sinta (accredited journals)',
    openAccess: true,
  })).filter((p) => p.title);
  // Sinta does NOT write an empty message — it still shows the
  // `Results for "<query>"` header followed by an empty list. So that header is
  // what is used as proof that "the page loaded, the result really is zero".
  // (Sinta lists JOURNALS, not articles, so a specific query is often zero.)
  if (result.length === 0 && !/journals\/profile\//.test(html)) {
    if (portalHasNoResults(html, /Results for/i)) return [];
    throw new Error('Sinta markup changed: "journals/profile" links are no longer found');
  }
  return result;
}

/** IOS OneSearch — Indonesian repository aggregator (Perpusnas). */
async function ios(query, { rows }) {
  const html = await getText(`https://onesearch.id/Search/Results?lookfor=${encodeURIComponent(query)}&type=AllFields`, { headers: { 'User-Agent': UA_BROWSER } });
  const pattern = /<a[^>]*href="\/Record\/([^"]+)"[^>]*class="title"[^>]*>([\s\S]*?)<\/a>/g;
  const result = collectHtml(html, pattern, rows).map((m) => makePaper({
    title: m[2],
    source: 'ios',
    url: `https://onesearch.id/Record/${m[1]}`,
    journal: 'IOS OneSearch (Indonesian repository)',
    openAccess: true,
  })).filter((p) => p.title);
  if (result.length === 0 && !/class="title"/.test(html)) {
    if (portalHasNoResults(html, /No Results!/i)) return [];
    throw new Error('IOS markup changed: result links with class "title" are no longer found');
  }
  return result;
}

// ── Registry ─────────────────────────────────────────────────────────────────

// ── Sources born from upstream issues/PRs (0.2.0) ───────────────────────────

/** DOI inside OpenReview BibTeX — used so the SAME work also gets deduped. */
function doiFromBibtex(bib) {
  const m = /doi\s*=\s*[{"]([^}"]+)[}"]/i.exec(String(bib ?? ''));
  return m?.[1]?.trim() ?? null;
}

/**
 * OpenReview (upstream issue #83) — ML conference venue: ICLR, NeurIPS, ICML.
 * **Without an API key.**
 *
 * The shape that WORKS, measured 1 Oct 2026:
 *   `GET api2.openreview.net/notes/search?term=<q>&content=all&source=forum&limit=N`
 * The generic `/notes` endpoint is instead answered with **HTTP 403
 * `ChallengeRequiredError`** (bot verification), so do NOT use it; only
 * `notes/search` gets through without a challenge. A `query=` parameter is also
 * rejected: the parameter is named `term`.
 *
 * TWO author shapes appear in the field and both are real: an array of STRINGS
 * (ICLR submissions) and an array of `{fullname}` objects (ORCID/DBLP records).
 * `authorList` handles both — the `fullname` shape was once NOT recognized and
 * author names were silently lost, then fixed together with this source.
 *
 * `pdf` can be a relative path (`/pdf/<hash>.pdf`) or an external URL (IEEE);
 * the relative one is completed against openreview.net. Many ICLR works only have
 * a copy here — not in Crossref nor OpenAlex.
 */
async function openreview(query, { rows }) {
  const u = new URL('https://api2.openreview.net/notes/search');
  u.searchParams.set('term', query);
  u.searchParams.set('content', 'all');
  u.searchParams.set('source', 'forum');
  u.searchParams.set('limit', String(rows));
  const j = await getJson(u.toString());
  return (j?.notes ?? [])
    .map((n) => {
      const c = n.content ?? {};
      const value = (k) => (c[k] && typeof c[k] === 'object' ? c[k].value : c[k]);
      const pdf = value('pdf');
      const pdfLink = typeof pdf === 'string' && pdf.startsWith('/') ? `https://openreview.net${pdf}` : (pdf ?? null);
      const invitations = JSON.stringify(n.invitations ?? n.invitation ?? '');
      const pdate = Number(value('pdate') ?? value('cdate') ?? n.pdate ?? n.cdate);
      const title = value('title');
      const venue = value('venue') ?? value('venueid');
      return makePaper({
        title,
        authors: authorList(value('authors') ?? value('authorids')),
        year: Number.isFinite(pdate) && pdate > 0 ? new Date(pdate).getUTCFullYear() : null,
        source: 'openreview',
        doi: doiFromBibtex(value('_bibtex')),
        url: pdfLink ?? `https://openreview.net/forum?id=${encodeURIComponent(n.forum ?? n.id ?? '')}`,
        // In ORCID/DBLP records, the `venue` field sometimes contains the TITLE
        // ITSELF (measured 1 Oct 2026). Showing it would repeat the title on the
        // venue line — so it is treated as "not reported".
        journal: cleanText(venue) && cleanText(venue) !== cleanText(title) ? venue : null,
        abstract: value('abstract'),
        // The kind marker is taken from a fact the API reports, not a guess:
        // a note that came in through the "…/-/Submission" track is a conference paper.
        type: /\/-\/Submission/i.test(invitations) ? 'article' : null,
      });
    })
    .filter((p) => p.title);
}

/**
 * SSRN (upstream PR #60) — **via OpenAlex**, not by scraping their site.
 *
 * Why not scrape: `ssrn.com` rejects ordinary requests (**HTTP 403**), which is
 * why SSRN used to be on the "deliberately unused" list. But all SSRN works are
 * indexed by OpenAlex as ONE source — `S4210172589`,
 * "SSRN Electronic Journal", **1,656,021 works** — so it can be searched with an
 * ordinary filter, without fetching a single SSRN page.
 *
 * Measured 1 Oct 2026: `search=digital literacy` + that source filter answered
 * **3,836 works**; examples of real results also appeared on the first page.
 *
 * Its value for economics/law/business: many SSRN preprints are not in
 * Crossref, so they would never show up through another source.
 */
const SSRN_OPENALEX_ID = 'S4210172589';

/**
 * A source whose content is ONE OpenAlex repository — the same path for
 * SSRN (0.2.0), bioRxiv, and medRxiv (0.3.0).
 *
 * Why it is done this way: all three demand special treatment when taken
 * directly — ssrn.com rejects ordinary requests (403), bioRxiv/medRxiv have no
 * keyword search at all (only date/category ranges) — whereas the entire content
 * of all three is already indexed by OpenAlex as one source. So we use an API we
 * ALREADY use: no new scraper, no key, and the `min_citations`/`kind` push-down
 * works for free.
 *
 * Measured 1 Oct 2026: bioRxiv `S4306402567` 345,976 works ("digital literacy"
 * 159; + preprint kind & citations>4 → 141) · medRxiv `S3005729997` 87,941 works
 * ("digital literacy" 1,352) · SSRN 1,656,021 works.
 */
async function openAlexRepository(query, { rows, email, apiKey = null, minCitations = null, kind = null }, sourceId, source) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', query);
  u.searchParams.set('per-page', String(rows));
  const filter = [`primary_location.source.id:${sourceId}`];
  if (Number.isFinite(minCitations) && minCitations > 0) filter.push(`cited_by_count:>${Math.max(0, Math.floor(minCitations) - 1)}`);
  const t = (kind ?? []).filter((j) => ['article', 'review', 'preprint'].includes(j));
  if (t.length) filter.push(`type:${t.join('|')}`);
  u.searchParams.set('filter', filter.join(','));
  if (email) u.searchParams.set('mailto', email);
  if (apiKey) u.searchParams.set('api_key', String(apiKey));
  const j = await getJson(u.toString());
  return (j?.results ?? []).map((w) => fromOpenAlexWork(w, source)).filter((p) => p.title);
}

const ssrn = (query, options) => openAlexRepository(query, options, SSRN_OPENALEX_ID, 'ssrn');
const biorxiv = (query, options) => openAlexRepository(query, options, 'S4306402567', 'biorxiv');
const medrxiv = (query, options) => openAlexRepository(query, options, 'S3005729997', 'medrxiv');

/**
 * ChemRxiv (0.3.1) — chemistry preprints, also via OpenAlex.
 *
 * OpenAlex source `S4393918830` holds **64,495** works; "catalysis" gives
 * **13,594** real results (measured 2 Oct 2026).
 *
 * WHY NOT THEIR SITE: chemrxiv.org replies with **HTTP 403** and a Cloudflare
 * page ("Just a moment...") — measured 2 Oct 2026, both for its search page and
 * for its API gateway. The upstream module takes HTML from there, so that path
 * would be blocked; this OpenAlex path is not.
 */
const chemrxiv = (query, options) => openAlexRepository(query, options, 'S4393918830', 'chemrxiv');

/**
 * IEEE — via Crossref, **without an API key**: the same trick as ACM (#123).
 *
 * Measured 1 Oct 2026: `filter=member:263` answers **136,771** works; with
 * `type:proceedings-article` **106,734**; every result carries a `10.1109/…` DOI.
 * Upstream (PR #138) still makes IEEE require a key — this path does not.
 *
 * A LIMIT DELIBERATELY NOT CLAIMED: Crossref does **not** carry IEEE abstracts
 * (measured 0 of 5 records). Its citation field IS there (5 of 5). So abstracts
 * are usually empty — better honest than invented. If the abstract is needed,
 * fetch it via `paper({ mode: 'search' })` with the `openalex` source
 * using its DOI.
 */
async function ieee(query, { rows, email, kind = null }) {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', query);
  u.searchParams.set('rows', String(rows));
  const kindFilter = crossrefFilter(kind);
  u.searchParams.set('filter', `member:263${kindFilter ? `,${kindFilter}` : ''}`);
  u.searchParams.set('select', CROSSREF_FIELDS);
  if (email) u.searchParams.set('mailto', email);
  const j = await getJson(u.toString());
  return (j?.message?.items ?? []).map((it) => fromCrossrefItem(it, 'ieee')).filter((p) => p.title);
}

export const SOURCES = [
  // International
  { id: 'crossref', label: 'Crossref', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: crossref },
  { id: 'acm', label: 'ACM DL', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: acm, note: 'ACM Digital Library via Crossref (DOI prefix 10.1145) — no key needed (upstream PR #123)' },
  { id: 'openalex', label: 'OpenAlex', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: openalex },
  { id: 'doaj', label: 'DOAJ', region: 'international', kind: 'api', credit: 'optional', fn: doaj, note: 'also covers Indonesian open-access journals' },
  { id: 'europepmc', label: 'Europe PMC', region: 'international', kind: 'api', credit: null, fn: europepmc },
  { id: 'pubmed', label: 'PubMed', region: 'international', kind: 'api', credit: null, fn: pubmed, note: 'two calls per search (esearch + esummary)' },
  { id: 'arxiv', label: 'arXiv', region: 'international', kind: 'api', credit: null, fn: arxiv, note: 'preprint; self-throttled to 1 request / 3 seconds' },
  { id: 'semantic', label: 'Semantic Scholar', region: 'international', kind: 'api', credit: 'raises rate limit', fn: semantic },
  { id: 'pmc', label: 'PubMed Central', region: 'international', kind: 'api', credit: null, fn: pmc, note: 'open-access full text; two calls per search' },
  { id: 'core', label: 'CORE', region: 'international', kind: 'api', credit: 'REQUIRED — answers 429 without a key', fn: core, note: 'open-access repository aggregator' },
  { id: 'zenodo', label: 'Zenodo', region: 'international', kind: 'api', credit: null, fn: zenodo, note: 'general-purpose repository: data, software, preprints' },
  { id: 'hal', label: 'HAL', region: 'international', kind: 'api', credit: null, fn: hal, note: 'French open-access repository' },
  { id: 'iacr', label: 'IACR ePrint', region: 'international', kind: 'html', credit: null, fn: iacr, note: 'cryptology preprint archive' },
  { id: 'openreview', label: 'OpenReview', region: 'international', kind: 'api', credit: null, fn: openreview, note: 'ML conferences (ICLR/NeurIPS/ICML) — no key needed (upstream issue #83)' },
  { id: 'ssrn', label: 'SSRN', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: ssrn, note: 'via OpenAlex, not by scraping their site, which answers 403 (upstream PR #60)' },
  { id: 'ieee', label: 'IEEE', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: ieee, note: 'via Crossref member:263 — WITHOUT an API key; Crossref does not carry IEEE abstracts' },
  { id: 'biorxiv', label: 'bioRxiv', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: biorxiv, note: 'biology preprints — via OpenAlex (repository S4306402567), not their date-range API' },
  { id: 'medrxiv', label: 'medRxiv', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: medrxiv, note: 'health preprints — via OpenAlex (repository S3005729997)' },
  { id: 'chemrxiv', label: 'ChemRxiv', region: 'international', kind: 'api', credit: 'recommended (polite pool)', fn: chemrxiv, note: 'chemistry preprints — via OpenAlex (repository S4393918830); chemrxiv.org itself answers 403 from Cloudflare' },
  { id: 'unpaywall', label: 'Unpaywall', region: 'international', kind: 'api', input: 'doi', credit: 'REQUIRED email', fn: unpaywall, note: 'needs a DOI — not a keyword search engine' },
  // Indonesia
  { id: 'garuda', label: 'Garuda', region: 'indonesia', kind: 'html', credit: null, fn: garuda, note: 'Indonesian journal articles' },
  { id: 'sinta', label: 'Sinta', region: 'indonesia', kind: 'html', credit: null, fn: sinta, note: 'list of ACCREDITED JOURNALS, not articles' },
  { id: 'ios', label: 'IOS OneSearch', region: 'indonesia', kind: 'html', credit: null, fn: ios, note: 'Indonesian repository aggregator' },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);

/**
 * Sources that are REGISTERED but NOT part of the default `all` set.
 *
 * They stay callable by name — `sources: "pmc"` still works — but a bare
 * `paper_search({ query })` no longer pays for them. Each entry records the
 * measured reason, because "off by default" without a reason is just a guess.
 *
 * `pmc` — PubMed Central. Measured 23 Nov 2026: it costs TWO requests per search
 * (esearch + esummary, the same E-utilities as PubMed) and returns a strict
 * SUBSET of what `pubmed` already returns in the same run — PMC is the
 * open-access full-text slice of PubMed. So every default search paid two extra
 * requests to NCBI for records it already had. The one thing PMC adds is the
 * full-text availability flag, which `paper_fulltext` answers directly and more
 * cheaply (one OpenAlex request).
 *
 * `ios` — Indonesia OneSearch. Measured 23 Nov 2026: the host does not answer at
 * all from this machine (`UND_ERR_CONNECT_TIMEOUT` on both https and http, after
 * 10.5 s), so every default search waited 10.5 seconds to collect zero results.
 * It is an HTML scrape with no API, so there is nothing to fall back to. The
 * other two Indonesian sources (`garuda`, `sinta`) answer in ~6 s and stay on.
 */
export const DEFAULT_OFF = ['pmc', 'ios'];

/** Ids that a bare `paper_search` runs. Explicit requests may still name any id. */
export const DEFAULT_IDS = SOURCE_IDS.filter((id) => !DEFAULT_OFF.includes(id));

export const INTERNATIONAL_IDS = SOURCES.filter((s) => s.region === 'international').map((s) => s.id);
export const INDONESIA_IDS = SOURCES.filter((s) => s.region === 'indonesia').map((s) => s.id);
export const DOI_IDS = SOURCES.filter((s) => s.input === 'doi').map((s) => s.id);

/**
 * Is this query shaped like a DOI? Used to decide whether DOI-input sources
 * (unpaywall) also run when the user picks "all".
 * Without this, every keyword search pays for one request that is certain to be
 * empty — and shows a line that explains nothing.
 */
export function isDoi(q) {
  return /^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(String(q ?? '').trim());
}

export function findSource(id) {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/**
 * Run one source. ALWAYS returns { id, papers, error, ms } —
 * never throws — so that one dead source does not cancel the
 * whole search, and its failure stays visible to the caller.
 */
export async function searchSource(id, query, opts) {
  const source = findSource(id);
  if (!source) return { id, papers: [], error: `unknown source: ${id}`, ms: 0 };
  const started = Date.now();
  try {
    const papers = await source.fn(query, opts);
    return { id, papers: Array.isArray(papers) ? papers : [], error: null, ms: Date.now() - started };
  } catch (e) {
    const message = e?.name === 'AbortError'
      ? 'timeout'
      : `${e?.message ?? 'failed'}${e?.status ? ` (HTTP ${e.status})` : ''}${e?.body ? ` — ${e.body}` : ''}`;
    return { id, papers: [], error: message, ms: Date.now() - started };
  }
}

// ── Dedup ────────────────────────────────────────────────────────────────────

const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);

/**
 * Drop duplicates: DOI first, then the normalized title.
 * `sources` records ALL sources that found that paper — so the user
 * knows a paper appeared in several databases, rather than it being hidden.
 */
export function dedup(papers) {
  const map = new Map();
  for (const p of papers) {
    // A record with neither a DOI nor a usable title cannot be identified by
    // content, so it must not share a key with every other such record.
    // Measured: `titleKey(null)` is `''`, so three distinct untitled records
    // from Zenodo/HAL/IOS collapsed into ONE survivor and the other two URLs
    // were lost. Fall back to the URL, then to the source+index, so each
    // unidentifiable record stays its own entry.
    const key = p.doi
      ? `doi:${p.doi}`
      : titleKey(p.title)
        ? `t:${titleKey(p.title)}`
        : p.url
          ? `u:${p.url}`
          : `x:${p.source}:${map.size}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...p, sources: [p.source] });
      continue;
    }
    if (!existing.sources.includes(p.source)) existing.sources.push(p.source);
    // Fill the empty fields from the other copy — do not throw the information away.
    for (const f of ['abstract', 'journal', 'doi', 'url', 'year']) {
      if (!existing[f] && p[f]) existing[f] = p[f];
    }
    if (!existing.openAccess && p.openAccess) existing.openAccess = true;
    if (p.authors?.length > (existing.authors?.length ?? 0)) existing.authors = p.authors;
    // The citation count taken is the LARGEST, not the last: one source may
    // report it while another does not (`null`), and `null` is not 0.
    if (p.citedBy != null && (existing.citedBy == null || p.citedBy > existing.citedBy)) existing.citedBy = p.citedBy;
  }
  return [...map.values()];
}
