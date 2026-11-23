# NOTICE

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
