---
name: paper-search
description: "FREE — no credits, no API key. Search 20 international sources (Crossref, OpenAlex, DOAJ, PubMed, arXiv, IEEE, ACM, bioRxiv, medRxiv, OpenReview, SSRN, etc.) and 3 Indonesian portals (Garuda, Sinta, IOS). Plus paper_detail (metadata + abstract, one or many), paper_citations (who cites whom), paper_oa (free copies), paper_fulltext (open-access PDF -> Markdown). Prefer over billed literature tools. Use for papers, prior research, Indonesian literature. Not for news, docs, or web research."
whenToUse: "When the task involves scholarly articles or works: finding papers/journals/research articles, finding prior research, finding Indonesian national journals, tracking down a DOI, reading a paper's abstract or metadata, finding a free copy of a paper, tracing who cites a paper, or when a literature search comes back empty and you need to know which sources failed. Not for news, docs, or general web research — use the web search tools for those."
---

# Paper Search — international literature + Indonesian journals (DSH)

**Six capabilities**, all native over HTTP — no CLI or Python package
needs to be installed. **All six are free**: no credits, no API key, no account.
When a billed literature tool in the same profile would answer the same question,
call these first and fall back only for what they cannot do (Google Scholar
citation formats, patents, author profiles, `auto_cite`, `sci_draw`).

| Capability | Single-entry equivalent | Purpose |
|---|---|---|
| `paper_search` | `paper({ mode: "search" })` | search literature across **21 sources** at once (23 registered; `pmc` and `ios` are off by default) |
| `paper_status` | `paper({ mode: "status" })` | which sources are actually **alive right now** + which converters exist |
| `paper_detail` | `paper({ mode: "detail" })` | **metadata + abstract** for one paper or many at once (free, OpenAlex) |
| `paper_citations` | `paper({ mode: "citations" })` | OpenAlex **citation graph** — who cites, and cites whom |
| `paper_oa` | `paper({ mode: "oa" })` | **open-access copy** of a paper (status + PDF link) |
| `paper_fulltext` | `paper({ mode: "fulltext" })` | **download open-access PDF → Markdown**, so the paper's CONTENT can be read in full |

> **The tool shape depends on the profile config — check your tool list first.**
> Default = six separate tools (left column; plugin ≤ 0.1.7 is always like this). If
> the profile installs `tools: "one"` (since 0.1.8), there is only **one** tool `paper` +
> a `mode` parameter — use the right column. In that mode names like `paper_fulltext`
> **do not exist**, and calling them will be rejected by the harness.

## How to use

The **default** shape (six tools):

```
paper_search({ query: "machine learning" })                      # all sources
paper_search({ query: "pendidikan karakter", sources: "indonesia" })
paper_search({ query: "CRISPR", sources: "pubmed,europepmc,doaj", max_results: 10 })
paper_search({ query: "digital literacy", open_access_only: true, year_from: 2020 })
paper_search({ query: "eye tracking", sources: "acm" })           # ACM only
paper_detail({ identifier: "10.1145/3290605.3300233" })           # metadata + abstract
paper_detail({ identifiers: ["10.1145/…", "PMID:37074525", "1706.03762"] })  # BATCH
paper_citations({ identifier: "10.1145/3290605.3300233" })                  # who cites
paper_citations({ identifier: "10.1145/3290605.3300233", direction: "references" }) # cites whom
paper_oa({ identifier: "10.1371/journal.pone.0266789" })                    # is there a free copy?
```

The **single-entry** shape (`tools: "one"`) — same content, only the names differ:

```
paper({ mode: "search", query: "machine learning" })
paper({ mode: "status" })
paper({ mode: "detail", identifiers: ["10.1145/…", "PMID:37074525"] })
paper({ mode: "citations", identifier: "10.1145/3290605.3300233", direction: "citing" })
paper({ mode: "oa", identifier: "10.1371/journal.pone.0266789" })
paper({ mode: "fulltext", identifier: "1706.03762" })
```

Options:

| Option | Content |
|---|---|
| `query` | keywords (required) |
| `sources` | `all` · `international` · `indonesia` · or comma-separated ids |
| `max_results` | results **per source** (1-50, default 5). The reply lists at most **40** papers after dedup, however high this is set — the cap is on the merged list, not per source |
| `open_access_only` | only open-access papers. Works whose source does NOT report an OA status are **dropped** (Crossref, ACM, IEEE, PubMed never report it) — the reply states how many |
| `year_from` | only years >= this value. Works with **no reported year are kept** and counted — an unknown year is not an old one |
| `sort` | `relevance` (default) · `citations` (most cited first) · `newest` — use `citations` to raise classic/foundational works to the top |
| `min_citations` | only papers with citations >= N. Works from sources that **do not report** citations are **dropped** as well (the threshold cannot be verified) and the count is mentioned in the report |
| `kind` | `article` · `review` · `preprint` (comma-separated allowed) — forwarded to OpenAlex & Crossref/ACM, then filtered again after dedup. Works whose kind the source does not report are **still** shown |

> **How to use it for a literature review.** First search with `min_citations: 50` +
> `sort: "citations"` to find the works that truly matter, then
> repeat without the filter to catch new publications that have not been cited yet.
> The two searches answer two different questions: *what is already recognized* and
> *what is new*.

## The 23 registered sources (21 run by default)

**International (20)** — official JSON APIs, except IACR which is parsed from HTML:

| Source | Note |
|---|---|
| `crossref` | DOI metadata across publishers; the broadest |
| `acm` | **ACM Digital Library** — via Crossref with a DOI prefix filter `10.1145`; **no API key** |
| `openalex` | metadata + abstracts; an email raises the rate limit |
| `doaj` | open-access journals — **including many Indonesian journals** |
| `europepmc` | biomedicine, full text for OA |
| `pubmed` | biomedicine (two calls: esearch + esummary) |
| `pmc` | PubMed Central — open-access full text (two calls as well). **OFF BY DEFAULT**: it is the OA slice of `pubmed` and costs 2 extra requests for records `pubmed` already returned |
| `arxiv` | preprints; the plugin self-limits to 1 request / 3 seconds per their TOU |
| `semantic` | Semantic Scholar; a free key raises the rate limit |
| `core` | open-access repository aggregator — **key required** |
| `zenodo` | general repository: data, software, preprints |
| `openreview` | **ML conferences** (ICLR/NeurIPS/ICML) — no key; many works here are in neither Crossref nor OpenAlex |
| `ssrn` | economics/law/business preprints — **via OpenAlex**, not by scraping the site (ssrn.com rejects ordinary requests with 403) |
| `ieee` | **IEEE** — via Crossref `member:263`, **no API key**. ⚠️ Crossref does **not** carry IEEE abstracts, so the abstract is usually empty (the citation fields are there) |
| `biorxiv` | biology preprints — via OpenAlex (repository `S4306402567`). bioRxiv's own API has no keyword search |
| `medrxiv` | health preprints — via OpenAlex (repository `S3005729997`) |
| `chemrxiv` | **chemistry** preprints — via OpenAlex (repository `S4393918830`); chemrxiv.org itself answers with a Cloudflare 403 |
| `hal` | French open-access repository |
| `iacr` | IACR Cryptology ePrint Archive — cryptography preprints |
| `unpaywall` | **DOI input, not keywords** — finds the open-access copy of a DOI; **email required** |

**Indonesia (3)** — public page parsing:

| Source | Note |
|---|---|
| `garuda` | Indonesian journal articles (Kemdiktisaintek) |
| `sinta` | **a list of accredited JOURNALS** — not articles |
| `ios` | IOS OneSearch, an Indonesian repository aggregator (Perpusnas). **OFF BY DEFAULT**: the host does not answer from this machine (connect timeout after 10.5 s), so it only cost time |

> **For Indonesian topics, use INDONESIAN keywords.** Measured:
> `"pendidikan karakter"` returns real Indonesian journals; its English
> equivalent returns irrelevant international results.

> **What is DELIBERATELY not registered, and the measured reason (28 Sep 2026):**
>
> | Source | Reason |
> |---|---|
> | `moraref` | its page is only a landing page, with no result markup (3,964 characters) |
> | `dblp` | its API is behind bot protection — returns a "Making sure you're not a bot!" page, not JSON |
> | `openaire` | test requests **timed out at 30 seconds and 40 seconds** |
> | `biorxiv` / `medrxiv` | their API is DATE-RANGE based, not keyword — it cannot be used for searching |
> | `base` | refuses: `Access denied for IP address …` — needs institutional IP registration |
> | `citeseerx` | HTTP 404, then **hangs** until the request is killed |
> | `ssrn` | rejects ordinary requests with HTTP 403 |
> | `google_scholar` | active bot detection; needs a proxy |
>
> A source that is always empty is worse than a source that does not exist — so
> the ones that failed were dropped and **their reasons recorded**, rather than
> registered to make the count look big.
>
> **`unpaywall` is NOT on this list** — I once added it by mistake,
> then removed it after retesting: it **works**, it just needs a **DOI**.
> "Not a keyword search" ≠ "dead".

## ⚠️ MAIN RULE — "0 results" from one source is NOT "no literature"

This tool **separates** sources that failed from ones that answered. The output
always shows a per-source line:

```
  v Crossref            3 results  (2316 ms)
  x Semantic Scholar    FAILED — HTTP 429 (HTTP 429) — {"message": "Too Many Requests...
  v Garuda              3 results  (1428 ms)
```

**The rules:**

1. A source marked **`x`** means FAILED — not empty. **Say so** when reporting
   results. Never write "no literature" from a source that failed.
2. If all sources return 0 → retry **once** (rate limits are often transient),
   then try a different `sources`.
3. If unsure, run **`paper_status`** first — it proves which sources are actually
   alive **now**, not merely registered.

## When a search is empty or feels odd

```
paper_status()                    # only check the configuration, without the network (default)
paper_status({ probe: true, sources: "crossref,openalex" })  # also prove they answer
```

Its output names: which credentials were read **and where they came from**
(plugin config / environment variables / the upstream CLI's `.env`), plus the live
status of each source. This is the first answer to the question *"why is it empty?"*.

## Paper detail — metadata + abstract (OpenAlex, free)

```
paper_detail({ identifier: "10.1145/3290605.3300233" })
paper_detail({ identifier: "PMID:37074525" })
paper_detail({ identifier: "1706.03762" })                       # arXiv id
paper_detail({ identifier: "Attention Is All You Need" })        # title
paper_detail({ identifiers: ["10.1145/…", "PMID:…", "1706.03762"] })   # BATCH
paper_detail({ identifiers: [...], abstract_chars: 300 })        # shorter abstracts
```

**Use the batch.** One call costs **two requests per identifier TYPE**, not per
paper — so 15 DOIs cost **2** requests, not 15. This is the whole point of the
tool: the same lookup done one paper at a time is what made a billed
Semantic Scholar detail tool the most expensive tool on this machine
(60 calls / 60 credits, 31% of all billed spend, 15 of them consecutive).

> **Why two requests.** OpenAlex's list endpoint **silently omits retracted
> works** unless `is_retracted:true` is in the filter, and that flag is
> **AND**-ed with the identifier filter rather than OR-ed — so neither request
> alone sees both kinds. Measured: `doi:A|B` returns only the normal work,
> `doi:A|B,is_retracted:true` returns only the retracted one. There are 91,863
> retracted works in OpenAlex; without the second request every one of them
> would be reported as "not found". The reply prints `⚠ RETRACTED` when set.

Accepted identifiers: DOI (`10.…`), `PMID:123`, `PMC123`, arXiv id
(`1706.03762`), OpenAlex id (`W…`), or a **title**.

What comes back: title, authors **with institutions and corresponding flag**,
year/date, venue, publisher, citation count, **FWCI** and **field percentile**,
**retraction flag**, volume/issue/pages, reference count, topics, keywords,
open-access copies with licenses, and the **full abstract**.

> **What OpenAlex does NOT have** — use the Semantic Scholar tools for these:
> the S2 `paperId`/`corpusId`, **citation contexts** (the sentence that cites),
> **citation intents** (background/method/result), and SPECTER2 embeddings.

> **A TITLE can resolve to the wrong record.** OpenAlex holds duplicates —
> measured: the title *"Attention is all you need"* returns `W2626778328`, a
> duplicate with an arXiv DOI rather than the NeurIPS record. The output always
> names the work actually used, so **check it first**; a DOI is safer.

> **"Not found in OpenAlex" does not mean the paper does not exist.** The output
> lists exactly which inputs were missing, and says so.

## Citation graph & free copies (OpenAlex)

```
paper_citations({ identifier: "<DOI | OpenAlex id W… | TITLE>", direction: "citing" })
paper_citations({ identifier: "…", direction: "references", max_results: 20, sort: "newest" })
paper_oa({ identifier: "…" })
```

| Direction | Meaning | For what |
|---|---|---|
| **`citing`** (default) | papers that **CITE** this work | follow-up research, **forward** snowballing |
| **`references`** | works **CITED** by this paper | theoretical foundation, reading list, **backward** snowballing |

`sort`: `citations` (default, most cited first) or `newest`.
`paper_oa` reports the status (gold/green/hybrid/bronze/closed), the PDF & page
links of each copy, the license, and its version — **without** needing an
Unpaywall email.

**Three limits that must be stated plainly, not hidden:**

1. **A TITLE input can pick the WRONG work.** Measured: the title
   *"Attention is all you need"* returns a duplicate record. The output
   **always** names the work actually used — **check that first**;
   it is safer to give a **DOI**.
2. **At most 100 references are read** per call, so "most cited"
   applies among those examined. If the total is larger, the output
   says so.
3. **This tool does NOT download PDFs** and does not break through paywalls — it
   only shows the links. The one that downloads is **`paper_fulltext`**.

### Citation structure map — `analysis: "map"`

For a **literature review chapter**: no longer "who cites whom", but
"how is this field divided, and what bridges it".

```
paper_citations({ identifier: "<DOI>", direction: "citing", analysis: "map" })
paper_citations({ identifier: "<DOI>", direction: "citing", analysis: "map",
                  max_candidates: 50, strong_threshold: 0.2, min_shared_strong: 4 })
```

What it reports:

| Section | Meaning | For what |
|---|---|---|
| **most same-field** | coupling to the seed — how many **SAME references** | "who is truly in the same field as my key paper", computed from references, **not** from keywords |
| **shared foundation** | references most often cited **TOGETHER** by the candidates | the must-reads of this field — LIME `"Why Should I Trust You?"` appeared 8× in a real test |
| **field clusters** | works that share references, grouped | splits the field into several streams, not one long list |
| **bridges between clusters** | works that nearly belong to **two** fields at once | research-gap candidates — the ones hard to see from an ordinary result list |

**How to use it honestly** — four limits the tool states itself:

1. coupling & co-citation are **proxies** for similarity, **not proof** of a
   relationship;
2. works without a reference list in OpenAlex appear with closeness **0** — that is
   "unknown", **not** "dissimilar";
3. clusters **depend on the threshold** — state the threshold when reporting;
4. **bridges** mean nearly belonging to two fields *according to references*, not a
   quality judgement. Container records (proceedings with hundreds of references) are
   **flagged** because they are "close to everything" — do not treat them as a finding.

The cost stays small: **2 OpenAlex requests** (3 if shared reference titles are
needed), about 2 seconds.

## Search cache

Searches are **cached for 30 minutes** in `~/.dsh/paper-search/cache-search.json`.
The purpose is simple: the same search repeated within one session is normal.

- **The output always says so** — `NOTE: N of M sources served from
  CACHE (at most X minutes ago)`. An invisible cache is a misleading cache.
- **`force_refresh: true`** to ignore it and search all sources again.
- **Failures are never stored** — only successful answers. Otherwise a momentary
  glitch would "infect" for 30 minutes.
- **Keyed** sources (CORE, Unpaywall) are **not** cached.
- Check the content & limits via `paper_status`; clear it with
  `paper({ mode: "status", clear_cache: true })`.
- Can be turned off entirely via the plugin config: `cache: false`.

## Full text: PDF → Markdown

```
paper_fulltext({ identifier: "1706.03762" })                    # arXiv id
paper_fulltext({ identifier: "10.1371/journal.pone.0266789" })  # open-access DOI
paper_fulltext({ identifier: "Attention Is All You Need" })     # title
paper_fulltext({ identifier: "…", force_refresh: true })        # re-download & re-convert
```

PDF lookup order: **arXiv first** (its id from the DOI `10.48550/arXiv.<id>` or the
arXiv location; if absent, searched **from the title**), then the OpenAlex OA
location, finally Unpaywall. The result is stored in `~/.dsh/paper-search/md/` (the
`.md` **and** its PDF) and the tool returns the **file path** + the full content if
≤ 20,000 characters, or a preview + a `read({ file_path, offset, limit })` command.

Measured 29 Sep 2026: arXiv PDF 2.1 MB → **39.8 KB Markdown in 424 ms**; PLOS PDF
2.9 MB → **70.8 KB in 363 ms**. Through the tool (including download + arXiv lookup):
**2.4–4.4 seconds**, and **0.3 seconds** if the file already exists.

**The converter must be installed** (not bundled with the package):

```sh
npm i -g @firecrawl/anydoc     # recommended — Rust, no Python
uv tool install markitdown     # fallback
```

If neither exists, `paper_status` says so **before** you try.

**Limits that are not violated:** open-access copies **only**; no breaking through
paywalls; no Sci-Hub/Anna's Archive; conversion is **always local** (anydoc's
`--ocr hosted` mode — which uploads the document to Firecrawl — is **never**
used). If there is no legitimate copy, the tool **fails and says so**.

## Credentials (optional — almost all sources still work without them)

No key is bundled with this package. Read order:

1. plugin config in the DSH profile,
2. environment variables `PAPER_SEARCH_MCP_<NAME>` then `<NAME>`,
3. the file `~/.config/paper-search-mcp/.env` (belonging to the upstream CLI).

| Name | Purpose |
|---|---|
| `OPENALEX_API_KEY` | **the one that matters most.** Free key: 10× daily budget, 30 req/s instead of 10, required for cursor paging. Without it OpenAlex shares one budget across everyone on your IP |
| `UNPAYWALL_EMAIL` | any email — the Crossref/OpenAlex `mailto` contact |
| `OPENALEX_EMAIL` | same, OpenAlex only |
| `SEMANTIC_SCHOLAR_API_KEY` | raises the Semantic Scholar rate limit |
| `DOAJ_API_KEY` | raises the DOAJ hourly limit |
| `CORE_API_KEY` | **required for the `core` source** — without a key it answers 429 with no message |

> **Set `OPENALEX_API_KEY` if you use this plugin at all.** OpenAlex backs
> `paper_detail`, `paper_citations`, `paper_oa`, `paper_fulltext`'s work lookup,
> and six of the search sources. Free at <https://openalex.org/settings/api-key>.
> `mailto` is NOT a substitute — the current OpenAlex docs do not mention it, and
> the 429 body names the missing key as the reason.

**Do not** fill in an IEEE key — upstream its connector is still a skeleton and
`search()` always throws `NotImplementedError`, so the key would never be useful.

**ACM is now USED — but via Crossref, not a key.** `PAPER_SEARCH_MCP_ACM_API_KEY`
**must not be filled in**: upstream that key can never have a valid value, because
ACM has no public search API. The `acm` source here works with no key at all
(DOI prefix filter `10.1145`), and its results are **not** marked open
access — ACM PDFs still answer **HTTP 403** (measured 29 Sep 2026).

## No CLI required

This plugin **stands alone**: all **23 registered sources** above are native over HTTP —
no CLI, no Python package, no third-party server.

> Versions 0.1.6 and below once suggested the `openags/paper-search-mcp` CLI as a
> complement, and said it "adds CORE, Zenodo, HAL, SSRN, Unpaywall".
> That suggestion was **removed in 0.1.7**: all four databases named there have
> become **native** sources of this plugin, so the sentence was misleading.

## How to report results

Present a table: **title, authors, year, source (journal), DOI/URL**. The tool
output already contains all of it, including the `source:` column that names **all**
the databases that found that paper (dedup result). Also mention if any source
failed in that search.
