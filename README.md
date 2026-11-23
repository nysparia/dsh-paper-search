# dsh-paper-search

Literature search for **DeepSeek Harness**: twenty-three sources, all native HTTP —
no external CLI, no Python package. Twenty-one of them need no credential at all.

Registered as the `paper-search` skill and five model tools (`paper_search`,
`paper_status`, `paper_citations`, `paper_oa`, `paper_fulltext`).

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
| `pmc` | PubMed Central | open-access full text; two calls per search |
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
| `ios` | IOS OneSearch (Perpusnas) | Indonesian repository aggregator |

### `sources: "all"` and the DOI-input source

`unpaywall` answers only when the query **is a DOI**. So when you search with
keywords, it is skipped rather than run and reported as an empty result — and
the output says so:

```
CATATAN: unpaywall dilewati karena query ini bukan DOI — sumber itu memang
mencari dengan DOI, bukan kata kunci.
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
dsh plugin --profile <profile> add github:rasyidmmz/dsh-paper-search
```

The package ships a `dsh.bundle.patch`, so DSH installs its loader row
automatically. **Do not also write an `id: paper-search` row by hand** — the
loader throws `duplicate loader entry id` rather than warning.

Restart DSH after installing.

## Plugin options

| Option | Default | Meaning |
|---|---|---|
| `tools` | `"five"` | `"five"` registers the five separate tools. `"one"` registers a **single** tool named `paper` with a `mode` parameter (`search` · `status` · `citations` · `oa` · `fulltext`). |
| `anydocPath` / `markitdownPath` | auto-detected | Explicit path to the PDF→Markdown converter used by `paper_fulltext`. |
| `folderTeksLengkap` | `~/.dsh/paper-search` | Where downloaded PDFs and converted Markdown are kept. |

**Why `tools: "one"` exists.** Every tool definition is sent to the model on
**every request**. Measured 29 Sep 2026 (`test/uji-satu-pintu.mjs`):

| | characters of JSON | ≈ tokens |
|---|---|---|
| `"five"` (default) | 4,959 | ~1,240 |
| `"one"` | 2,159 | ~540 |
| **saved** | **56%** | ~700 per request |

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
paper_status()                    # which sources answer right now
paper_status({ probe: false })    # configuration only, no network
paper_citations({ identifier: "10.1145/3290605.3300233" })                  # who cites it
paper_citations({ identifier: "10.1145/3290605.3300233", arah: "rujukan" }) # what it cites
paper_oa({ identifier: "10.1371/journal.pone.0266789" })                    # free copy?
paper_fulltext({ identifier: "1706.03762" })                                # read the whole paper
```

For Indonesian topics, **use Indonesian keywords**: `"pendidikan karakter"`
returns real Indonesian journals, while the English equivalent returns
international results that do not match the intent.

## Citation graph and open-access lookup

Two tools use OpenAlex — free, no key, no email (upstream PR #96):

- **`paper_citations`** walks the citation graph in either direction.
  `arah: "pengutip"` (default) lists papers that **cite** the work — forward
  snowballing; `arah: "rujukan"` lists the works it **cites** — backward
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
paper_fulltext({ identifier: "…", paksa_ulang: true })            # force re-download
```

How it finds the PDF — **arXiv first**, which is upstream PR #124:

1. the work's own arXiv id (from `10.48550/arXiv.<id>` or an arXiv location), or
   else the arXiv version **looked up by title**;
2. every open-access PDF location OpenAlex reports;
3. Unpaywall, last, using the configured email.

Then the PDF is saved next to its Markdown in `~/.dsh/paper-search/md/`
(override with the `folderTeksLengkap` plugin option), converted **locally** by
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

Stated precisely, because "tested" on its own is not a useful claim:

**Verified — the citation map, against live OpenAlex.** `paper({ mode: "citations",
analisis: "peta" })` was run on a real seed: bibliographic coupling surfaced *Questioning
the AI* (0.143), co-citation surfaced LIME's *"Why Should I Trust You?"* (cited alongside
8 times), a 5-paper XAI cluster formed, and the top bridge was a genuine survey spanning
7 clusters. **2 OpenAlex requests**, about 2 seconds. The pure math is covered offline by
`node test/uji-peta-sitasi.mjs` — **42/42 assertions**, including two mutation self-tests
(raising the thresholds must actually split the clusters, or the guard is vacuous).

**Verified — the search cache, with the network deliberately killed.** `node
test/uji-cache-pencarian.mjs` — **34/34 assertions** with a faked clock. Live, through the
tool: a repeat search went from **3,062 ms to 0 ms** with the output saying so, and with
the network switched off the cached search still answered while `paksa_ulang: true`
correctly failed (proof it really bypasses the cache rather than silently using it).

**Verified — the download guard, against a real PDF.** `node test/uji-teks-lengkap.mjs` —
**43/43 assertions**, 27 of them new: four URLs that must be allowed, twelve that must be
refused, three anti-over-blocking bounds, and five redirect scenarios including relative
`Location` and an endless loop. Live, `paper_fulltext` fetched a real arXiv PDF and
converted it to Markdown (39.8 KB) in 2 seconds, so the guard does not break the
legitimate path.

**Verified — the connectors, against live APIs and pages.** `node test/uji-sumber.mjs`
runs all twenty-three against the real services: **79/79 assertions, 1 skip**. On the last
run **22 of 23 answered**; the one that did not was `ios` (IOS OneSearch) with a
network-level `fetch failed`. That was **verified not to come from this release**: the
previously installed build fails on the same source in the same way, so the site was
simply unreachable — and the test now reports that as a skip rather than a failure.
Source `acm` answered with real ACM records in 670 ms. The sources added since 0.2.0
answered with real records too — `openreview` in 1.8 s (with DOIs recovered from
BibTeX, so its records merge with Crossref on deduplication), `ssrn` in 2.3 s, `ieee` in
1.6 s, `biorxiv` in 1.0 s, `medrxiv` in 0.9 s, and `chemrxiv` in 0.5 s.

**Verified — the wiring, against a mock Cordis context.** `node test/uji-plugin.mjs`,
**62/62 assertions**: all five tools register, the new tools are actually called
and return data, `paper_fulltext` downloads *and* converts a real paper with the
resulting `.md` checked on disk, the skill provider reports rank 450, the
frontmatter parses within the 500-character catalogue limit, and every tool
declares the `output: { schema, render }` that DSH requires.

**Verified — loading the bundle inside a live harness.** `node test/uji-di-dsh.mjs`
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
| `UNPAYWALL_EMAIL` | any email — used as the Crossref/OpenAlex "polite pool" contact |
| `OPENALEX_EMAIL` | same, OpenAlex only |
| `SEMANTIC_SCHOLAR_API_KEY` | raises Semantic Scholar rate limits |
| `DOAJ_API_KEY` | raises DOAJ's hourly limit |
| `CORE_API_KEY` | **required for the `core` source** — without it CORE answers HTTP 429 with an empty body |

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
