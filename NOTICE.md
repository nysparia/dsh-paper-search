# NOTICE

## This is a fork

This repository is a fork of `dsh-paper-search` 0.4.1 by **Rasyid**
([`rasyidmmz`](https://github.com/rasyidmmz)), MIT licensed. The upstream
repository declared in the published `package.json`
(`github.com/rasyidmmz/dsh-paper-search`) returns HTTP 404, so the fork was
seeded from the npm tarball
(`dsh-paper-search-0.4.1.tgz`, sha1 `308c878ed54323c3f7d8eff7e2ef5a139b483ede`)
and that snapshot is the authoritative baseline.

Changes in this fork, all of them either translation or bug fixes:

- **Translated to English.** Every comment, identifier, and user-facing string
  was Indonesian; it is now English. Model-facing tool parameters were renamed
  too (`paksa_ulang` → `force_refresh`, `urutkan` → `sort`, `min_sitasi` →
  `min_citations`, `jenis` → `kind`, `arah` → `direction`, `analisis` →
  `analysis`, `bersihkan_cache` → `clear_cache`, `ambang_kuat` →
  `strong_threshold`, `min_bersama_kuat` → `min_shared_strong`, `max_kandidat` →
  `max_candidates`). The Indonesian values are **not** accepted as aliases.
- **`paper_status` no longer probes by default.** Probing every source measured
  122 seconds, long enough to hit a tool timeout; it is now opt-in via
  `probe: true`.
- **`collapseTitle` clamps its input.** The period search is O(n²) and ran
  before the 300-character truncation, so an oversized `title` field from a
  source stalled the whole search (100,000 characters took 12.9 s).
- **`dedup` no longer collapses untitled records.** Records with no DOI and no
  title all hashed to the same key, so three distinct untitled records became
  one survivor and the other URLs were lost.
- **`arxivMatch` strips query syntax from the title.** A title containing a
  double quote closed the `ti:"…"` phrase and injected arXiv query operators,
  which could return a different paper as "the arXiv version of this one".
- **`kind` filtering compares canonical kinds.** Substring matching kept
  `review-article` when `article` was requested, and dropped `posted-content`
  when `preprint` was requested — the latter emptied the Crossref source.
- **`worksCiting` reports `checked` honestly.** It returned the platform total
  instead of the number of records actually examined.
- **`isCacheable` matches `REQUIRED`.** The regex still tested the Indonesian
  word `WAJIB` after the registry was translated, which would have made keyed
  sources cacheable.
- **Stale guard message fixed.** The source-count guard said "not 19" while the
  registry has 23 sources.
- **`paper_detail` added (0.6.0).** A sixth tool backed by OpenAlex: metadata +
  abstract for one paper or many at once, free and keyless. It exists because
  the billed `get_semantic_paper_detail` was measured as the most expensive tool
  on the machine that prompted this fork — 60 calls / 60 credits, 31% of all
  billed spend, 15 of them consecutive calls that one batch would have answered
  for 2 credits. The batch costs two requests per identifier TYPE (one for
  ordinary works, one for retracted ones — OpenAlex's list endpoint hides
  retracted works otherwise), not one per paper. This is an **addition**, not a
  translation or a fix, and it is the only change in this fork that adds a
  capability upstream never had.
- **`pmc` and `ios` are off by default (0.6.1).** Both stay registered and
  callable by name. `pmc` costs two extra requests per search for records
  `pubmed` already returned in the same run; `ios` does not answer from this
  machine at all (connect timeout after 10.5 s), so it only cost time. A bare
  search went from 23 requests to 20. The group keywords respect the same rule,
  and `paper_status` still reports all 23 so a default-off source cannot break
  silently.

- **Security and correctness audit (0.6.2).** The SSRF guard in `lib/fulltext.js`
  was bypassable through any IPv6 address that embeds an IPv4 address
  (`::ffff:127.0.0.1`, `64:ff9b::`, `2002::/16`, Teredo) — proven against a real
  local HTTP server. It now parses and unwraps those forms. Also fixed: batch
  ordering in `paper_detail`, arXiv query injection in `paper_search`, a race in
  the arXiv throttle that violated their 1 req / 3 s TOU, cache LRU/TTL semantics,
  an ignored `DOAJ_API_KEY`, a hardcoded User-Agent version, an under-reported
  request count in the citation map, a silently dropped `identifier`, and an
  undocumented 40-paper display cap. See CHANGELOG 0.6.2 for the measurements.

- **`OPENALEX_API_KEY` support (0.6.3).** OpenAlex backs five of the six tools and
  six search sources, and its key was never supported — `openAlexUrl()` only
  appended `mailto`. The key is now sent on every OpenAlex request, read from
  plugin config, the environment, or the upstream `.env`. Also fixed: the 429
  advice named `mailto` (which the current OpenAlex docs do not mention) instead
  of the key, a 401 from a wrong key passed through untranslated, `paper_status`
  did not list the key, and the shared options object would have leaked an
  OpenAlex key to Semantic Scholar as `x-api-key`.

## What this package is

`dsh-paper-search` is an **independent implementation** for DeepSeek Harness. It
contains no third-party source code. Every source connector in `lib/sources.js`
is a small HTTP client written for this package, talking to public REST APIs and
public web pages directly.

## Upstream relationship

This package was **inspired by** [`openags/paper-search-mcp`](https://github.com/openags/paper-search-mcp)
(MIT licensed) and reuses its naming convention for optional credential
environment variables (`PAPER_SEARCH_MCP_*`) so that a machine already set up
for that tool needs no extra configuration. **No code from that project is
included, vendored, or copied.** If you install the upstream CLI separately,
this plugin will use it only as an optional extra source; it is never required.

## Data sources and their terms

Results come from public APIs and public web pages operated by third parties.
Each keeps its own terms of use and rate limits. Users are responsible for
complying with them. Specifically:

| Source | Operator | Access |
|---|---|---|
| Crossref | Crossref (DOI registration agency) | public REST API |
| OpenAlex | OurResearch | public REST API, "polite pool" email recommended |
| DOAJ | Directory of Open Access Journals | public REST API |
| Europe PMC | EMBL-EBI | public REST API |
| PubMed | U.S. National Library of Medicine | public E-utilities API |
| arXiv | Cornell University | public API, 1 request / 3 seconds requested |
| Semantic Scholar | Allen Institute for AI | public API, key raises rate limits |
| Garuda | Kemdiktisaintek, Republic of Indonesia | public web pages |
| Sinta | Kemdiktisaintek, Republic of Indonesia | public web pages |
| IOS OneSearch | Perpusnas, Republic of Indonesia | public web pages |
| Moraref | Ministry of Religious Affairs, Republic of Indonesia | public web pages |

## No bundled credentials

This package ships **no API keys and no email addresses**. Any credential is
read at runtime from the user's own configuration (plugin config, environment
variable, or the upstream tool's `.env` file) and is never transmitted anywhere
except to the service that issued it.

## What this package does not do

- It does not download or redistribute full-text PDFs.
- It does not bypass paywalls or access controls.
- It does not send queries to any service other than the ones listed above.
