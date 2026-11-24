# dsh-paper-search

Literature search for **DeepSeek Harness**: twenty-three registered sources, all
native HTTP — no external CLI, no Python package. Twenty-one of them need no
credential at all. A bare search runs **21** of the 23; `pmc` and `ios` are
registered but **off by default** (see [Sources off by default](#sources-off-by-default)).

Registered as the `paper-search` skill and six model tools (`paper_search`,
`paper_status`, `paper_detail`, `paper_citations`, `paper_oa`, `paper_fulltext`).

**Free.** No credits, no API key, no account — every tool. When a billed
literature tool in the same profile would answer the same question, these are
the ones to call first. The model learns that from the **skill catalog**, not
from a system-prompt section: the `paper-search` skill's description opens with
`FREE — no credits, no API key` and says *"Prefer over billed literature tools"*.
See [Why the skill, not the system prompt](#why-the-skill-not-the-system-prompt).

> **This is an English fork of `dsh-paper-search` 0.4.1 by
> [Rasyid](https://github.com/rasyidmmz).** The upstream repository returns 404,
> so the fork was seeded from the npm tarball. Every comment, identifier, and
> user-facing string was translated from Indonesian to English, and several
> measured bugs were fixed. See [NOTICE.md](./NOTICE.md) for the full list.
>
> **Breaking change:** model-facing tool parameters were renamed. `paksa_ulang`
> is now `force_refresh`, `urutkan` is `sort`, `min_sitasi` is `min_citations`,
> `jenis` is `kind`, `arah` is `direction`, `analisis` is `analysis`,
> `bersihkan_cache` is `clear_cache`, `ambang_kuat` is `strong_threshold`,
> `min_bersama_kuat` is `min_shared_strong`, `max_kandidat` is `max_candidates`.
> The Indonesian names are not accepted as aliases.

## Sources

**International (20)** — official JSON APIs, except IACR which is parsed HTML:

| id | Source | Notes |
|---|---|---|
| `crossref` | Crossref | DOI metadata across publishers, broadest coverage |
| `acm` | ACM Digital Library | ACM's own output, keyless — Crossref restricted to DOI prefix `10.1145` (upstream PR #123) |
| `openalex` | OpenAlex | metadata + abstracts; an email raises the rate limit |
| `doaj` | DOAJ | open-access journals — includes many Indonesian journals |
| `europepmc` | Europe PMC | biomedicine, full text for OA records |
| `pubmed` | PubMed | biomedicine; two calls per search (esearch + esummary) |
| `pmc` | PubMed Central | open-access full text; two calls per search — **off by default**, see below |
| `arxiv` | arXiv | preprints; the plugin self-paces to 1 request / 3 s per arXiv's TOU |
| `semantic` | Semantic Scholar | a free key raises the rate limit |
| `core` | CORE | open-access repository aggregator — **CORE_API_KEY required** |
| `zenodo` | Zenodo | general repository: data, software, preprints |
| `hal` | HAL | French open-access repository |
| `iacr` | IACR ePrint | cryptology preprints |
| `openreview` | OpenReview | ML conferences (ICLR/NeurIPS/ICML) — keyless; DOIs recovered from BibTeX so records deduplicate against Crossref |
| `ssrn` | SSRN | economics/law/business preprints — **via OpenAlex**, because ssrn.com answers ordinary requests with HTTP 403 |
| `ieee` | IEEE | keyless — Crossref restricted to IEEE's member id `263`. **No abstracts**: Crossref does not carry them (citation counts *are* present) |
| `biorxiv` | bioRxiv | biology preprints — via OpenAlex source `S4306402567`; their own API has no keyword search at all |
| `medrxiv` | medRxiv | health preprints — via OpenAlex source `S3005729997` |
| `chemrxiv` | ChemRxiv | chemistry preprints — via OpenAlex source `S4393918830`; chemrxiv.org itself answers with a Cloudflare 403 |
| `unpaywall` | Unpaywall | **DOI input, not keyword** — resolves a DOI to its open-access copy; **email required** |

**Indonesian (3)** — parsed from public pages:

| id | Source | Notes |
|---|---|---|
| `garuda` | Garuda (Kemdiktisaintek) | Indonesian journal articles |
| `sinta` | Sinta (Kemdiktisaintek) | accredited **journals**, not articles |
| `ios` | IOS OneSearch (Perpusnas) | Indonesian repository aggregator — **off by default**, see below |

### Sources off by default

Two sources are **registered but not part of `all`**. They stay callable by name
(`sources: "pmc"`), but a bare `paper_search({ query })` no longer pays for them.
Each was turned off for a measured reason, not a guess:

| id | Why it is off | Measured |
|---|---|---|
| `pmc` | PubMed Central is the open-access full-text **slice of PubMed**, and it costs **two extra requests** (esearch + esummary) to NCBI for records `pubmed` already returned in the same run. The one thing it adds — full-text availability — `paper_fulltext` answers directly in one OpenAlex request. | 2026-11-23 |
| `ios` | The host does not answer from this machine at all: `UND_ERR_CONNECT_TIMEOUT` on both https and http after **10.5 s**, so every default search waited 10.5 seconds to collect zero results. It is an HTML scrape with no API, so there is no fallback. | 2026-11-23 |

Effect on a bare search, measured:

| | requests | wall clock |
|---|---|---|
| before (23 sources) | 23 | 10–25 s |
| after (21 sources) | 20 | 9.6 s |

`paper_status` still reports **all 23** — it is the doctor, and a source that is
off by default must not be able to break silently. It marks them:

```
  ?     PubMed Central     api      registered [off by default] (not probed — pass probe:true to test it)
  ?     IOS OneSearch      html     registered [off by default] (not probed — pass probe:true to test it)
note: a bare paper_search runs 21 of 23 sources. OFF BY DEFAULT: pmc, ios — registered and callable by name, but not part of "all".
```

### `sources: "all"` and the DOI-input source

`unpaywall` answers only when the query **is a DOI**. So when you search with
keywords, it is skipped rather than run and reported as an empty result — and
the output says so:

```
NOTE: unpaywall skipped because this query is not a DOI — that source
searches by DOI, not by keyword.
```

Pass a DOI and it runs. Pass `sources: "unpaywall"` with keywords and it runs
too, returning nothing — because that is genuinely how it behaves, and the
output says that rather than pretending the source is broken.

### Deliberately excluded, with the reason

Every exclusion was measured. An always-empty source is worse than an absent one,
so these are dropped rather than registered to look larger:

| Source | Reason |
|---|---|
| `moraref` | landing page only, no parseable result markup (3,964 characters) |
| `dblp` | API is behind bot protection — returns "Making sure you're not a bot!", not JSON (re-measured 2026-10-01) |
| `openaire` | test request **timed out at 30 s and again at 40 s** |
| `base` | OAI-PMH requires institutional IP registration (`Access denied for IP address …`) |
| `citeseerx` | returns HTTP 404, then **hangs** until the request is killed |
| `oaipmh` | OAI-PMH is a **harvesting** protocol, not search: the upstream module uses `verb=ListRecords` and never sends its `query` parameter, so results are unrelated to the query. Its default endpoint also answers HTTP 404 (measured 2026-10-02) |
| `google_scholar` | bot-blocked upstream; the upstream project reports the same |
| `scopus`, `wos` | paid subscription credentials — deliberately out of scope |
| `sci_hub` | ethics — this package only touches open access |

Sources that were **once** excluded and have since been measured as reachable are
listed in the table above instead: `ssrn` (via OpenAlex, 0.2.0), `biorxiv` and
`medrxiv` (via OpenAlex, 0.3.0), `chemrxiv` (via OpenAlex, 0.3.1), and `ieee`
(keyless via Crossref, 0.3.0).
| `google_scholar` | bot detection active; a proxy is required |

## Install

```sh
# from npm
dsh plugin --profile <profile> add dsh-paper-search

# or straight from the repository
dsh plugin --profile <profile> add github:nysparia/dsh-paper-search
```

The package ships a `dsh.bundle.patch`, so DSH installs its loader row
automatically. **Do not also write an `id: paper-search` row by hand** — the
loader throws `duplicate loader entry id` rather than warning.

Restart DSH after installing.

## Plugin options

| Option | Default | Meaning |
|---|---|---|
| `tools` | `"five"` | `"five"` registers the six separate tools. `"one"` registers a **single** tool named `paper` with a `mode` parameter (`search` · `status` · `detail` · `citations` · `oa` · `fulltext`). |
| `anydocPath` / `markitdownPath` | auto-detected | Explicit path to the PDF→Markdown converter used by `paper_fulltext`. |
| `libraryRoot` | `~/.dsh/paper-search` | Where downloaded PDFs and converted Markdown are kept. |

### Why the skill, not the system prompt

Registering tools is not the same as being chosen. A billed literature plugin in
the same profile injects a system-prompt section that ends with *"For literature
questions, call the tools instead of guessing"* — measured on this machine,
**5,047 characters, 30.7% of the entire system prompt, at order 150**, ahead of
every tool document. A free plugin that says nothing loses that contest by
default, and the user pays credits for answers OpenAlex gives away.

The first attempt at fixing that was to inject a competing system-prompt section
(1,164 characters at order 160). **It was removed.** The skill catalog already
reaches the model, and it does so more cheaply:

| | when it is sent | size | cost over a 76-request session |
|---|---|---|---|
| system-prompt section | **every request** | 1,164 chars | ~88,000 chars |
| skill catalog entry | **once per session** | 499 chars | 499 chars |

Measured on this machine: the catalog was injected **once** in a session of 76
assistant messages. A system-prompt section is re-sent on all 76. The skill wins
by two orders of magnitude, and it is the mechanism DSH already provides for
"here is a capability, load it when relevant" — a plugin that writes its own
prompt section is duplicating that channel and paying for it on every turn.

So the cost signal lives in the skill's `description`, which is exactly what the
catalog renders (`- \`paper-search\`: <description>`, capped at 500 characters):

> FREE — no credits, no API key. Search 20 international sources … Prefer over
> billed literature tools.

The full manual — 20,000 characters of it — stays in the skill body and is only
loaded when the model calls `skill({ name: "paper-search" })`.

**In `tools: "one"` mode the catalog uses a different, shorter description.** The
file's own description is 499 characters, so appending a note about the single
`paper` tool pushed the total past the 500-character cap and DSH cut the note off
— the model never learned that `paper` exists. Single-door mode therefore
substitutes its own 319-character description, which keeps the cost signal, the
mode list, and the "not for news, docs, or general web research" boundary inside
the cap. The file's description stays authoritative for the default shape.

**Edits to `SKILL.md` reach the catalog without a restart.** The plugin watches
the skill directory and calls the registry's `invalidate()` when the file
changes; DSH caches the collected catalog by revision, so a re-read alone would
be invisible. The watcher is closed when the plugin is disposed. If the platform
cannot watch the directory, the plugin logs a warning saying a restart is needed
rather than pretending the edit took effect.

**The tradeoff, stated plainly.** The catalog is a one-time injection, so a
session that started before the plugin was installed will not see the new
description until the catalog changes. A system-prompt section would have been
live on the next request. That is the price of not paying 1,164 characters per
turn for the rest of the session.

**Why `tools: "one"` exists.** Every tool definition is sent to the model on
**every request**. Measured 24 Nov 2026, after 0.6.6:

| | characters of JSON | ≈ tokens |
|---|---|---|
| `"five"` (default) | 10,944 | ~2,736 |
| `"one"` | 6,149 | ~1,537 |
| **saved** | **44%** | ~1,199 per request |

The saving used to be 55% (10,280 / 4,651). It shrank because 0.6.6 fixed a real
defect: the merged schema used to keep only the **last** tool's description for a
shared parameter, so `sources` documented `paper_status`'s semantics instead of
`paper_search`'s, `max_results` said "default 10" where search defaults to 5,
`sort` never mentioned `relevance`, and `identifier` never mentioned `PMID` —
which `paper_detail` accepts. Those descriptions are now merged per mode
(`search: … · status: …`), and the text that was silently dropped is back.

**What it costs, stated plainly.** Tool names stop describing themselves
(`paper_fulltext` no longer exists as a name; it becomes
`paper({ mode: "fulltext" })`), and one JSON schema cannot require different
arguments per mode — so per-mode required-argument checking moves from the
harness into the plugin. `paper({ mode: "oa" })` without an `identifier` is
rejected *by the plugin*, with a message that mirrors a schema rejection, instead
of by DSH *before* the call. That is why the default stays `"five"`.

An unrecognised value falls back to `"five"` and says so in the plugin's startup
note — it is never applied silently. The option is read from the plugin's config
in your DSH profile; the shipped skill adds a short note to its own body when
`"one"` is active, so the documentation never points at a tool name that does
not exist in that profile.

## Use

```
paper_search({ query: "machine learning" })
paper_search({ query: "pendidikan karakter", sources: "indonesia" })
paper_search({ query: "CRISPR", sources: "pubmed,europepmc,doaj", max_results: 10 })
paper_search({ query: "digital literacy", open_access_only: true, year_from: 2020 })
paper_search({ query: "eye tracking", sources: "acm" })           # ACM Digital Library only
paper_status()                    # configuration only, no network (default)
paper_status({ probe: true, sources: "crossref,openalex" })  # also prove they answer
paper_detail({ identifier: "10.1145/3290605.3300233" })                     # metadata + abstract
paper_detail({ identifiers: ["10.1145/…", "PMID:37074525", "1706.03762"] }) # BATCH: 2 requests per id type
paper_citations({ identifier: "10.1145/3290605.3300233" })                  # who cites it
paper_citations({ identifier: "10.1145/3290605.3300233", direction: "references" }) # what it cites
paper_oa({ identifier: "10.1371/journal.pone.0266789" })                    # free copy?
paper_fulltext({ identifier: "1706.03762" })                                # read the whole paper
```

For Indonesian topics, **use Indonesian keywords**: `"pendidikan karakter"`
returns real Indonesian journals, while the English equivalent returns
international results that do not match the intent.

## Paper detail — metadata + abstract (OpenAlex, free)

`paper_detail` returns everything a reader needs about a paper without opening
it: title, authors **with institutions and the corresponding flag**, year/date,
venue, publisher, citation count, **FWCI** and **field percentile**, **retraction
flag**, volume/issue/pages, reference count, topics, keywords, open-access
copies with licences, and the **full abstract**.

```
paper_detail({ identifier: "10.1145/3290605.3300233" })
paper_detail({ identifier: "PMID:37074525" })
paper_detail({ identifier: "1706.03762" })                        # arXiv id
paper_detail({ identifier: "Attention Is All You Need" })         # title
paper_detail({ identifiers: ["10.1145/…", "PMID:…", "1706.03762"] })   # BATCH
paper_detail({ identifiers: [...], abstract_chars: 300 })         # shorter abstracts
```

**Why the batch matters.** One call costs **two requests per identifier TYPE**,
not one per paper: 15 DOIs cost **2** requests. The same lookup done one paper
at a time is what made a billed Semantic Scholar detail tool the most expensive
tool measured on this machine — 60 calls / 60 credits, 31% of all billed spend,
and 15 of those were consecutive calls that a single batch would have answered
for 2 credits.

> **Why two requests and not one.** OpenAlex's list endpoint **silently omits
> retracted works** unless `is_retracted:true` is in the filter, and that flag is
> **AND**-ed with the identifier filter rather than OR-ed — so neither request
> alone sees both kinds. Measured 23 Nov 2026 with one retracted and one normal
> DOI:
>
> | filter | returns |
> |---|---|
> | `doi:A\|B` | 1 work — the **normal** one |
> | `doi:A\|B,is_retracted:true` | 1 work — the **retracted** one |
>
> There are **91,863** retracted works in OpenAlex. Without the second request
> every one of them would be reported as "not found" — the worst possible error
> for this tool, because a retracted paper is exactly the paper a reader most
> needs to be warned about. The reply prints `⚠ RETRACTED` when the flag is set.

Accepted identifiers: DOI (`10.…`), `PMID:123`, `PMC123`, arXiv id
(`1706.03762`), OpenAlex id (`W…`), or a **title**. A bare number is
deliberately **not** guessed as a PMID — it is far more likely a year or a typo,
and `pmid:2024` would silently return the wrong paper.

> **What OpenAlex does NOT have** — use the Semantic Scholar tools for these:
> the S2 `paperId`/`corpusId`, **citation contexts** (the sentence that cites),
> **citation intents** (background/method/result), and SPECTER2 embeddings.
> Everything else is here.

> **"Not found in OpenAlex" does not mean the paper does not exist.** The output
> lists exactly which inputs were missing rather than silently returning a
> shorter list.

## Citation graph and open-access lookup

Two tools use OpenAlex — free, no key, no email (upstream PR #96):

- **`paper_citations`** walks the citation graph in either direction.
  `direction: "citing"` (default) lists papers that **cite** the work — forward
  snowballing; `direction: "references"` lists the works it **cites** — backward
  snowballing. The input may be a **DOI, an OpenAlex id (`W…`), or a title**.
- **`paper_oa`** reports the open-access status (gold/green/hybrid/bronze/closed)
  and every OA copy with its PDF/landing link, licence, and version. It does not
  need the Unpaywall email that the `unpaywall` source requires.

Three limits are reported rather than hidden:

1. **Title input can resolve to the wrong record.** Measured 2026-09-29: the
   title *"Attention is all you need"* resolves to `W2626778328`, a duplicate
   record with an unrelated DOI. Every output therefore names the work it
   actually used — check that before drawing conclusions.
2. **Backward snowballing reads at most 100 references** per call, so
   "most cited first" applies only among those examined.
3. **A source that fails says so.** `paper_citations`/`paper_oa` translate
   OpenAlex's 429/503/504 into an actionable sentence instead of a bare status
   code.

This plugin does **not** download PDFs for `paper_citations`/`paper_oa` — those
two only report what exists. Downloading is `paper_fulltext`'s job, below.

## Full text: open-access PDF → Markdown

`paper_fulltext` fetches the **full text** of a paper so an agent can read it,
not just its title and abstract. It accepts a DOI, an OpenAlex id (`W…`), an
**arXiv id** (`1706.03762`), or a title.

```
paper_fulltext({ identifier: "1706.03762" })                      # arXiv id
paper_fulltext({ identifier: "10.1371/journal.pone.0266789" })    # OA DOI
paper_fulltext({ identifier: "Attention Is All You Need" })       # title
paper_fulltext({ identifier: "…", force_refresh: true })            # force re-download
```

How it finds the PDF — **arXiv first**, which is upstream PR #124:

1. the work's own arXiv id (from `10.48550/arXiv.<id>` or an arXiv location), or
   else the arXiv version **looked up by title**;
2. every open-access PDF location OpenAlex reports;
3. Unpaywall, last, using the configured email.

Then the PDF is saved next to its Markdown in `~/.dsh/paper-search/md/`
(override with the `libraryRoot` plugin option), converted **locally** by
`anydoc` — fallback `markitdown` — and the tool returns the file paths, the
source it used, and either the **whole text** (when ≤ 20,000 characters) or a
preview plus the `read({ file_path, offset, limit })` call to continue with.

Measured 2026-09-29: *Attention Is All You Need* (2.1 MB PDF) → **39.8 KB of
Markdown in 424 ms**; a PLOS ONE paper (2.9 MB) → **70.8 KB in 363 ms**, with
reference links intact. End to end through the tool, including download and the
arXiv lookup: **2.4–4.4 s**, and **0.3 s** when the file already exists.

Install a converter (neither is bundled):

```sh
npm i -g @firecrawl/anydoc     # recommended: Rust binary, no Python
uv tool install markitdown     # fallback
```

`paper_status` reports which converter was found and where — **before** you hit a
failure.

### Limits that are stated, not hidden

1. **Open-access copies only.** If no legitimate free copy exists, the tool
   **fails and says so**, listing the candidates it tried. It never bypasses a
   paywall and never uses Sci-Hub or Anna's Archive.
2. **Conversion is always local.** `anydoc` has an `--ocr hosted` mode that
   uploads the document to Firecrawl; this plugin never uses it.
3. **Title lookups can pick the wrong work.** Measured: the title *"Attention is
   all you need"* resolves in OpenAlex to `W2626778328`, a duplicate record. Every
   output names the work it actually used — check it before trusting the result.
   A DOI or an arXiv id is safer.
4. **Files are never deleted for you.** The library grows ~2–3 MB per paper
   (PDF + Markdown).

## Verification status

> **Fork note.** The `test/` directory is **not** part of the published npm
> tarball, so the suites named below are not in this repository — the numbers
> are the upstream author's, carried over unchanged, and they describe the
> **five-tool** 0.4.1 code, not this fork. What this fork *did* verify, against
> the translated code, is listed in [NOTICE.md](./NOTICE.md): every module
> loads, all six tools register with the renamed parameters, and
> `paper_search` / `paper_detail` (single and batch) / `paper_oa` /
> `paper_citations` (both `list` and `map`) were run against live APIs. The bug
> fixes were each confirmed with a before/after comparison against the 0.4.1
> baseline.

Stated precisely, because "tested" on its own is not a useful claim:

**Verified — the citation map, against live OpenAlex.** `paper({ mode: "citations",
analysis: "map" })` was run on a real seed: bibliographic coupling surfaced *Questioning
the AI* (0.143), co-citation surfaced LIME's *"Why Should I Trust You?"* (cited alongside
8 times), a 5-paper XAI cluster formed, and the top bridge was a genuine survey spanning
7 clusters. **2 OpenAlex requests**, about 2 seconds. The pure math is covered offline by
`node test/test-citation-map.mjs` — **42/42 assertions**, including two mutation self-tests
(raising the thresholds must actually split the clusters, or the guard is vacuous).

**Verified — the search cache, with the network deliberately killed.** `node
test/test-cache-search.mjs` — **34/34 assertions** with a faked clock. Live, through the
tool: a repeat search went from **3,062 ms to 0 ms** with the output saying so, and with
the network switched off the cached search still answered while `force_refresh: true`
correctly failed (proof it really bypasses the cache rather than silently using it).

**Verified — the download guard, against a real PDF.** `node test/test-fulltext.mjs` —
**43/43 assertions**, 27 of them new: four URLs that must be allowed, twelve that must be
refused, three anti-over-blocking bounds, and five redirect scenarios including relative
`Location` and an endless loop. Live, `paper_fulltext` fetched a real arXiv PDF and
converted it to Markdown (39.8 KB) in 2 seconds, so the guard does not break the
legitimate path.

**Verified — the connectors, against live APIs and pages.** `node test/test-sources.mjs`
runs all twenty-three against the real services: **79/79 assertions, 1 skip**. On the last
run **22 of 23 answered**; the one that did not was `ios` (IOS OneSearch) with a
network-level `fetch failed`. That was **verified not to come from this release**: the
previously installed build fails on the same source in the same way, so the site was
simply unreachable — and the test now reports that as a skip rather than a failure.
Source `acm` answered with real ACM records in 670 ms. The sources added since 0.2.0
answered with real records too — `openreview` in 1.8 s (with DOIs recovered from
BibTeX, so its records merge with Crossref on deduplication), `ssrn` in 2.3 s, `ieee` in
1.6 s, `biorxiv` in 1.0 s, `medrxiv` in 0.9 s, and `chemrxiv` in 0.5 s.

**Verified — the wiring, against a mock Cordis context.** `node test/test-plugin.mjs`,
**62/62 assertions**: all five tools register, the new tools are actually called
and return data, `paper_fulltext` downloads *and* converts a real paper with the
resulting `.md` checked on disk, the skill provider reports rank 450, the
frontmatter parses within the 500-character catalogue limit, and every tool
declares the `output: { schema, render }` that DSH requires.

**Verified — loading the bundle inside a live harness.** `node test/test-in-dsh.mjs`
copies the `headless` profile to a throwaway test profile, inserts this plugin
plus a witness plugin, boots a real DSH (0.2.0-rc.1), and checks **from inside**
that all five tools are registered, the skill provider is registered, the skill
appears in the catalogue, and `paper_search` is actually called and returns real
papers. **27 assertions, 0 failures.** The witness records
`schemas=Array(15): paper_search, paper_status, paper_citations, paper_oa,
paper_fulltext, …`.

That last test earned its place: it caught a fatal bug the mock never could.
DSH requires every tool to declare `output: { schema, render }`, and 0.1.0 did
not — so registration threw, and because the throw happened inside `apply()`,
the whole plugin failed to load. **0.1.0 is unusable; use 0.1.1.**

## What makes the reporting honest

Every result separates **sources that failed** from sources that answered:

```
  v Crossref            3 results  (2316 ms)
  x Semantic Scholar    FAILED — HTTP 429 — {"message": "Too Many Requests...
  v Garuda              3 results  (1428 ms)
```

A source that fails is never allowed to masquerade as "no results". This is not
a detail: a widely-used tool in this space returns an empty list for *every*
non-200 response with no error recorded at all, so a rate-limited request reads
as "this literature does not exist". Here, the failure and its HTTP status are
printed, and `paper_status` exists to prove liveness on demand.

## Credentials (all optional)

No key is bundled. Read order:

1. plugin config in your DSH profile,
2. environment variables `PAPER_SEARCH_MCP_<NAME>`, then `<NAME>`,
3. the file `~/.config/paper-search-mcp/.env` (belonging to the upstream CLI).

| Name | Purpose |
|---|---|
| `OPENALEX_API_KEY` | **the one that matters most.** Free key: 10× daily budget, 30 req/s instead of 10, and required for cursor paging. Without it OpenAlex shares one budget across everyone on your IP address |
| `UNPAYWALL_EMAIL` | any email — the Crossref/OpenAlex `mailto` contact |
| `OPENALEX_EMAIL` | same, OpenAlex only |
| `SEMANTIC_SCHOLAR_API_KEY` | raises Semantic Scholar rate limits |
| `DOAJ_API_KEY` | raises DOAJ's hourly limit |
| `CORE_API_KEY` | **required for the `core` source** — without it CORE answers HTTP 429 with an empty body |

### Why `OPENALEX_API_KEY` is worth setting

OpenAlex is the backend for **five** of the six tools — `paper_detail`,
`paper_citations`, `paper_oa`, `paper_fulltext`'s work lookup, and the `openalex`
/ `ssrn` / `ieee` / `biorxiv` / `medrxiv` / `chemrxiv` search sources. Its limits
are the ones you actually feel:

| | no key | free key |
|---|---|---|
| Daily budget | shared by everyone on your IP | **10×**, yours alone |
| Requests/second | 10 | **30** |
| Cursor paging | first page only | full |

Measured 2026-11-23: without a key this machine hit `HTTP 429` and then
`ECONNRESET` partway through a test run, and the 429 body named the reason
exactly — *"this request has no API key, so it counts against the free daily
budget shared by everyone on your network's IP address"*.

Get one free at <https://openalex.org/settings/api-key> (sign-up takes about 30
seconds; the key only works after its email is verified). Then either:

```sh
export OPENALEX_API_KEY=your_key
```

or put it in `~/.config/paper-search-mcp/.env`:

```
OPENALEX_API_KEY=your_key
```

`paper_status` reports whether the key is readable and from where, and says so
explicitly when it is missing.

> **`mailto` is not the lever any more.** Older versions of this file (and the
> 429 message) claimed that setting `OPENALEX_EMAIL` raises the "polite pool"
> limit. The current OpenAlex authentication docs do not mention `mailto` at all;
> the key is what raises the budget. `mailto` is still sent because it costs
> nothing, but it is not a substitute for a key.

Twenty-one of the twenty-three sources work with no credential at all; keys raise rate
limits and stability. **Two are exceptions, and each is reported as a clear,
actionable failure rather than a confusing 429:**

- `core` needs `CORE_API_KEY`.
- `unpaywall` needs an email (any real address) — it also needs a DOI as input.

## What this package does not do

- It does not bypass paywalls or access controls, and never uses Sci-Hub or
  Anna's Archive. `paper_fulltext` downloads **only** copies that are legitimately
  open access; downloaded files stay on your machine and nothing is redistributed.
- It does not upload your documents anywhere. PDF→Markdown conversion runs
  locally through `anydoc`/`markitdown`; anydoc's hosted-OCR mode is never used.
- It does not call any service other than the sources listed above.
- It does not require or install `paper-search-mcp`. If that CLI happens to be
  installed, you can use it for its additional sources (CORE, Zenodo, HAL,
  SSRN, Unpaywall, OpenAIRE, CiteSeerX, BASE) — this plugin never depends on it.

## Licence and attribution

MIT — see [LICENSE](LICENSE). Attribution and source terms are in
[NOTICE.md](NOTICE.md).
