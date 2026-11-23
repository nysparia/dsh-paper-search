# Changelog

> **Fork note (fork-specific).** This fork translates the codebase — identifiers,
> tool parameters, and docs — from Indonesian to English, and carries the behavior
> fixes listed under 0.5.0 plus the `paper_detail` tool added in 0.6.0. Entries
> below 0.5.0 are the upstream author's, carried over unchanged apart from the
> translation; their versions, dates, source ids, tool names, and measurements
> are untouched.

## [0.6.4] - 2026-11-23

A second audit pass, aimed at the places the first one did not reach. Every item
was found by a test that failed.

### Security — two more IPv6 forms bypassed the SSRF guard

The 0.6.2 fix covered IPv4-mapped, IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4
and Teredo. Two more forms embed an IPv4 address and were still reported SAFE:

| form | example | now |
|---|---|---|
| IPv4-translated (RFC 2765) | `::ffff:0:127.0.0.1` | BLOCK |
| NAT64 local-use (RFC 8215) | `64:ff9b:1::127.0.0.1` | BLOCK |

Neither connected on this machine (`UND_ERR_SOCKET`), but a guard must not depend
on the local network stack refusing something. Public addresses in the same forms
still pass.

### Fixed — `null` was printed as `0` in three places

`Number(null)` is `0` and `Number.isFinite(0)` is `true`, so the obvious
`Number.isFinite(Number(x))` guard turns "the source did not report a count" into
"zero". Measured: a work with `cited_by_count: null` printed **"cited 0 times"** —
a claim the data does not support.

Fixed in `detailOfWork` (`citedBy`, `fwci`, `percentile`, `referenceCount`) and in
`closenessToSeed` (`citedBy`). A real `0` still prints as `0`; only the unknown
case changed. `lib/sources.js` gained a local `workNumber()` because it
deliberately imports nothing from `index.js`.

### Fixed — `open_access_only` dropped results with no explanation

`makePaper` coerces a missing OA flag to `false`, so the filter drops works whose
source cannot report OA at all — Crossref, ACM, IEEE and PubMed never do.
Measured: `sources: "crossref", open_access_only: true` reported **"1 results"**
from Crossref and then listed **0 papers**, with nothing explaining the gap.

The reply now states how many were dropped and why, and the parameter description
says it up front.

### Fixed — an empty result hid the fact that sources had answered

`formatResult` returned early when the paper list was empty, so every filter note
printed above it was the only explanation — and the summary line still read like
"the search found nothing". It now says how many sources DID return papers and
that the filters removed them.

### Fixed — `year_from` silently kept works with no year

The filter is `!p.year || p.year >= year`, which is the right rule — an unknown
year is not "too old" — but the parameter description said "only papers with year
>= this value" and the reply never mentioned the exception. Measured: with
`year_from: 2015`, a work with `publication_year: null` appeared in the list with
no explanation. The description and the reply now both state it, and the count is
reported.

### Verified

16/16 assertions in a new suite (SSRF forms, null-vs-zero, redirect hops, filter
reporting), plus the 19/19 and 13/13 suites from 0.6.2 and 0.6.3, plus a live
regression of all six tools.

## [0.6.3] - 2026-11-23

### Added — `OPENALEX_API_KEY`

OpenAlex is the backend for five of the six tools and six of the search sources,
and its limits were the ones actually being felt. The key was never supported:
`openAlexUrl()` only ever appended `mailto`, so setting `OPENALEX_API_KEY` did
nothing at all.

It is now sent as the `api_key` query parameter on **every** OpenAlex request —
`paper_search` (including the `openalex`, `ssrn`, `ieee`, `biorxiv`, `medrxiv`
and `chemrxiv` sources), `paper_detail`, `paper_citations` (both directions and
the structure map), `paper_oa`, and `paper_fulltext`'s work lookup. Verified with
a request-capturing mock: 5/5 paths carry the key.

What a free key buys, per OpenAlex's own docs:

| | no key | free key |
|---|---|---|
| Daily budget | shared by everyone on your IP | **10×**, yours alone |
| Requests/second | 10 | **30** |
| Cursor paging | first page only | full |

Read through the same credential reader as everything else, so all four sources
work — verified individually: plugin config, `OPENALEX_API_KEY` in the
environment, `PAPER_SEARCH_MCP_OPENALEX_API_KEY`, and
`~/.config/paper-search-mcp/.env`.

### Fixed — the 429 advice was wrong

The error said *"Setting OPENALEX_EMAIL or UNPAYWALL_EMAIL raises the polite pool
limit."* The current OpenAlex authentication docs do not mention `mailto` at all,
and the 429 body names the missing **key** as the reason. The message now depends
on whether a key is already in use — telling someone who has a key to "set a key"
is useless, and telling someone without one to "wait 10 seconds" hides the fix.

### Fixed — a wrong key looked like a transient failure

HTTP 401 from OpenAlex was passed through untranslated. It now says the key was
rejected and that a key only works after its email address is verified.

### Fixed — `paper_status` did not report the key

`OPENALEX_API_KEY` was missing from the credential list, so the one tool you would
check could not tell you the key was absent. It is listed now, with an explicit
note when it is empty.

### Fixed — a latent credential leak between two providers

The shared search options object used `apiKey` for Semantic Scholar. Adding
OpenAlex's key under the same name would have sent an **OpenAlex key to Semantic
Scholar** as `x-api-key`. The Semantic Scholar field is now `semanticApiKey`, and
a test confirms each provider receives only its own credential.

## [0.6.2] - 2026-11-23

A security and correctness audit of the whole codebase. Every item below was
found by writing a test that failed, not by reading the code and guessing.

### Security — SSRF guard bypassable through IPv6

`isSafeUrl()` only recognised `::1`, `::`, `fc*` and `fe8*`–`feb*`. Every IPv6
address that EMBEDS an IPv4 address went straight through, which is exactly how
an attacker reaches loopback. Proven against a real local HTTP server:

```
http://127.0.0.1:PORT/secret.pdf          guard=BLOCK  not attempted
http://[::ffff:127.0.0.1]:PORT/secret.pdf guard=SAFE   FETCHED HTTP 200
http://[::ffff:7f00:1]:PORT/secret.pdf    guard=SAFE   FETCHED HTTP 200
```

The IPv6 branch now parses the address and unwraps every embedded-IPv4 form
before deciding: IPv4-mapped (`::ffff:a.b.c.d` and the hex form), IPv4-compatible
(`::a.b.c.d`), NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and Teredo
(`2001:0::/32`, whose client address is bit-inverted). It also refuses
loopback, unspecified, link-local, unique-local and multicast outright.
28 cases verified, including that public addresses still pass.

### Fixed — `paper_detail` batch returned papers in the wrong order

`resolveWorks` groups identifiers by prefix and issues one request per group, so
works came back grouped by TYPE rather than in the order asked for. Measured with
a mocked API that returned the filter reversed: asking for `[A, B, C]` produced
`[C, B, A]`. A numbered batch reply that does not match the caller's list is
actively misleading — the reader matches "3." to their third identifier and gets
a different paper. Each work is now placed back at the index of the identifier
that produced it.

### Fixed — `paper_search` query was injected into arXiv's query language

`arxivMatch()` already stripped `"` and `\` from a TITLE (an earlier fix), but
the SEARCH path did not. Measured: the query `Attention" OR all:"x` produced
`search_query=all:Attention" OR all:"x` — a different search entirely, whose
results would then be reported as the answer. The metacharacters (`" \ ( ) [ ]
{ } :`) are now removed, bare `AND`/`OR`/`ANDNOT` are dropped as operators, and
a query with nothing searchable left returns `null` so no request is sent.

### Fixed — arXiv throttle had a race, violating the 1 req / 3 s TOU

`arxivWait()` read `arxivLastRequest`, awaited the delay, then wrote the
timestamp. Between the read and the write every other caller saw the same stale
value and computed the same delay, so they all woke together. Measured with three
concurrent searches, the gaps were **3003 ms, 0 ms, 69 ms, 2933 ms, 1 ms** — five
violations in one batch, which is what gets an IP blocked. Replaced with a promise
chain so the wait and the timestamp update happen in one critical section.
Re-measured: 3001, 3003, 3004, 3003, 3002 ms.

### Fixed — cache was LRU-by-insert, and TTL counted from insert

`usedAt` was written only by `set()`, so:

- the TTL counted from INSERT, not last use — an entry read every minute still
  expired 30 minutes after it was stored;
- `prune()` evicts by `usedAt`, so it evicted by insertion order while the
  comment above it claimed "least-recently-used". A hot entry was thrown away
  before a cold one.

`get()` now refreshes `usedAt` (best-effort: a failed write must not turn a HIT
into a MISS).

### Fixed — `DOAJ_API_KEY` was read, passed, and then ignored

The key was resolved from the credentials store and threaded all the way to
`doaj()` — which never used it. Measured: the request with a key and the request
without one were byte-identical, so the documented "raises DOAJ's hourly limit"
never happened. DOAJ takes it as an `api_key` query parameter; now sent.

### Fixed — User-Agent reported version 0.1 while the package was 0.6.1

Hardcoded in both `lib/sources.js` and `lib/fulltext.js`. This matters beyond
cosmetics: Crossref and OpenAlex route "polite pool" traffic by User-Agent, and a
client reporting a version it is not running cannot be identified when it
misbehaves. Both now read `package.json`.

### Fixed — citation map under-reported its request count

The seed lookup happens before `structureMap()` runs and costs one request, but
the tally started at 0. Measured with a mocked API: 2 requests made, "1" reported.
A cost fence that under-reports is worse than no fence, because the reader budgets
against a wrong number. Now starts at 1.

### Fixed — `paper_detail` silently dropped `identifier` when `identifiers` was also given

`{ identifier: "10.9999/x", identifiers: [A, B] }` returned A and B and never
mentioned that the third paper was thrown away — so the missing paper looked like
"OpenAlex does not have it". The reply now states which input was ignored.

### Fixed — the 40-paper display cap was undocumented

`max_results` is PER SOURCE, but the reply lists at most 40 papers after dedup.
Measured: `max_results: 50` returned 40 and said nothing about why. The cap is now
a named constant and the reply states the count whenever it truncates.

### Verified

19/19 assertions in a consolidated suite covering every fix above, plus live
regression of all six tools. OpenAlex rate-limited this machine partway through
(HTTP 429, then ECONNRESET), so the OpenAlex-dependent paths were verified against
a mocked API rather than live — that is stated here rather than glossed over.

## [0.6.1] - 2026-11-23

### Changed — `pmc` and `ios` are off by default

Both stay **registered** and callable by name (`sources: "pmc"`), but a bare
`paper_search({ query })` no longer pays for them. Each was turned off for a
measured reason:

| id | Why | Measured |
|---|---|---|
| `pmc` | PubMed Central is the open-access full-text **slice of PubMed**, and it costs **two extra requests** (esearch + esummary) to NCBI for records `pubmed` already returned in the same run. The one thing it adds — full-text availability — `paper_fulltext` answers directly in one OpenAlex request. | 23 Nov 2026 |
| `ios` | The host does not answer from this machine at all: `UND_ERR_CONNECT_TIMEOUT` on both https and http after **10.5 s**, so every default search waited 10.5 seconds to collect zero results. It is an HTML scrape with no API, so there is no fallback. | 23 Nov 2026 |

Effect on a bare search, measured with a `fetch` counter:

| | sources | HTTP requests | wall clock |
|---|---|---|---|
| before | 23 | 23 | 10–25 s |
| after | 21 | 20 | 7–12 s |

The request count drops by 3, not 2: `pmc` was making two requests per search.

**The group keywords respect the same rule.** `sources: "indonesia"` used to
return `garuda`, `sinta` **and** `ios`; it now returns the two that answer.
Measured: 2 requests / 6.1 s, versus 3 requests / 16.6 s before. "Off by
default" has to mean off in every default set, otherwise the one source that
never answers comes back through the group keyword — the exact cost this change
exists to remove. `sources: "ios"` still runs it.

**`paper_status` still reports all 23.** It is the doctor: a source that is off
by default must not be able to break silently. It marks them and states the
default set:

```
  ?     PubMed Central     api      registered [off by default] (not probed — pass probe:true to test it)
  ?     IOS OneSearch      html     registered [off by default] (not probed — pass probe:true to test it)
note: a bare paper_search runs 21 of 23 sources. OFF BY DEFAULT: pmc, ios — registered and callable by name, but not part of "all".
```

The startup note now reports the default set separately from the registry, so
"23 sources" is never read as "23 requests".

## [0.6.0] - 2026-11-23

### Added — `paper_detail` (free metadata + abstract, single or batch)

A sixth tool, backed by OpenAlex. It returns title, authors **with institutions
and the corresponding flag**, year/date, venue, publisher, citation count,
**FWCI**, **field percentile**, **retraction flag**, volume/issue/pages,
reference count, topics, keywords, open-access copies with licences, and the
**full abstract**.

**Why it exists.** Measured across 23 sessions on this machine (417,023 session
records decompressed and attributed by `X-Credits-*` header): the billed
`get_semantic_paper_detail` was the single most expensive tool in use —
**60 calls / 60 credits, 31% of all billed spend**. Worse, 15 of those calls
were **consecutive**, and a single batch call would have answered them for
2 credits. OpenAlex carries the same metadata for free.

**The batch is the point.** `identifiers: [...]` costs **two requests per
identifier TYPE**, not per paper — measured: 4 identifiers spanning DOI, PMID
and arXiv cost **6 requests**; 15 DOIs cost **2**. Duplicates are de-duplicated
within a call (measured: the same DOI passed three ways → 2 requests).

**Why two requests, not one — the retracted-work trap.** OpenAlex's list
endpoint **silently omits retracted works** unless `is_retracted:true` is in the
filter, and that flag is **AND**-ed with the identifier filter rather than
OR-ed. Measured 23 Nov 2026 with one retracted and one normal DOI:

| filter | returns |
|---|---|
| `doi:A\|B` | 1 work — the **normal** one |
| `doi:A\|B,is_retracted:true` | 1 work — the **retracted** one |

Neither request alone sees both, so the batch issues both and unions them.
There are **91,863** retracted works in OpenAlex (measured the same day).
Without the second request every one of them would have been reported as
"not found in OpenAlex" — the worst possible error for this tool, because a
retracted paper is exactly the paper a reader most needs to be warned about.
The reply prints `⚠ RETRACTED` when the flag is set.

This was found by testing the tool against a known-retracted paper
(`10.1016/S0140-6736(20)31180-6`, the Lancet hydroxychloroquine study) rather
than only against papers that were expected to work.

**Identifier prefixes verified against the live API (23 Nov 2026):**

| Filter | Result |
|---|---|
| `doi:10.3390/info15060294\|10.1038/…` | 200, 2 works |
| `pmid:37074525\|36568739` | 200, 2 works |
| `pmcid:PMC8371605\|PMC10113978` | 200, 2 works |
| `arxiv:1706.03762\|2106.12345` | 200, 2 works |
| `openalex_id:W3177828909\|W4398222754` | 200, 2 works |

**Mixing prefixes in one filter is rejected by OpenAlex** (HTTP 400, "trying to
do an OR query between filters", measured 23 Nov 2026), so a mixed batch is
split into one request per prefix. That is why the request count is reported in
the reply rather than assumed.

**A bare number is deliberately NOT guessed as a PMID.** It is far more likely a
year or a typo, and `pmid:2024` would silently return the wrong paper.

**What OpenAlex does not have, stated in the tool description so the model does
not over-trust it:** the S2 `paperId`/`corpusId`, citation **contexts** (the
sentence that cites), citation **intents**, and SPECTER2 embeddings. A caller
that needs to chain into another Semantic Scholar tool must still resolve the
paper there.

**"Not found" is reported per input**, not as a silently shorter list — the
reply names exactly which identifiers OpenAlex had no record for, and says that
this does not mean the paper does not exist.

Schema cost, measured: `tools: "five"` went from 8,225 to **10,050** characters
(~2,056 → ~2,513 tokens); `tools: "one"` from 4,088 to **4,646** (~1,022 →
~1,162).

## [0.5.0] - 2026-11-23

**English fork.** Seeded from the published 0.4.1 tarball because the upstream
repository returns 404. Every comment, identifier, and user-facing string was
translated from Indonesian to English; the model-facing tool parameters were
renamed as well. The Indonesian parameter names are **not** accepted as aliases.

### Changed — model-facing tool parameters (breaking)

| 0.4.1 | 0.5.0 |
|---|---|
| `paksa_ulang` | `force_refresh` |
| `urutkan` | `sort` |
| `min_sitasi` | `min_citations` |
| `jenis` | `kind` |
| `bersihkan_cache` | `clear_cache` |
| `arah` | `direction` |
| `analisis` | `analysis` |
| `ambang_kuat` | `strong_threshold` |
| `min_bersama_kuat` | `min_shared_strong` |
| `max_kandidat` | `max_candidates` |

Parameter *values* changed too: `arah` `pengutip`/`rujukan` → `direction`
`citing`/`references`; `urutkan` `sitasi`/`terbaru`/`relevansi` → `sort`
`citations`/`newest`/`relevance`; `analisis` `daftar`/`peta` → `analysis`
`list`/`map`. Plugin config keys: `folderTeksLengkap` → `libraryRoot`
(`FOLDER_TEKS_LENGKAP` still honored), `berkasCache` → `cacheFile`
(`berkasCache` still honored). The cache file is now `cache-search.json`.

### Fixed — `paper_status` probed every source by default

Measured on this machine: a default `paper_status()` call took **122,420 ms**,
because `probe` defaulted to `true` and walked all 23 sources — arXiv is
self-throttled to 1 request / 3 seconds and the three HTML portals are slow.
That is long enough to hit a tool timeout, and the model reaches for this tool
exactly when it wants a fast answer. Probing is now **opt-in** (`probe: true`)
and the default call returns in **1 ms**.

### Fixed — `collapseTitle` was O(n²) with unbounded input

The period search scans `n/2` candidate periods against `n` characters, and it
ran **before** the 300-character truncation in `makePaper`. Measured: 5,000
chars 32 ms, 20,000 chars 433 ms, 50,000 chars 2,753 ms, 100,000 chars
**12,964 ms**. A source returning an oversized `title` field (a full abstract,
a concatenated record) stalled the whole search. The input is now clamped to
2,000 characters first; the same 100,000-character input takes **0 ms**, and
the output for every realistic title is byte-identical.

### Fixed — `dedup` collapsed every untitled record into one

`titleKey(null)` is `''`, so records with no DOI and no title all hashed to
`t:` and merged. Measured: three distinct untitled records from
Zenodo/HAL/IOS became **one** survivor and the other two URLs were lost. The
key now falls back to the URL, then to `source:index`, so each unidentifiable
record stays its own entry. Real DOI and title deduplication is unchanged.

### Fixed — `arxivMatch` allowed arXiv query injection

The title was interpolated into `ti:"…"` unescaped. Measured: the title
`Attention" OR all:"x` produced `search_query=ti:"Attention" OR all:"x"`,
which searches something else entirely — and the wrong paper would then be
reported as "the arXiv version of this one". Query syntax characters are now
stripped (arXiv has no escape sequence for a quote inside a phrase).

### Fixed — `kind` filtering compared substrings

`kind: ["article"]` kept `review-article`, so asking for original research
silently mixed reviews back in. The mirror-image bug was worse: `kind:
["preprint"]` dropped `posted-content`, which is exactly what Crossref returns
for a preprint, so the filter emptied that source. A `canonicalKind()` mapping
now folds each platform's vocabulary (`journal-article`, `posted-content`,
`proceedings-article`, `review-article`, …) onto the three kinds the tool
offers, with `review` winning over `article`.

### Fixed — `worksCiting` reported the platform total as `checked`

It returned `checked: total`, so a 3-row page claimed it had examined all
49,296 citing works. Any caller printing that would turn "most cited first"
into a false statement. It now reports the number of records actually examined.

### Fixed — `isCacheable` still matched the Indonesian word

The regex tested `/WAJIB/i` against `source.credit`, but the registry was
translated to `REQUIRED — answers 429 without a key` / `REQUIRED email`. After
translation the regex matched nothing, which would have made CORE and Unpaywall
cacheable — serving one user's keyed answer to the next caller. Now
`/REQUIRED/i`; verified that exactly `core` and `unpaywall` are skipped.

### Fixed — stale source-count guard

The guard message said "not 19" while the registry has 23 sources. It now says
23, and the referenced test path is `test/test-sources.mjs`.

### Docs

`README.md`, `NOTICE.md`, `CHANGELOG.md`, and `skills/paper-search/SKILL.md`
translated. `NOTICE.md` gained a fork section listing every change above.
`GLOSSARY.md` records the Indonesian→English mapping used, so the translation
can be audited. Test-file references were renamed to English
(`uji-sumber.mjs` → `test-sources.mjs`, and so on); the `test/` directory is
not part of the npm tarball, so those suites are not in this repository.

## Compatibility

| dsh-paper-search | DeepSeek Harness | Tested on |
|---|---|---|
| 0.4.1 | 0.2.0-rc.2 | 2 Oct 2026, Windows, Node 24 |
| 0.4.0 | 0.2.0-rc.2 | 2 Oct 2026, Windows, Node 24 |
| 0.3.1 | 0.2.0-rc.2 | 2 Oct 2026, Windows, Node 24 |
| 0.3.0 | 0.2.0-rc.2 | 1 Oct 2026, Windows, Node 24 |
| 0.2.0 | 0.2.0-rc.2 | 1 Oct 2026, Windows, Node 24 |
| 0.1.9 | 0.2.0-rc.2 | 1 Oct 2026, Windows, Node 24 |
| 0.1.8 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.7 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.6 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.5 | 0.2.0-rc.1 | 29 Sep 2026, Windows, Node 24 |
| 0.1.4 | 0.1.7-rc.2 | 28 Sep 2026, Windows, Node 24 |
| ~~0.1.0~~ | — | **DO NOT USE — the plugin fails to load, see 0.1.1** |

This package uses no DSH internal API beyond `ctx.tools.register` and
`ctx.get('skills').registerProvider` — both are already used by another plugin
running in this profile (`dsh-search-cascade`), so the breakage points are the
same and already known.

## [0.4.1] - 2026-10-02

### Fixed — guarding PDF download links

Found **after reading upstream PR #56** ("safety improvements", +3,963/−669,
open since 16 April 2026). That PR's title is **misleading**: most of its content
is HTTP transport infrastructure, not safety. What is genuinely valuable sits in
six connectors: host checks using **substring** matching (`if 'doi.org' in url`,
`if 'web.archive.org' in resp.url`) replaced with proper hostname parsing.

That is a real bug class — `https://jahat.example/?x=doi.org` passes a substring
check. **Audit of our code: that pattern is absent** (0 substring-based host
checks, 7 uses of `new URL()`).

But the same audit found an **equivalent gap of our own**: `downloadPdf()`
follows redirects **without checking anything**. Download URLs come from
third-party APIs (OpenAlex OA locations, Unpaywall, Semantic Scholar's
`openAccessPdf`, CORE), so their content must be treated as **untrusted data**.

What was fixed:

- **`isSafeUrl(url)`** (new, a pure function so it can be tested without the
  network): only `http`/`https`; rejects `localhost`, `*.local`, `*.internal`,
  `*.home.arpa`, and private/loopback/link-local IP addresses including
  `169.254.169.254` (the cloud metadata endpoint) as well as IPv6
  `::1`/`fc00::/7`/`fe80::`.
- **Redirects are followed one at a time** (`redirect: 'manual'`) with the same
  guard on **every hop**. Previously `redirect: 'follow'` meant the second hop
  and beyond were never seen — so a guard on the initial link alone could be
  bypassed with a single redirect. Relative `Location` values are resolved
  correctly, and hops are capped at 5 so a redirect loop cannot hang.

Limits that must be understood: this is **not** comprehensive protection. It
closes the "link pointing inward" class, not every possibility. What is kept and
unchanged: the response must really be a PDF (magic `%PDF-` and ≥ 1,000 bytes)
and writes stay atomic (`.part` → rename).

Verified: a **live test** downloaded a real arXiv PDF through `paper_fulltext`
and converted it to Markdown (39.8 KB) in 2 seconds — the guard does not block
the legitimate path.

### Tests

`uji-teks-lengkap` **16 → 43 assertions** (27 new: 4 links that must be allowed,
12 that must be rejected, 3 anti-over-blocking bounds, and 5 redirect scenarios
including relative Location and an endless loop).

## [0.4.0] - 2026-10-02

**Two new capabilities, and still ONE entry point.** No new tools: the citation
map arrives as `analysis: "map"` on `paper_citations`, and the cache arrives as
`paper_search` behavior.

### Added — citation structure map (upstream issue #122)

`paper({ mode: "citations", identifier, analysis: "map" })` builds a map of the
field from **references**, not from keywords:

- **Bibliographic coupling** — each work's closeness to the seed through
  references they SHARE. Answers "who is most in the same field as this paper".
- **Co-citation** — the references most often cited TOGETHER by the candidates;
  this is the "shared foundation" of a field.
- **Cluster grouping** — two conditions at once (cosine AND shared-reference
  count), because each has a hole: cosine alone connects works with very short
  reference lists, count alone connects large works that happen to overlap. The
  thresholds are **reported** in the output.
- **Bridges between clusters** — works that nearly belong to two fields at once.
  Computed at **two levels** (strict cluster + loose linkage), because with a
  single level a bridge actually MERGES the two clusters and is therefore never
  detected. Proceedings records with hundreds of references are **flagged**, not
  treated as a finding.

Live test on "Guidelines for Human-AI Interaction": coupling found
*Questioning the AI* (0.143), co-citation found LIME *"Why Should I Trust
You?"* (cited together 8×), the XAI cluster formed, and the top bridge was a
genuine survey connecting 4 clusters. **2 OpenAlex requests**, 2.2 seconds.

### Added — bounded search cache (spirit of #94/#140)

`paper_search` now uses a local cache (`~/.dsh/paper-search/cache-search.json`):

- **Failures are NEVER stored** — only answers that succeeded. Otherwise a
  momentary outage would "infect" the whole TTL and a source that has already
  recovered would still look dead.
- **Keyed and DOI-based sources are skipped** (CORE, Unpaywall).
- **Keys contain no credentials** — API keys/email never enter the cache key, so
  the cache file does not become a place where secrets leak.
- **Bounded**: TTL 30 minutes, max 200 entries, max 2 MB; the least recently
  used is dropped first. Written **atomically** (`.part` → rename), and a
  corrupt file does not disable anything.
- **Always visible**: the cache age is stated in the report, `force_refresh: true`
  ignores it, and `mode: "status"` reports the cache's contents/limits and can
  clear it (`clear_cache: true`).

Measured: the second search **2,118 ms → 1 ms**, still succeeding when the
network was deliberately switched off, and `force_refresh` really does search
again (it failed with the network off — proof it does not silently use the
cache).

### Tests

- `test/test-citation-map.mjs` — **37 assertions** (new, pure/offline) + 2 mutations.
- `test/test-cache-search.mjs` — **34 assertions** (new, faked clock).
- `test/test-plugin.mjs` — **59** (up 2: the map mode schema is guarded).
- `test/test-sources.mjs` 79 · `test/test-single-door.mjs` 30 · `test/test-search-filter.mjs` 21
  · `test/test-fulltext.mjs` 16 · `test/test-doc-consistency.mjs` 6.
- **Live tests** (not unit): the map was run against OpenAlex in both directions,
  and the cache was tested with the network switched off.

## [0.3.1] - 2026-10-02

**Closing two upstream sources that had never been evaluated** — one adopted, one
rejected with evidence.

### Added — ChemRxiv (22 → 23 sources)

- **`chemrxiv`** — **chemistry** preprints, through OpenAlex (repository
  `S4393918830`, **64,495** works; "catalysis" → **13,594** real results,
  measured 2 Oct 2026).
- **Why not the site itself:** `chemrxiv.org` answers **HTTP 403** with a
  Cloudflare page ("Just a moment...") for both the search page **and** its API
  gateway. The upstream module scrapes HTML from there — that path would be
  blocked, this OpenAlex path is not. Same as SSRN (0.2.0) and IEEE (0.3.0).
- Zero new code: `chemrxiv` uses the shared `openAlexRepository()` function
  already used by SSRN, bioRxiv, and medRxiv.

### Rejected — OAI-PMH, for a protocol reason (not "the endpoint is dead")

`oaipmh` upstream is a **generic** protocol client, and **the protocol does not
support keyword search at all**: that module uses `verb=ListRecords`
(harvesting), while the `query` parameter **is accepted in the function
signature but never sent to the API**. That means it returns arbitrary records
that do not match the query — exactly the kind of silent error this package
rejects everywhere else. Its default endpoint (`api.base-search.net/oai`, i.e.
BASE — which we already rejected because it needs an institutional IP) also
answers **HTTP 404** when measured on 2 Oct 2026.

Real search through OAI-PMH requires bulk downloading of entire records, not
literature search. Recorded in `upstream/notes.json` so it is not re-evaluated
from scratch.

### Tests

- `test/test-sources.mjs` — **79 assertions** (the count does not change; adding a
  source does not add per-source assertions), 23 sources tested live, **22
  answered**.
- `test/test-doc-consistency.mjs` — **6 assertions**; it is what points at the
  **10 places** in the docs that must be updated when a source is added.
- `test/test-plugin.mjs` 57 · `test/test-single-door.mjs` 30 · `test/test-search-filter.mjs` 21
  · `test/test-fulltext.mjs` 16.

## [0.3.0] - 2026-10-01

**Broader coverage without adding a single tool** — and without a single new
scraper: every one of these new sources is fetched through APIs this plugin
**already** uses.

### Added — three new sources (19 → 22)

- **`ieee`** — through Crossref `filter=member:263`, **without an API key**. The
  same trick as ACM (#123). Measured: `member:263` answers **136,771** works;
  with `type:proceedings-article` **106,734**; every result carries a DOI
  `10.1109/…`. ⚠️ **A limit deliberately not claimed:** Crossref does **not**
  carry IEEE abstracts (measured 0 out of 5 records), so the abstract is usually
  empty — the citation fields are there. Upstream (PR #138) still makes IEEE
  require a key; this path does not.
- **`biorxiv`** and **`medrxiv`** — through the **OpenAlex source filter**, not
  their own APIs (the bioRxiv/medRxiv APIs have no keyword search at all, only
  date/category ranges). Measured: bioRxiv `S4306402567` **345,976** works
  ("digital literacy" → 159; with preprint + citations > 4 → 141) · medRxiv
  `S3005729997` **87,941** works ("digital literacy" → **1,352**).
- This also cleans up the code: SSRN, bioRxiv, and medRxiv now share **one**
  function, `openAlexRepository()`.

### Added — preprint push-down

- `kind: ["preprint"]` is now forwarded to **Europe PMC** as `AND SRC:PPR`
  (measured: "digital literacy" + SRC:PPR → **2,775**, without it **85,096**).
  This addition only happens when preprints are actually requested — there is no
  "NOT" logic that could silently drop results.

### Added — tools & guards for following upstream

- **`upstream/notes.json`** — a decision log over upstream issues/PRs (adopted /
  partial / rejected / not-relevant / pending), with reasons and versions.
- **`tools/scan-upstream.mjs`** — one command that reports: **NEW** items, items
  **NOT YET** decided, items **CHANGED** since the last scan (old decisions may
  no longer apply), and **source-list deviations** measured from the real
  `paper_search_mcp/academic_platforms/` files — not from memory. There is
  `--strict`, which exits with code 1 if anything needs action.
- **`test/test-doc-consistency.mjs`** — a guard that **FAILS** if the source
  count in README / SKILL.md / package.json / the catalog entry does not match
  the real number, if a "no credentials" claim does not match the `credit`
  field, or if a source id has no **table row** in SKILL.md. Includes 3
  self-test mutations. Built **before** the new sources were added — and it
  immediately pointed at 9 places that had to be updated, so there is no more
  hand-editing of docs.

### Tests

- `test/test-sources.mjs` — **79 assertions**, 22 sources tested live (**21
  answered**, 1 SKIP due to network).
- `test/test-doc-consistency.mjs` — **6 assertions** (new).
- `test/test-plugin.mjs` 57 · `test/test-single-door.mjs` 30 · `test/test-search-filter.mjs` 21
  · `test/test-fulltext.mjs` 16.

## [0.2.0] - 2026-10-01

**The biggest feature release since this package existed.** Five proposals taken
from upstream issues/PRs in `openags/paper-search-mcp` — chosen after checking
which ones we did not already have, because several of them **already** exist
here (`%PDF-` validation before writing, 3-second arXiv pacing, defensive
parsers).

### Added — two new sources (17 → 19)

- **`openreview`** (upstream issue #83) — ML conferences: ICLR, NeurIPS, ICML.
  No API key. What is used is `api2.openreview.net/notes/search?term=…` because
  the generic `/notes` endpoint answers **HTTP 403 `ChallengeRequiredError`**
  (bot verification), and its query parameter is named `term`, not `query`.
  DOIs are taken from the `_bibtex` field so the same work also dedups against
  Crossref, and relative `pdf` (`/pdf/<hash>.pdf`) is completed to
  openreview.net.
- **`ssrn`** (upstream PR #60) — economics/law/business preprints, **through
  OpenAlex**, without fetching a single ssrn.com page (that site answers
  **HTTP 403** for ordinary requests). All 1.65 million SSRN works are indexed
  by OpenAlex as one source (`S4210172589`); measured: `search=digital
  literacy` + that source filter answers **3,836 works**.

### Added — filtering & sorting of search results

- **`sort`**: `relevance` (default) · `citations` · `newest`. Works whose number
  is not reported by the source are placed last — not treated as zero.
- **`min_citations`**: only works with citations ≥ N. Works from sources that do
  not report citations are **dropped**, and the count is stated in the report.
- **`kind`**: `article` · `review` · `preprint`. Forwarded to sources that
  support it (OpenAlex `filter=type:`, Crossref/ACM `filter=type:`) so that
  `max_results` is still filled with results that pass, then filtered again
  after dedup. Works whose kind is not reported by the source are **still
  shown** — "not stated" does not mean "not an article".
- Everything dropped is **counted and reported**. "There were only a few
  results" must not become a mystery.

### Fixed

- **The full-text cache could serve a corrupt PDF.** `downloadPdf()` now writes
  through a `.part` file then `renameSync` (atomic), and a PDF from the cache is
  checked before use: if it is not valid, its `.md`/`.pdf` pair is dropped and
  re-downloaded — self-healing, rather than serving a doubtful result. A good
  PDF is **never** destroyed by a failed new download.
- **OpenReview author names vanished silently.** `authorList()` did not
  recognize the `{fullname}` shape used by ORCID/DBLP records there, so
  `[{fullname: '…'}]` produced an empty list. Now recognized, and tested.
- **`Number(null)` = 0 made "citations unknown" read as "0 citations"**, so
  works without a citation report were dropped by `min_citations` as if their
  citations were zero. Caught by the new test `test/test-search-filter.mjs`.
- **OpenReview `venue` sometimes contains its own title** (measured on ORCID
  records), so the title appeared twice; it is now treated as "not reported".

### Changed

- The `ios` test (IOS OneSearch) no longer turns the whole suite red when its
  site cannot be reached: a **network** failure is reported as `SKIP`, while a
  source that *answers* with an error stays `FAIL`. The basis is measured:
  `onesearch.id` answered `fetch failed` in plugin 0.2.0 **and** in the
  installed 0.1.9 copy.

### Tests

- `test/test-search-filter.mjs` — **new**, 21 pure assertions (no network) for
  filtering & sorting.
- `test/test-fulltext.mjs` — **new**, 16 assertions for PDF cache integrity
  (validation, atomic write, self-healing). All network is faked.
- `test/test-sources.mjs` — **79 assertions** (19 sources tested live; 18
  answered, 1 SKIP due to network).
- `test/test-plugin.mjs` — **57 assertions**, `test/test-single-door.mjs` — **30
  assertions**.
- Test fix: the ACM assertion was updated for the filter shape that now
  combines `kind` rather than replacing it.

## [0.1.9] - 2026-10-01

**Documentation only — no code changes.** This release exists because the
plugin's bundled guide still assumed the five separate tools.

### Fixed

- **The bundled guide** (`skills/paper-search/SKILL.md`) was still titled
  **"Five tools"** and only mentioned the names `paper_search` / `paper_status` /
  `paper_citations` / `paper_oa` / `paper_fulltext` — even though since **0.1.8**
  a profile may install `tools: "one"`, and in that profile those five names
  **do not exist**. Now: the title is **"Five capabilities"**, there is a
  **single-entry-point mapping column** (`paper({ mode: "…" })`), plus examples
  for **both** shapes. Previously the mode note was only **inserted when the
  file was loaded**, so the table in the file body still pointed at names that
  do not exist in the single-entry-point profile — that is what is fixed here.

### Unchanged

- `lib/` is **identical to 0.1.8**: 17 sources, five tools, and the same
  behavior. The default stays **five separate tools**; `tools: "one"` stays
  **opt-in**.
- The catalog description stays **425 characters** (catalog hard limit 500).

### Verified

- `test/test-sources.mjs` **77/77** · `test/test-plugin.mjs` **57/57** ·
  `test/test-single-door.mjs` **30/30** · `test/test-in-dsh.mjs` **27/27**
  (a real DSH 0.2.0-rc.2 boot).
- `check-all.mjs` (the DSH guard on this machine) **24 checks**, 1 SKIP because
  Reddit answered HTTP 403 — not a code defect.

## [0.1.8] - 2026-09-29

**New option `tools: "one"` — the five tools merged into ONE entry point.** The
default **does not change**: without config, the five tools stay separate.

### Added

- **Config `tools`**: `"five"` (default — old behavior, 5 separate tools) or
  `"one"` (one tool named **`paper`** with a `mode` parameter:
  `search` · `status` · `citations` · `oa` · `fulltext`). An unrecognized value
  **falls back to the default** and the reason is reported in the `apply()`
  note — not used silently.

### Why this option exists

All five tool definitions are sent to the model on **every request**. Measured
29 Sep 2026 on this machine (`test/test-single-door.mjs`):

| | JSON characters | estimated tokens |
|---|---|---|
| five tools (default) | 4,959 | ~1,240 |
| one entry point (`tools: "one"`) | 2,159 | ~540 |
| **saving** | **56%** | ~700 tokens/request |

### The cost you must be aware of (do not hide it)

- **Tool names stop explaining themselves.** `paper_fulltext` reads directly as
  "read the content of a paper"; now that capability sits behind `paper` +
  `mode: "fulltext"`, so the model has to read the description to find it.
- **The schema becomes loose.** One schema cannot require different parameters
  per mode, so the guard moves from DSH to the plugin: `paper({ mode: "oa" })`
  without `identifier` is **rejected by the plugin** (its message imitates a
  schema rejection), not by the harness before the tool is called.
- That is why **the default stays five tools** — this mode is for installations
  that genuinely prioritize context cost.

### Guarantees under test

The schema and the list of required parameters are **DERIVED** from the five
original tool definitions (not copied), so they cannot drift when the original
tools change. The skill body is given a **mode note** when `tools: "one"` so the
document does not tell you to call tool names that do not exist; its catalog
description is kept **≤ 500 characters** (measured 474). All of it is in
`test/test-single-door.mjs` — **29 assertions**.

## [0.1.7] - 2026-09-29

**Tidying `paper_status` output, and no longer leaving junk files behind.** No
tool was added, renamed, or removed — the five stay the same.

### Fixed

- **`paper_status` no longer tells you to install a third-party CLI.** The
  `== CLI paper-search-mcp (optional) ==` block was **removed**, and its content
  was already inaccurate: it said that CLI "adds CORE, Zenodo, HAL, Unpaywall",
  when **all four are already native sources** of this plugin. Replaced with a
  one-line note: all sources are already native and the plugin **requires no
  third-party CLI or server whatsoever** — so `paper_status` output no longer
  offers an installation that is not needed.
- **The `paper_status` tool description no longer promises a check that does not
  exist.** It used to read "…and whether the optional paper-search-mcp CLI is
  installed", when the code **never** checked that. It now matches reality:
  credentials, the status of each source, and the **PDF→Markdown converters**
  available to `paper_fulltext` — plus a `probe:false` hint to check without the
  network.
- **`<name>.md.err` files no longer pile up.** Previously every conversion left
  one error file behind; **measured 29 Sep 2026 16:05 WIB (UTC+7): one 0-byte file
  per conversion** (re-converting arXiv 1706.03762). Now that file is **deleted
  when conversion SUCCEEDS**, and **kept when it FAILS** so the converter's
  original message can still be reported. The deletion happens **after** the
  descriptor is closed — on Windows, deleting a file that is still open fails.
- **0-byte Markdown left over from a FAILED conversion is also dropped.**
  Previously a PDF that failed to convert left an empty `.md` in the library
  folder. The caller was actually already safe (`size > 0` is guarded in
  `prepareFullText`), but that 0-byte file is confusing when a human looks at
  the folder — it is now deleted on failure, while **the error message is still
  kept in `.err`**. Measured 29 Sep 2026: fake PDF → `exit code 1 — anydoc:
  malformed document: not a PDF`, `.err` still present, 0-byte `.md` gone.

### Notes

- What did **not** change: 17 sources, 5 tools, PDF order (arXiv first),
  conversion that is always local, and the refusal to break through paywalls.
- For those who already use the upstream CLI as a supplement: this plugin
  **does not forbid it**, it just stops recommending it.

## [0.1.6] - 2026-09-29

**Full text: an open-access PDF is downloaded, then converted to Markdown** so an
agent can read the CONTENT OF A WHOLE PAPER — not just its title and abstract.

One new tool (**`paper_fulltext`**, so 5 tools) and one step upstream does not
have.

### Added

- **arXiv fallback for PDFs** (adopting upstream PR **#124**). Measured 29 Sep
  2026: OpenAlex does **not** store the arXiv id (`ids` only has
  `openalex`/`doi`/`mag`), so the id is derived from the DOI
  `10.48550/arXiv.<id>` or the location URL; if there is none, the arXiv version
  is **searched by title**. PDF attempt order: **arXiv first**, then the OpenAlex
  OA location, last Unpaywall. `paper_fulltext` also accepts an **arXiv id
  directly** (`1706.03762`).

- **PDF → Markdown conversion through `anydoc`** (fallback: `markitdown`). The
  model cannot read raw PDFs, and a whole paper does not fit in one send — so
  the result is written to a `.md` **file** in `~/.dsh/paper-search/md/`, the PDF
  is stored alongside it, and what is returned is the **path** + the full content
  (if ≤ 20,000 characters) or a preview + how to read it in stages with `read`.

  Measured: the arXiv PDF of *Attention Is All You Need* (2.1 MB) → **39.8 KB of
  Markdown in 424 ms**; a PLOS ONE PDF (2.9 MB) → **70.8 KB in 363 ms**, complete
  with reference links. Total through the tool (including download + arXiv
  lookup): **2.4–4.4 seconds**, and **0.3 seconds** when the file already exists.

- **`paper_status` now reports the converter.** If there is no
  anydoc/markitdown, that is said **before** the user tries and fails — along
  with how to install it.

### Fixed

- **A loose arXiv title filter — caught before release.** The rule "the title
  contains the title" accepted papers that were DIFFERENT: measured, the title
  *"Attention Is All You Need"* also accepted *"Not All Attention Is All You
  Need"* and *"Element-wise Attention Is All You Need"* — and **the first one
  could be the one downloaded**. `titleSimilarity()` is now **strict**: exactly
  equal after normalization, or contained with a length ratio ≥ 0.92.
- **The Node `DEP0190` warning is gone.** Running `anydoc.cmd` with
  `shell: true` triggered a warning that arguments were not escaped. It now uses
  `cmd.exe /d /c <script> <arg…>` — same behavior, no warning.
- **An arXiv id is no longer stamped "chosen from the TITLE".** An arXiv id
  input gets its own `arXiv: …` line, not a misleading warning.

### Notes — limits still enforced

- **OPEN-ACCESS copies only.** No breaking through paywalls, no Sci-Hub or
  Anna's Archive. If there is no legitimate copy, `paper_fulltext` **fails
  honestly** and states what it did not do. Measured on
  `10.1145/3290605.3300233` (ACM, closed): it failed, along with the list of
  candidates.
- **Conversion is ALWAYS local.** `anydoc` has a `--ocr hosted` mode that sends
  the document to Firecrawl; this plugin **never** uses it.
- **Files are not deleted automatically.** The `~/.dsh/paper-search/` library
  grows by ±2–3 MB per paper (PDF + Markdown). The folder can be changed through
  the `folderTeksLengkap` plugin config.
- ⚠️ **README versions ≤ 0.1.5 said "does not download PDFs" — that is no longer
  true.** The sentence was fixed in this release.

### Tested

- `node test/test-sources.mjs` — **77/77 passed** (17 sources, 14 answered).
- `node test/test-plugin.mjs` — **57/57 passed**; `paper_fulltext` was called for
  real: download **and** conversion, then proven that its `.md` file exists on
  disk and its content really is that paper.
- `node test/test-in-dsh.mjs` — **27/27 passed** on a real DSH 0.2.0-rc.1.
- **~20 new regression assertions**: six `titleSimilarity()` cases (including two
  fake titles that used to pass), five arXiv id cases, four `pdfCandidates()`
  cases (which prove arXiv is tried **first**), two `fileSlug()` cases, and
  `findConverter()`.

## [0.1.5] - 2026-09-29

Two **feature suggestions** from issues/PRs in the upstream repo
`openags/paper-search-mcp` — both cite their numbers. This release adds **one
source** (16 → 17) and **two tools** (2 → 4). Everything measured 29 Sep 2026.

### Added

- **Source `acm` — ACM Digital Library, WITHOUT an API key** (upstream PR
  **#123**). Upstream, `acm.py` is a skeleton that always throws
  `NotImplementedError`, so `PAPER_SEARCH_MCP_ACM_API_KEY` **could never** be
  filled with a valid value — the source is impossible to bring to life through a
  key. ACM has no public search API, but **its entire output is registered in
  Crossref under one DOI prefix**, and that prefix can be filtered:
  `filter=prefix:10.1145`. Measured: `"eye tracking"` → **3 results, 520 ms**,
  all `10.1145/…` (Crossref records 7.6 million ACM works).

- **Tool `paper_citations`** (upstream PR **#96**) — the OpenAlex citation graph,
  free and keyless:
  - `direction: "citing"` = papers that **cite** this work (forward
    snowballing);
  - `direction: "references"` = works **cited** by this paper (backward
    snowballing).
  Input may be a **DOI, an OpenAlex id/link (`W…`), or a TITLE**. Measured on
  `10.1145/3290605.3300233`: **2,257 citing** and **35 references**.

- **Tool `paper_oa`** (upstream PR #96) — open-access copies through OpenAlex,
  **without needing an Unpaywall email**. It states the status
  (gold/green/hybrid/bronze/closed), the PDF & page links of each copy, the
  license, and the version. Measured: `10.1371/journal.pone.0266789` → **gold, 3
  copies** (cc-by, publishedVersion); while a closed ACM paper is answered as it
  is (`NOT OPEN ACCESS`) along with the next steps.

- **The citation count is also shown** in `paper_search` results when the source
  reports it (OpenAlex, Semantic Scholar). `null` means **unknown** — and is
  distinguished from `0`.

### Notes — what was measured, and what is DELIBERATELY NOT claimed

- **ACM results are not marked "open access".** PR #123 says ACM DL has been open
  since 1 Jan 2026, but **re-measured here and it does not support that**:
  `HEAD https://dl.acm.org/doi/pdf/<doi 2026>` answered **HTTP 403**, and only
  **9 of 20** ACM 2026 publications have a `license` field in Crossref. A source
  that claims OA without evidence is worse than one that does not claim it.
- **Why TWO tools, not THREE like upstream.** Every tool is re-sent to the model
  on **every** request. The two citation directions share one schema because
  their input shape is identical. This is the same reason this plugin does not
  use the 57-tool MCP bridge from PR #97.
- **Selecting by TITLE can be wrong.** Measured: the title *"Attention is all you
  need"* returned a duplicate record (`W2626778328`) with a strange DOI. That is
  why the output **always** states which work was actually used, so a wrong pick
  is visible.

### Fixed

- **A title treated as a DOI — a bug in this release's new code, caught before
  release.** `normalizeDoi()` only stripped the URL prefix and then checked
  length, so it accepted **almost any text**; using it to decide "is this a
  DOI?" made `"zzzqqqxxyy cannot possibly exist"` answered as *"DOI … not
  found"* instead of being searched as a title. The decision now uses `isDoi()`,
  and `normalizeDoi()` is only used **after** it passes. There is a regression
  guard for it.
- **OpenAlex HTTP 429 & 504 are translated.** Measured 29 Sep 2026:
  `works/doi:…` once answered **HTTP 504 "Gateway timeout"** (JSON body
  `reason: query_timeout`). Previously the user only saw "HTTP 504"; now the
  message states that it is **transient** and just needs retrying. The 429 one
  also states how to raise the limit.
- **The plugin test no longer dies outright when the network fails.** One
  `HTTP 504` made the test script stop **before the summary was printed** — a
  transient failure looked like a defect. It is now wrapped, and appears as a
  **readable FAIL**. (That was a test bug, not a plugin bug.)

### Tested

- `node test/test-sources.mjs` — **58/58 passed** against real APIs & pages,
  **14 of 17 sources answered** (the failures are reported as they are: OpenAlex
  429 and PubMed Central HTTP 500 — both transient).
- `node test/test-plugin.mjs` — **46/46 passed**; both new tools were called for
  real until they returned data.
- `node test/test-in-dsh.mjs` — **26/26 passed** on a real DSH **0.2.0-rc.1**.
  The witness from inside the harness recorded `schemas=Array(4): paper_search,
  paper_status, paper_citations, paper_oa`.
- **~40 new regression assertions**: a source-count guard, the Crossref mapping
  shared by two sources, five `summarizeOA` cases, six `summarizeWork()`/
  `isWorkId()` cases, citation-count dedup (`null` ≠ `0`), and a guard that
  "`isDoi` is used to decide a DOI".

## [0.1.4] - 2026-09-28

Four fixes **learned from Issues & PRs in the upstream repo
`openags/paper-search-mcp`** — each cites its issue, none invented.

### Fixed

- **PubMed & PMC were sorted by DATE, not relevance** (upstream issue #29).
  `esearch` was never given `sort`, and the PubMed default is newest-date. For
  broad queries that is bad: what appears is new tangential papers, not
  foundational ones. It now uses `sort=relevance`.

  Measured on `"ocular microbiome"`: the top changed from a tangential 2026 paper
  to *The Microbiome, Ocular Surface, and Corneal Disorders* (2023) and *The
  Ocular Microbiome in Stevens-Johnson Syndrome* (2021) — exactly as that issue
  predicted.

- **Author names could be split PER CHARACTER** (upstream issue
  #109/#110/#112). The connector passed a **string** into a list-typed field,
  then the consumer `join`ed that string — `"TAN, Kwan Hong"` became
  `"T; A; N; ,;  ; K; w; a; n; …"`. Added `authorList()`, which accepts a string,
  an array of strings, an array of objects (`{name}`, `{display_name}`,
  `{given,family}`), the nested OpenAlex shape (`{author:{display_name}}`), and
  missing fields — and **never throws**.

  `authorList()` **deliberately does NOT split on commas**: `"TAN, Kwan Hong"` is
  ONE author. Only semicolons are separators. Connectors whose source really does
  use a comma-separated list (DOAJ `authorString`, IACR) split it first, then
  normalize.

- **arXiv: multi-word queries are now precise first, loose as a fallback**
  (upstream issue #6/#101/#113). The form `all:word1 AND all:word2` is used
  first; only if it is empty is the loose form run.

  **Why NOT simply copy the upstream fix** that quotes the phrase: **measured 28
  Sep 2026** — for the Indonesian query `"literasi digital"`, the quoted form and
  the AND form both gave **0 results**, while the loose form gave **50**. arXiv
  is an English-language corpus; quoting blindly would delete ALL results for
  non-English topics. So what is used is precision-**with**-fallback.

- **arXiv HTTP 406 sometimes still carries a VALID Atom feed** (upstream issue
  #121). Previously a 406 was immediately treated as a failure. Now the response
  body is parsed first — that issue reports a 406 with a 5,250-byte body
  containing 2 valid entries. For that, `getText()` now stores `err.fullBody`
  separately from `err.body` (which stays short for error messages).

### Added

- **15 new regression assertions**: 9 author shapes (including the #109 bug
  case), 3 arXiv query shapes, a `sort=relevance` guard, and a guard for the 406
  body rescue.

### Notes — already present, NO change needed

Checked against upstream issues, and it turns out these have been handled since
0.1.0: a 25-second timeout per request (issue #55), unknown-source reporting
(issue #105), cross-source dedup (issue #33), and the principle of reporting
failures instead of "0 results" (issue #100/#111).

**Upstream PR #97** (`feat: DeepSeek Harness (dsh) integration`) uses the **MCP
bridge** path that exposes **57 tools** — exactly the route we discarded because
it costs **12,342 tokens per request**. This plugin registers **2 tools**. So
that PR confirms our decision, it does not change it.

## [0.1.3] - 2026-09-28

### Fixed

- **Indonesian portals reported FAILED when the result was simply EMPTY.** All
  three Indonesian connectors threw `markup ... changed` whenever the result
  marker was not found — including when that portal **legitimately answers zero
  results**. That is wrong in the opposite direction from this package's
  principle: reporting a failure where it should be empty is as misleading as
  hiding a failure.

  Found from an **orchestration test**, not a unit test: `Sinta` failed for
  `"literasi digital remaja"` while succeeding for `"pendidikan karakter"`.
  After comparing the empty page and the page with results, it turned out all
  three portals have their own zero-result marker:

  | Portal | Zero-result marker | Empty page |
  |---|---|---|
  | Garuda | `Found 0 documents` | 11,181 characters |
  | Sinta | the `Results for "<q>"` header stays, zero profile links | 34,063 characters |
  | IOS | `No Results!` | 23,041 characters |

  `portalHasNoResults()` now distinguishes **three** possibilities — zero results
  (→ `[]`), changed markup (→ error), and blocked (→ error) — not two.

  The consequence for Sinta: a specific query that really has zero results no
  longer looks like a defect. Sinta lists **journals**, not articles, so zero
  results is reasonable and is now reported as zero.

### Added

- 3 regression assertions: a nonsense query to all three Indonesian portals must
  produce **0 results without an error**.

## [0.1.2] - 2026-09-28

### Fixed

- **Garuda titles could still be duplicated.** The fix in the previous release
  only handled **exact** repetition (`X X X`). After measuring **50 real titles**
  (5 queries, taken as-is from Garuda pages), it turned out there are **four**
  repetition shapes, not one:

  | Shape | Example | Length |
  |---|---|---|
  | A — exact period | `X X X X X X` | 255 → 43 |
  | B — repeated after `": "` | `X: X` | 194 → 96 |
  | C — prefix then `X: X` | `NLP, Machine Learning X: X` | 270 → 145 |
  | D — phrase repeated at the start | `IMPLEMENTASI PENDIDIKAN KARAKTER IMPLEMENTASI …` | 306 → 295 |

  `collapsePeriodic()` was replaced by **`collapseTitle()`**, which handles all
  four, including repetition with **different capitalization** (252 → 125) —
  Garuda really does often repeat a title in uppercase then lowercase.

  **Most important, and this is what is tested:** **valid** titles in the form
  `Title: subtitle`, `Title: (case study)`, and `Title: keywords` are **not**
  truncated. That is why the rule requires the part after `": "` to be genuinely
  **equal** to the tail of the previous part — not merely that a colon exists. On
  those 50 titles the result was: **14 collapsed, 36 left alone, 0 broken**, and
  **15 colon titles left intact**.

### Added

- **11 new regression assertions** in `test/test-sources.mjs`, using text taken
  as-is from Garuda. Five of them specifically guard that **valid** titles are
  not truncated — without them, the rule could "pass" merely by cutting every
  title that has a colon.

## [0.1.1] - 2026-09-28

### Fixed

- **The plugin failed to load at all — a mandatory fix.** DSH requires every
  tool to declare `output: { schema, render }`. Version 0.1.0 did not have that,
  so `ctx.tools.register` **threw**:

  ```
  TypeError: tool "paper_search" must declare output { schema, render, presentationMeta? }
  ```

  Because that throw happened inside `apply()`, **the entire plugin was cancelled
  from loading** — both tools **and** its skill were never registered. A 0.1.0
  user would not see `paper_search` at all.

  Found through a **real DSH boot test**, not through a mock `ctx` test: a mock
  `register` only stores the definition, so it never enforces this requirement.
  This is the proof that a mock cannot replace the real harness.

  **If you installed 0.1.0, upgrade to 0.1.1.**

### Added

- `test/test-in-dsh.mjs` — a **real DSH boot test.** It copies the `headless`
  profile to a test profile (the live `desktop` profile is **not touched**),
  inserts this plugin plus one **witness plugin**, runs a real DSH, then checks
  from the INSIDE that: both tools are registered, the skill provider is
  registered, the skill appears in the catalog, and `paper_search` is actually
  called until it returns a real paper. **22 assertions, 0 failures.**

  This test also records two already-measured traps, so they are not repeated:
  without `inject` the service is not visible from another plugin, and by the 4th
  second the harness has already torn down its plugins so checks **must** run
  inside `apply()`.

## [0.1.0] - 2026-09-28

First release.

### Added

- **Sixteen sources through one `paper_search` tool**, all native HTTP:
  - **thirteen international** — Crossref, OpenAlex, DOAJ, Europe PMC, PubMed,
    PubMed Central, arXiv, Semantic Scholar, CORE, Zenodo, HAL through JSON REST
    APIs; IACR ePrint through HTML parsing; Unpaywall through a REST API with
    **DOI input** (not keywords);
  - **three Indonesian portals** through public page parsing — Garuda (journal
    articles), Sinta (accredited journal list), IOS OneSearch (repository
    aggregator).
- **DOI-input sources are flagged in the registry** (`input: 'doi'`). When the
  user searches with keywords, `unpaywall` is **skipped** — not run and then
  reported empty — and the reason for skipping is printed in the output. When
  requested explicitly, it still runs and returns empty, because that is exactly
  how it behaves.
- **Two sources require credentials**, each reported as an actionable failure
  rather than a confusing 429: `core` needs `CORE_API_KEY`; `unpaywall` needs an
  email.
- **Dedup** by DOI then normalized title; every result records **all** sources
  that found it, rather than hiding the others.
- **Tool `paper_status`** — sends one small request to each source and reports
  which ones actually answer, plus which credentials were read **and where from**
  (plugin config / environment variables / the upstream CLI's `.env`).
- **Skill registration `paper-search`** through
  `ctx.get('skills').registerProvider()` at rank **450** — deliberately losing to
  files in `~/.dsh/skills` (rank 400) so user edits always win. Re-read every
  time, not cached, so a `SKILL.md` edit takes effect immediately without a
  restart.
- **Its own arXiv rate limiter** (1 request / 3 seconds) per their TOU, even
  though other sources are called in parallel.

### Fixed

- Garuda titles repeated by its `<xmp>` markup (measured: a 44-character title
  repeated ~6× to 255 characters) are now collapsed to a single copy. The rule is
  conservative — only when the repetition is exact from start to end.
- DOIs are normalized without the URL prefix (`https://doi.org/...`) so dedup
  works across sources.

### Honesty notes

- **Nine public sources are DELIBERATELY NOT registered**, each for a reason
  measured 28 Sep 2026 — not out of forgetfulness:

  | Source | Reason |
  |---|---|
  | `moraref` | landing page only, no result markup (3,964 characters) |
  | `dblp` | API behind bot protection — returns a "Making sure you're not a bot!" page, not JSON |
  | `openaire` | test requests **timed out at 30 seconds and 40 seconds** |
  | `biorxiv` | its API is **date-range** based, not keyword search |
  | `medrxiv` | same as `biorxiv` |
  | `base` | OAuth/OAI-PMH refused: `Access denied for IP address 182.8.249.89…` — needs institutional IP registration |
  | `citeseerx` | HTTP 404, then **hung** until the request was killed |
  | `ssrn` | refuses ordinary requests with HTTP 403 |
  | `google_scholar` | active bot detection, needs a proxy |

  A source that is always empty is worse than a source that does not exist, so
  the failures were dropped **along with their reasons** — not registered to make
  the count look big. The package description, README, SKILL.md, catalog entry,
  and `lib/index.js` all state the same number, and `lib/index.js` has a guard
  that warns if the count changes without the docs being updated.
  > **`iacr` and `unpaywall` WERE briefly on this list and then removed** after
  > re-testing: `iacr` answered HTTP 200 with parseable results, and `unpaywall`
  > answered HTTP 200 with a DOI. Treating "not a keyword searcher" as "dead" was
  > a mistake that has been corrected.
- **Source failures are never disguised as emptiness.** Every non-2xx throws an
  error along with its HTTP status, and both tools separate `FAILED` lines from
  `OK` lines. This is a direct fix for a weakness measured in a similar tool: its
  connectors returned an empty list for EVERY status != 200 without recording
  anything, so a rate-limited request read as "this literature does not exist".
- **CORE is the only source that REQUIRES a key.** Measured: without `Bearer` it
  answers HTTP 429 with an **empty** body — not 401. That is why a missing key is
  reported as an actionable message, rather than being left as a confusing 429.
- This package carries no API keys and no email addresses.

### Tested

- `node test/test-sources.mjs` — **8/8 passed** against REAL APIs and pages; **15
  of 16 sources answered**. Two transient failures were visible and **reported as
  they are**, not hidden as "0 results": Semantic Scholar briefly answered 429
  because of back-to-back testing (recovered after 150 seconds), and PubMed
  Central briefly answered HTTP 500 `error forwarding request` (E-utilities rate
  limit; previously 3 results on the same path).
- `node test/test-plugin.mjs` — **29/29 passed** with a mock `ctx`: both tools
  registered, the skill provider returned rank 450, the frontmatter parsed (348
  character description, under the 500 catalog limit), and both tools actually
  called the network.
