// lib/fulltext.js — fetch the open-access PDF, then turn it into Markdown.
//
// WHY IT EXISTS
//   The model cannot read raw PDFs. Markdown is far cheaper in tokens and can be
//   read WHOLE by the agent through the `read` tool (offset/limit) — including
//   when the file is 40–80 thousand characters, which cannot possibly be sent in
//   one tool reply. So the conversion result is written to a FILE, and what comes
//   back is its path + a snippet.
//
// THE CONVERSION IS NOT REWRITTEN HERE
//   Existing tools are used: `anydoc` (Rust, CLI, npm `@firecrawl/anydoc`) first,
//   `markitdown` as the fallback. Measured 29 Sep 2026 on this machine:
//   arXiv PDF 2.1 MB -> 39.8 KB Markdown in **424 ms**; PLOS PDF 2.9 MB ->
//   70.8 KB in **363 ms**, complete with reference links.
//
// RULES THAT ARE NOT BROKEN
//   - open-access copies ONLY (arXiv, OpenAlex/Unpaywall OA locations);
//   - does NOT break through paywalls, does not use Sci-Hub / Anna's Archive;
//   - if there is no valid copy, that is said plainly — not blanked out.
//
// PITFALLS AVOIDED
//   Capturing a child's output through a PIPE can be refused with `EPERM` in
//   strict sandbox mode (a limit already documented in this project). So the
//   child process is given a **file descriptor**, not a pipe — a pattern already
//   proven by `arsip-dump\test-pipe-sandbox.mjs`.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeOA, arxivIdFromWork, arxivMatch, normalizeDoi } from './sources.js';

// Same rule as lib/sources.js: the User-Agent reports the REAL version, read
// from package.json, so it cannot drift from the package again.
const PACKAGE_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const UA = `dsh-paper-search/${PACKAGE_VERSION} (+https://github.com/nysparia/dsh-paper-search)`;
const DOWNLOAD_TIMEOUT_MS = 120000;
const CONVERT_TIMEOUT_MS = 180000;
// A metadata LOOKUP, not a transfer: the same class of call as `getText` in
// `lib/sources.js` (25 s), not as `downloadPdf` above (120 s). It gets the same
// AbortController treatment as both, with a bound that fits what it does.
const LOOKUP_TIMEOUT_MS = 25000;

// How long a converter gets to die on SIGTERM before it is SIGKILLed, and how
// long we then wait for `close` before giving up on the process entirely.
// Measured 24 Nov 2026: a converter that traps SIGTERM was still alive 2 s after
// `child.kill()` and wrote a complete `.md` 1.5 s after `ok:false` had already
// been returned. SIGTERM is a REQUEST; SIGKILL is the only thing that stops a
// child that ignores it.
const KILL_GRACE_MS = 500;
const KILL_WAIT_MS = 2000;

// The largest reply `downloadPdf` will accept, in bytes.
//
// A paper PDF is 1–20 MB; the two measured for the header comment above are
// 2.1 MB (arXiv) and 2.9 MB (PLOS). 100 MB is ~35x the largest of those, which
// leaves room for a scanned thesis while still bounding what a hostile or broken
// OA host can cost: before this cap the whole reply was buffered with
// `arrayBuffer()` and then copied again by `writeFileSync`, so a 64 MB body cost
// 64 MB of RSS and 64 MB of disk, and a 5 GB body cost 5 GB of each. The 120 s
// timeout bounds TIME, not bytes.
const MAX_PDF_BYTES = 100 * 1024 * 1024;

// Where `%PDF-` and `%%EOF` are looked for. The PDF spec allows the header
// anywhere in the first 1024 bytes (a BOM or a leading newline is legal), and
// requires `%%EOF` as the last line — 2 KB of slack covers the trailing junk
// some generators append after it.
const PDF_HEADER_WINDOW = 1024;
const PDF_TRAILER_WINDOW = 2048;

/**
 * A duration a reader can act on: "25 s", or "300 ms" when the bound is under a
 * second. `Math.round(ms / 1000)` alone printed "timeout > 0 s" for a 300 ms
 * bound, which reads as "there is no timeout".
 */
function formatDuration(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms)} ms`;
}

/** Root of the Markdown library. Can be overridden through the `libraryRoot` plugin config. */
export const DEFAULT_ROOT = join(homedir(), '.dsh', 'paper-search');

// ── Finding a converter ──────────────────────────────────────────────────────

/** Candidate CLI paths that are usual on this machine (PATH does not necessarily contain them). */
function usualPaths(name, exeWindows) {
  const out = [];
  const ext = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const e of ext) out.push(join(dir, name + e));
  }
  const home = homedir();
  const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  out.push(
    join(appdata, 'npm', `${name}.cmd`),                      // npm -g on Windows
    join(appdata, 'uv', 'tools', name, 'Scripts', exeWindows), // uv tool install
    join(home, '.local', 'bin', exeWindows),
    join(home, '.local', 'bin', name),
  );
  return [...new Set(out)].filter((p) => p && existsSync(p));
}

/**
 * Is this candidate something the OS will actually EXECUTE?
 *
 * `existsSync` alone was the whole test, and it answers a different question.
 * Measured 24 Nov 2026: a directory, a non-executable file and a binary that
 * exits 127 were all returned as "the converter". The user then saw
 * `converter : anydoc (plugin config)` followed by
 * `conversion failed through anydoc: exit code 127` — on a machine that had a
 * working `markitdown` the whole time.
 */
function isRunnableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    // On Windows `X_OK` is not a real permission bit and behaves like `F_OK`;
    // the `isFile` test above is what does the work there.
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every converter that actually EXISTS AND RUNS on this machine, in preference
 * order: `anydoc` first (fast, Rust, no Python), then `markitdown`.
 *
 * This is the list `prepareFullText` walks when one converter fails to spawn or
 * exits 127 — the header comment has always called `markitdown` "the fallback",
 * but a fallback that is only LOWER IN A LIST is not a fallback: measured
 * 24 Nov 2026, a broken `anydoc` plus a working `markitdown` gave
 * `exit code 127` and markitdown was never tried.
 */
export function findConverters(config = {}) {
  const list = [];
  const anydocConfig = config.anydocPath ?? config.ANYDOC_PATH;
  if (anydocConfig) list.push({ name: 'anydoc', path: anydocConfig, from: 'plugin config' });
  for (const p of usualPaths('anydoc', 'anydoc.exe')) list.push({ name: 'anydoc', path: p, from: 'usual path' });

  const mdConfig = config.markitdownPath ?? config.MARKITDOWN_PATH;
  if (mdConfig) list.push({ name: 'markitdown', path: mdConfig, from: 'plugin config' });
  for (const p of usualPaths('markitdown', 'markitdown.exe')) list.push({ name: 'markitdown', path: p, from: 'usual path' });

  return list.filter((c) => isRunnableFile(c.path));
}

/**
 * Which converter to NAME in a status line. Returns `null` if there is not a
 * single runnable one — and that is reported as it is, not hidden until this
 * feature looks "broken".
 */
export function findConverter(config = {}) {
  return findConverters(config)[0] ?? null;
}

/** `.cmd`/`.bat` on Windows cannot be run directly — they must go through cmd.exe. */
function needsShell(path) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(path);
}

/**
 * Arguments for `spawn`. For `*.cmd` we do NOT use `shell: true`:
 * Node warns (`DEP0190`) that arguments are not escaped in that mode.
 * What is used instead: run `cmd.exe /d /c <script> <arg…>` — same behaviour,
 * but the arguments are still sent as a list and do not trigger that warning.
 */
function spawnCommand(converter, args) {
  if (needsShell(converter.path)) {
    return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', converter.path, ...args] };
  }
  return { cmd: converter.path, args };
}

// ── The completion marker ────────────────────────────────────────────────────
//
// WHY A MARKER AND NOT A SIZE TEST (measured 24 Nov 2026). `prepareFullText`
// used to call a `.md` "already converted" when `statSync(md).size > 0`. A
// 29-byte file holding `"# Human-level control\n\nWe pre"` — cut mid-word —
// beside a valid PDF was returned as `fromCache: true`,
// `used: {from: 'local file', note: 'already converted'}`, zero fetches. The
// agent then read, quoted and cited one page of a forty-page paper.
//
// A minimum size cannot tell a complete conversion from a truncated one (a
// paper cut after page 1 can be 5 KB), and an atomic rename cannot either: it
// only proves that OUR writer finished, not that a file written by an older
// plugin version — or by hand — is complete. So the only honest signal is a
// record written AFTER a conversion succeeded, and a hit requires that record to
// match the file on disk:
//
//   <slug>.md.json  { v, md: {bytes, sha256}, pdf: {bytes, mtimeMs}, converter, at }
//
// The `.md` hash proves the body is exactly what the converter produced (a
// truncated or edited file fails it). The PDF's size+mtime proves the body
// belongs to the PDF sitting beside it (a re-downloaded PDF invalidates it).
// A `.md` with NO marker is a MISS with a stated reason — that is the case an
// older plugin version leaves behind, and it is exactly the case that must not
// be trusted silently.
//
// The cost is one hash of the `.md` per cache hit (tens of KB — microseconds)
// and one `stat` of the PDF. The cost of the alternative was a wrong answer.
function markerPath(md) {
  return `${md}.json`;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Record that `md` is the COMPLETE output of converting `pdf`. Written atomically. */
function writeCompletionMarker(pdf, md, converterName) {
  const mdStat = statSync(md);
  const pdfStat = statSync(pdf);
  const marker = {
    v: 1,
    md: { bytes: mdStat.size, sha256: sha256File(md) },
    pdf: { bytes: pdfStat.size, mtimeMs: pdfStat.mtimeMs },
    converter: converterName ?? null,
    at: new Date().toISOString(),
  };
  const temporary = `${markerPath(md)}.part`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`);
  renameSync(temporary, markerPath(md));
}

/**
 * Does the marker beside `md` prove that `md` is a complete conversion of `pdf`?
 * Returns `{ ok: true }` or `{ ok: false, reason }` — the reason is shown to the
 * user, so it names the case rather than saying "invalid".
 */
function verifyCompletionMarker(pdf, md) {
  const file = markerPath(md);
  if (!existsSync(file)) {
    return { ok: false, reason: 'the Markdown has no completion marker, so it was written by an older plugin version (or by hand) and its completeness cannot be verified' };
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `its completion marker cannot be read (${e?.message ?? e})` };
  }
  if (marker?.v !== 1 || !marker.md || !marker.pdf) {
    return { ok: false, reason: 'its completion marker is not in a shape this version understands' };
  }
  const mdStat = statSync(md);
  if (mdStat.size !== marker.md.bytes) {
    return { ok: false, reason: `the Markdown is ${mdStat.size} bytes but the completed conversion was ${marker.md.bytes} — truncated or edited after conversion` };
  }
  if (sha256File(md) !== marker.md.sha256) {
    return { ok: false, reason: 'the Markdown does not match the hash recorded when the conversion completed — edited after conversion' };
  }
  const pdfStat = statSync(pdf);
  if (pdfStat.size !== marker.pdf.bytes || pdfStat.mtimeMs !== marker.pdf.mtimeMs) {
    return { ok: false, reason: 'the PDF beside it is not the one that was converted' };
  }
  return { ok: true };
}

/**
 * Turn a PDF into Markdown at `md`.
 * The child's output is directed to a FILE through a file descriptor (not a
 * pipe), and stderr is captured separately so its original message can be
 * reported.
 *
 * THE OUTPUT IS WRITTEN TO `<md>.part` AND RENAMED ON SUCCESS. The converter is
 * given `-o <md>.part` and its stdout goes to the same path, so nothing it does
 * can land on the final name. Measured 24 Nov 2026: a converter that trapped
 * SIGTERM wrote `"# LATE but complete conversion\n"` 1.5 s AFTER this function
 * had returned `{ok: false, message: 'timeout > 400 ms'}` — and the next call
 * served that file as a cache hit. With the rename, a late write lands on the
 * `.part` name, which is deleted on failure and never read.
 */
export async function convertToMarkdown(pdf, md, converter, { timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  if (!existsSync(pdf)) return { ok: false, message: `PDF does not exist: ${pdf}` };
  const temporary = `${md}.part`;
  const errorFile = `${md}.err`;
  // From here on the `.md` on disk is NOT known to be the output of a successful
  // conversion, so its marker must go before the attempt starts. Otherwise a
  // failed re-conversion would leave the OLD marker vouching for the OLD body
  // while the PDF beside it has already been replaced.
  try { unlinkSync(markerPath(md)); } catch { /* nothing to invalidate */ }

  let fdOut = null;
  let fdErr = null;
  let code;
  try {
    // BOTH opens are inside the `try`, and both descriptors are closed in the
    // `finally` below. Measured 24 Nov 2026: when the `.err` path could not be
    // opened (a directory in the way), the already-open `fdOut` was never
    // closed — one descriptor leaked per call, 21 calls took the count from 22
    // to 43.
    fdOut = openSync(temporary, 'w');
    fdErr = openSync(errorFile, 'w');
    // `-o <path>` is used by anydoc AND by newer markitdown. If the converter
    // does not know `-o`, the output is empty -> reported as a failure.
    const args = [pdf, '-o', temporary];
    const { cmd, args: argv } = spawnCommand(converter, args);
    code = await new Promise((done) => {
      let child;
      try {
        child = spawn(cmd, argv, { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
      } catch (e) {
        done(`spawn-failed: ${e?.message ?? e}`);
        return;
      }
      let timedOut = false;
      let timer = null;
      let killTimer = null;
      let waitTimer = null;
      const stopTimers = () => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(waitTimer); };
      timer = setTimeout(() => {
        timedOut = true;
        // SIGTERM is a REQUEST. A child that ignores it stays alive and keeps
        // writing, so it is escalated to SIGKILL after a short grace period.
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
          // SIGKILL cannot be ignored, but `close` can still be delayed by a
          // grandchild holding the inherited descriptors. The final path is
          // protected by the `.part` rename, so giving up here is safe.
          waitTimer = setTimeout(() => { stopTimers(); done('timeout'); }, KILL_WAIT_MS);
        }, KILL_GRACE_MS);
      }, timeoutMs);
      child.on('error', (e) => { stopTimers(); done(`spawn-failed: ${e?.message ?? e}`); });
      // Resolve on `close`, NOT on the timer: returning while the child can
      // still write is what let a "failed" conversion leave a complete `.md`.
      child.on('close', (c) => { stopTimers(); done(timedOut ? 'timeout' : c); });
    });
  } finally {
    if (fdOut !== null) { try { closeSync(fdOut); } catch { /* already closed */ } }
    if (fdErr !== null) { try { closeSync(fdErr); } catch { /* already closed */ } }
  }

  const error = existsSync(errorFile) ? readFileSync(errorFile, 'utf8').trim().slice(0, 400) : '';
  const size = existsSync(temporary) ? statSync(temporary).size : 0;
  // A body of nothing but whitespace is not a conversion. Measured 24 Nov 2026:
  // a converter that exited 0 after writing `"   \n\n"` was reported as a
  // success, and the next call served those five bytes as the paper.
  let hasText = false;
  try { hasText = size > 0 && /\S/.test(readFileSync(temporary, 'utf8')); } catch { /* vanished */ }
  if (code === 0 && hasText) {
    try {
      renameSync(temporary, md);
    } catch (e) {
      // The final name is unusable (a directory in the way, a read-only folder).
      // Reported, not thrown: `prepareFullText` promises never to throw for a
      // foreseeable failure, and a directory in the library folder is one.
      try { unlinkSync(temporary); } catch { /* nothing written */ }
      return { ok: false, message: `cannot write ${md}: ${e?.message ?? e}` };
    }
    writeCompletionMarker(pdf, md, converter?.name);
    try { unlinkSync(errorFile); } catch { /* leave it */ }
    return { ok: true, bytes: size, message: error };
  }

  // FAILED. Drop the partial output so it can never be mistaken for a finished
  // conversion, and keep the `.err` file — it holds the converter's original
  // message, which the caller has already read above.
  try { unlinkSync(temporary); } catch { /* nothing written */ }

  // The reason must NAME the case, not echo the exit code. A converter that
  // exits 0 and writes nothing used to fall through to `String(code)`, so the
  // user was told `conversion failed through silent: 0` — a number where the
  // reason belongs, and the one case where the exit code says "fine" while the
  // output says "nothing". Measured 24 Nov 2026 with a converter that exits 0
  // without touching `-o`: `{ ok: false, message: "0" }`.
  // `Math.round(ms / 1000)` printed "timeout > 0 s" for any bound under 500 ms,
  // which reads as "no timeout at all". Milliseconds are shown below one second.
  const reason = code === 'timeout' ? `timeout > ${formatDuration(timeoutMs)}`
    : typeof code === 'number' && code !== 0 ? `exit code ${code}`
      : code === 0 ? (size > 0
        ? `exit code 0 but the output is whitespace only (${size} bytes) — the converter stopped before writing anything`
        : 'exit code 0 but no output was written (the converter does not support "-o <path>", or it wrote nothing)')
        : String(code);
  return { ok: false, message: [reason, error].filter(Boolean).join(' — ').slice(0, 500) };
}

// ── Finding & downloading the PDF ────────────────────────────────────────────

/**
 * List of open-access PDFs worth trying, IN ORDER: **arXiv first**
 * (upstream PR #124), then the OpenAlex OA locations.
 *
 * `arxivId` is filled with the result of `arxivMatch()` when the work itself
 * does not name its arXiv id — the caller does the searching, so this function
 * stays pure & testable without a network.
 *
 * `isOa` IS THREE-VALUED, AND THIS FUNCTION MUST NOT COLLAPSE IT. `summarizeOA`
 * currently returns `isOa: !!oa.is_oa`, so a work whose `open_access` block is
 * MISSING and a work OpenAlex reports as CLOSED both arrive here as `false` —
 * two opposite facts, one value. That is being fixed in `lib/sources.js` (owned
 * by another change), where a missing block will report `isOa: null` /
 * `undefined` for "not reported" and keep `false` for "reported closed".
 *
 * The candidates are therefore built from `locations` ALONE, never from `isOa`:
 * a location with a `pdf_url` is a real open-access copy whether or not the
 * summary flag was reported, and a work with no locations yields no candidates
 * either way. Reading `isOa` here — in either direction — would make this
 * function's answer depend on which of the two shapes `summarizeOA` happens to
 * return, so it is deliberately not read at all. `oa` is still consulted for
 * `locations`, which is the only field that carries a URL.
 *
 * ASSUMPTION, stated because it cannot be verified from this file: the new
 * `summarizeOA` keeps `locations` as an array (empty when nothing is known) and
 * keeps filling it from `work.locations` regardless of the `isOa` value. Both
 * `?? []` guards below hold that assumption defensively, so a `null` locations
 * field degrades to "no candidates" instead of throwing.
 *
 * `summarize` is injectable for the same reason `findArxiv` is injectable in
 * `prepareFullText`: the three-valued `isOa` cannot be produced by the CURRENT
 * `summarizeOA` (it coerces to a boolean), so the tolerance this function
 * promises could not be tested at all without a way to hand it the shape the
 * fixed `summarizeOA` will return. Production always uses the default.
 */
export function pdfCandidates(work, { arxivId = null, summarize = summarizeOA } = {}) {
  const out = [];
  const add = (url, from, note) => {
    // Only a STRING with an http(s) scheme is a candidate. Measured 24 Nov 2026:
    // `file:///etc/passwd`, `ftp://x/y.pdf`, `42` and `{href: …}` all survived
    // this list. They were refused later by `isSafeUrl`, but the list is printed
    // to the user on failure — so a hostile reply got its `file:///etc/passwd`
    // echoed back as a "PDF candidate tried".
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (out.some((c) => c.url === url)) return;
    out.push({ url, from, note });
  };

  const idArxiv = arxivId ?? arxivIdFromWork(work);
  if (idArxiv) {
    add(`https://arxiv.org/pdf/${idArxiv}`, 'arxiv', `arXiv preprint ${idArxiv} — usually the fastest & the most often hit`);
  }
  const oa = summarize(work);
  // `isOa` is intentionally NOT tested: `null` (not reported) and `false`
  // (reported closed) must both fall through to the locations, because a
  // reported-closed work can still carry a green location and an unreported one
  // usually does.
  for (const l of oa?.locations ?? []) {
    if (!l?.pdf) continue;
    const detail = [l.license ? `license ${l.license}` : null, l.version ? `version ${l.version}` : null, l.source]
      .filter(Boolean).join(' · ');
    add(l.pdf, 'openalex', detail || 'OpenAlex open-access location');
  }
  return out;
}

/**
 * Short, stable hash of an EXACT identifier — the part that makes a slug
 * collision-free. Same construction as `cacheKey` in `lib/cache.js`.
 */
function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

/**
 * Safe file name from the DOI/title — never contains shell characters, and
 * NEVER shared by two different identifiers.
 *
 * WHY THE HASH IS THERE (measured 24 Nov 2026). The readable part alone was the
 * whole name, and it collapsed every non-alphanumeric character except `.` to a
 * single `_`:
 *
 *   10.1234/a-b  \
 *   10.1234/a_b   \
 *   10.1234/a b    >  all -> doi-10.1234_a_b     (5 distinct DOIs, ONE file)
 *   10.1234/a+b   /
 *   10.1234/a/b  /
 *
 * and the title path did the same with `-`:
 *
 *   "Deep Learning: A Review"  \
 *   "Deep Learning - A Review"  >  all -> deep-learning-a-review-2020
 *   "Deep Learning, A Review"  /
 *
 * The consequence was not a cosmetic one. `prepareFullText` decides "already
 * converted" by looking for `<slug>.md`, so the second paper was answered with
 * the FIRST paper's body, reported as `fromCache: true` / "already converted".
 * The agent then read, quoted and cited the wrong paper — a confident wrong
 * answer, which is worse than any visible error.
 *
 * So the readable part is kept (a human can still tell which file is which) and
 * a short hash of the EXACT identifier is appended. The hash is computed from
 * the identifier itself, NOT from the readable part — hashing the collapsed
 * form would reproduce the very collision it is meant to remove.
 *
 * The identifier is normalized first, so the same paper written several ways
 * (`10.1038/NATURE14539`, `https://doi.org/10.1038/nature14539`,
 * `doi:10.1038/nature14539`) still lands on ONE file. The title is normalized
 * the same way (case + whitespace only), so punctuation differences — which are
 * genuinely different titles — stay distinct.
 *
 * An old slug simply stops matching and is re-downloaded. That is the correct
 * behaviour: a cache miss costs one download, a collision costs a wrong answer.
 *
 * THE IDENTIFIER IS PART OF THE TITLE HASH TOO (measured 24 Nov 2026). The hash
 * used to be over `title + year` only, and `identifier` was read ONLY when the
 * title was empty — so the collision above survived on the title path. Two works
 * titled "Editorial", year 2020, no DOI, different OA URLs both produced
 * `editorial-2020-34e6e11a`, and asking for B returned A's body as
 * `fromCache: true`. The identifier is now folded in, normalized the same way
 * the DOI path normalizes it, so the same paper written several ways
 * (`10.1038/NATURE14539`, `https://doi.org/10.1038/nature14539`) still lands on
 * ONE file, and a title-only call with no identifier at all is still stable
 * across calls (the identifier contributes the empty string).
 *
 * Two works that genuinely have neither a DOI nor any identifier still collide.
 * That is a stated limitation, not a silent one: there is nothing left to tell
 * them apart.
 *
 * THE YEAR IS SANITIZED (measured 24 Nov 2026). `publication_year` comes from
 * the OpenAlex reply and was interpolated raw, so
 * `publication_year: "../../../../../../tmp/x/OUTSIDE"` produced a slug
 * containing `/` and `prepareFullText` wrote the PDF and the `.md` OUTSIDE
 * `<root>/md/`, reporting `problem: null`. The same input also produced a NUL
 * byte in the name, and a 300-character year produced a 315-byte name
 * (`ENAMETOOLONG` from `openSync`, not a named problem). A year can legitimately
 * be a 4-digit number; anything else becomes the existing `x` fallback.
 */
export function fileSlug(work, identifier) {
  const doi = normalizeDoi(work?.doi);
  if (doi) {
    const readable = doi.replace(/[^a-z0-9.]+/gi, '_').slice(0, 80);
    return `doi-${readable}-${shortHash(doi)}`;
  }
  const rawTitle = String(work?.title ?? identifier ?? '');
  const readable = rawTitle
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const year = sanitizeYear(work?.publication_year);
  const normalizedTitle = rawTitle.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedId = normalizeIdentifier(identifier);
  return `${readable || 'paper'}-${year}-${shortHash(`${normalizedTitle}\u0000${year}\u0000${normalizedId}`)}`;
}

/**
 * A publication year as it can legitimately be: four digits, or `x`.
 *
 * Anything else — a path, a NUL, a 300-character string — is not a year, and
 * putting it in a file name is how a third-party reply chose where this plugin
 * wrote. `x` is the fallback the title path already used for a missing year.
 */
function sanitizeYear(year) {
  const s = String(year ?? '').trim();
  return /^\d{4}$/.test(s) ? s : 'x';
}

/**
 * A stable form of whatever the caller passed as `identifier`, so the same paper
 * written several ways hashes to one value. A DOI is normalized exactly as the
 * DOI path normalizes it; anything else is lowercased and whitespace-collapsed.
 */
function normalizeIdentifier(identifier) {
  if (identifier === undefined || identifier === null) return '';
  const doi = normalizeDoi(identifier);
  if (doi) return doi;
  return String(identifier).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Is this file really a PDF? The conditions: it exists, is a REGULAR file, is
 * >= 1000 bytes, carries `%PDF-` in its first 1024 bytes, and ends with
 * `%%EOF`. Used in TWO places: before writing a new file (rejecting a reply that
 * is not a PDF) and before using a PDF from the cache (healing a damaged file
 * that an older plugin version may have written, before this validation
 * existed).
 *
 * The conditions used to be rewritten inside `downloadPdf`, so they could not be
 * used to check a file already on disk.
 *
 * WHY THE HEADER IS SEARCHED, NOT REQUIRED AT OFFSET 0 (measured 24 Nov 2026).
 * A real PDF with a leading newline, a leading space or a UTF-8 BOM was reported
 * as `prefix ".%PDF"` / `prefix " %PDF"` / `prefix "...%P"` — "not a PDF" for a
 * file every converter reads fine. The PDF spec allows the header anywhere in
 * the first 1024 bytes.
 *
 * WHY `%%EOF` IS REQUIRED (measured 24 Nov 2026). `"%PDF-" + 2000 NUL bytes` was
 * reported as a valid PDF, because the only test was five ASCII bytes. The
 * trailer is what distinguishes a document from a body that merely starts with
 * the magic number, and it is also what catches a truncated download.
 *
 * A DIRECTORY IS NOT AN EMPTY FILE (measured 24 Nov 2026): `statSync(dir).size`
 * is 0 on this filesystem, so a directory named `*.pdf` was reported as
 * `only 0 bytes` — the right verdict with a wrong statement about what is there.
 */
export function checkPdf(file) {
  if (!existsSync(file)) return { ok: false, reason: 'file does not exist' };
  let size;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    size = st.size;
  } catch (e) {
    return { ok: false, reason: `cannot be read: ${e?.message ?? e}` };
  }
  if (size < 1000) return { ok: false, reason: `only ${size} bytes` };
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (e) {
    // A file that exists but cannot be opened (EACCES) is a foreseeable failure,
    // and `prepareFullText` calls this on the cache path without a `try`.
    return { ok: false, reason: `cannot be read: ${e?.message ?? e}` };
  }
  try {
    const head = Buffer.alloc(Math.min(size, PDF_HEADER_WINDOW));
    const hn = readSync(fd, head, 0, head.length, 0);
    const headText = head.subarray(0, hn).toString('latin1');
    if (!headText.includes('%PDF-')) {
      return { ok: false, reason: `no "%PDF-" header in the first ${PDF_HEADER_WINDOW} bytes (prefix "${headText.slice(0, 5).replace(/[^\x20-\x7e]/g, '.')}")` };
    }
    const tailLength = Math.min(size, PDF_TRAILER_WINDOW);
    const tail = Buffer.alloc(tailLength);
    const tn = readSync(fd, tail, 0, tailLength, size - tailLength);
    if (!tail.subarray(0, tn).toString('latin1').includes('%%EOF')) {
      return { ok: false, reason: `no "%%EOF" trailer in the last ${PDF_TRAILER_WINDOW} bytes — truncated, or not a PDF` };
    }
    return { ok: true, bytes: size };
  } catch (e) {
    return { ok: false, reason: `cannot be read: ${e?.message ?? e}` };
  } finally {
    closeSync(fd);
  }
}

/** The same verdict for a body already in memory — used by `downloadPdf`. */
function checkPdfBuffer(buf) {
  if (buf.length < 1000) return { ok: false, reason: `only ${buf.length} bytes` };
  const headText = buf.subarray(0, Math.min(buf.length, PDF_HEADER_WINDOW)).toString('latin1');
  if (!headText.includes('%PDF-')) {
    return { ok: false, reason: `no "%PDF-" header in the first ${PDF_HEADER_WINDOW} bytes (prefix "${headText.slice(0, 5).replace(/[^\x20-\x7e]/g, '.')}")` };
  }
  const tailText = buf.subarray(Math.max(0, buf.length - PDF_TRAILER_WINDOW)).toString('latin1');
  if (!tailText.includes('%%EOF')) {
    return { ok: false, reason: `no "%%EOF" trailer in the last ${PDF_TRAILER_WINDOW} bytes — truncated, or not a PDF` };
  }
  return { ok: true, bytes: buf.length };
}

/**
 * Download the PDF to `destination`; rejects a reply that is not a PDF.
 *
 * Written **atomically**: to `<destination>.part` first, then `renameSync`. If
 * the process dies mid-write (power loss/forced kill), what is left behind is a
 * `.part` file — not a half PDF that is later converted and fails with a
 * confusing message.
 */
/**
 * Is this link SAFE to download?
 *
 * Added 2 Oct 2026 after reading upstream PR #56 (its title was "safety
 * improvements"; its content turned out to be a host check using SUBSTRING
 * replaced by proper hostname parsing). Audit of our code: that substring
 * pattern is **not present** here. But the same audit found an EQUIVALENT hole
 * of ours — `downloadPdf()` followed redirects without checking anything.
 *
 * Why that matters: download URLs come from **third-party APIs** (OpenAlex OA
 * locations, Unpaywall, Semantic Scholar's `openAccessPdf`, CORE). We do not
 * control the content of their replies, so those links must be treated as
 * **untrusted data**. Without this guard, one crafted API reply could tell this
 * machine to fetch anything — including addresses inside the local network that
 * should not be reachable from outside.
 *
 * PURE (no network) so it can be tested directly.
 *
 * WHAT THIS DOES NOT DO — read this before treating it as an SSRF guard. It
 * checks the SPELLING of the destination, not where the destination resolves.
 * There is no DNS lookup here, so a hostname that resolves to a private address
 * passes. Measured 24 Nov 2026 on this machine: `localhost.localdomain` resolves
 * to `::1` and `127.0.0.1` and this function says SAFE. Closing that needs a
 * resolution step (and accepts a TOCTOU gap between the check and the connect),
 * which is why it is a stated limitation rather than a silent one.
 */
export function isSafeUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? ''));
  } catch {
    return { safe: false, reason: 'not a valid URL' };
  }

  // 1. Scheme: http/https only. This closes off `file:` (reading local files),
  //    `data:`, `ftp:`, and other schemes that have no business with PDFs.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { safe: false, reason: `scheme "${u.protocol}" is not allowed — http/https only` };
  }

  // A trailing dot is the FQDN ROOT and is not part of the name: `localhost.`
  // and `localhost` are the same host. `new URL()` keeps the dot, so every
  // comparison below used to miss it. Measured 24 Nov 2026 on this machine:
  //
  //   http://localhost/    -> BLOCK
  //   http://localhost./   -> SAFE   <- and `dns.lookup('localhost.')` = ::1
  //   http://foo.local./   -> SAFE
  //
  // So the guard was bypassable with ONE character, on links that come from
  // third-party API replies. Strip exactly one trailing dot (a second one is not
  // a root marker but a different, unresolvable name) BEFORE any check, so no
  // existing rule is weakened — they all see the same host they always did.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { safe: false, reason: 'URL without a host' };

  // 2. Host names that clearly point inward: this machine or the local network.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return { safe: false, reason: `host "${host}" points into the local network` };
  }

  // 3. Literal IP addresses in private/loopback/link-local space.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    const isPrivate =
      a === 127 || a === 0 || a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127); // CGNAT
    if (isPrivate) return { safe: false, reason: `private/loopback IP address "${host}"` };
  }

  // 4. IPv6 — and this is where the guard used to be bypassable.
  //
  // The old check only looked at `::1`, `::`, `fc*` and `fe8*`–`feb*`. That let
  // through every address that EMBEDS an IPv4 address, which is exactly how an
  // attacker reaches loopback through an IPv6 literal. Measured 23 Nov 2026
  // against a local HTTP server on 127.0.0.1:
  //
  //   http://[::ffff:127.0.0.1]:PORT/   guard=SAFE  -> FETCHED HTTP 200
  //   http://[::ffff:7f00:1]:PORT/      guard=SAFE  -> FETCHED HTTP 200
  //
  // So the IPv6 branch now PARSES the address and unwraps every embedded-IPv4
  // form before deciding:
  //   · IPv4-mapped    ::ffff:a.b.c.d   (and the hex form ::ffff:7f00:1)
  //   · IPv4-compatible ::a.b.c.d       (deprecated, still routable)
  //   · NAT64         64:ff9b::a.b.c.d
  //   · 6to4          2002:aabb:ccdd::  (the IPv4 address is in bytes 2-5)
  //   · Teredo        2001:0::          (the client IPv4 is the last 32 bits, inverted)
  // Anything that unwraps to a private/loopback IPv4 is refused, and so is any
  // IPv6 address that is itself loopback, unspecified, link-local, unique-local,
  // or multicast.
  if (host.includes(':')) {
    const verdict = classifyIpv6(host);
    if (!verdict.safe) return verdict;
  }

  return { safe: true };
}

/**
 * Decide whether an IPv6 literal is safe to fetch.
 *
 * Returns `{ safe: true }` or `{ safe: false, reason }`. Kept separate from
 * `isSafeUrl` so the address arithmetic can be read (and tested) on its own.
 */
function classifyIpv6(host) {
  const h = host.toLowerCase();

  // Expand `::` and pad each group to 4 hex digits, so every form compares equal.
  const groups = expandIpv6(h);
  if (!groups) return { safe: false, reason: `unparseable IPv6 address "${host}"` };

  const g = groups.map((x) => parseInt(x, 16));
  const isZero = (from, to) => g.slice(from, to).every((x) => x === 0);

  // Loopback ::1 and unspecified ::
  if (isZero(0, 7) && (g[7] === 0 || g[7] === 1)) {
    return { safe: false, reason: `private/loopback IPv6 address "${host}"` };
  }
  // Link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) {
    return { safe: false, reason: `link-local IPv6 address "${host}"` };
  }
  // Unique-local fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) {
    return { safe: false, reason: `unique-local IPv6 address "${host}"` };
  }
  // Multicast ff00::/8
  if ((g[0] & 0xff00) === 0xff00) {
    return { safe: false, reason: `multicast IPv6 address "${host}"` };
  }

  // ── Addresses that EMBED an IPv4 address ──
  // Each returns the embedded IPv4 as four octets, or null.
  //
  // TEREDO IS DECIDED HERE, NOT IN `embeddedIpv4` (measured 24 Nov 2026).
  // `http://[2001:0:0:0:0:0:0:1]/` was reported SAFE: the Teredo branch treated
  // every `2001:0::/32` address as Teredo, bit-inverted the last 32 bits (`::1`
  // became 255.255.255.254) and called that public. A REAL Teredo address
  // carries the Teredo SERVER's IPv4 in groups 2–3; this one carries nothing, so
  // the client address it tunnels to cannot be recovered. Refusing is the only
  // honest verdict — the guard must not answer "safe" about an address it cannot
  // classify.
  if (g[0] === 0x2001 && g[1] === 0x0000) {
    if (g[2] === 0 && g[3] === 0) {
      return { safe: false, reason: `IPv6 address "${host}" is in Teredo space (2001:0::/32) but carries no Teredo server address, so the IPv4 it tunnels to cannot be determined` };
    }
    const hi = (~g[6]) & 0xffff;
    const lo = (~g[7]) & 0xffff;
    const teredo = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    if (isPrivateIpv4(teredo)) {
      return { safe: false, reason: `IPv6 address "${host}" embeds the private/loopback IPv4 ${teredo.join('.')}` };
    }
    return { safe: true };
  }

  const embedded = embeddedIpv4(g);
  if (embedded && isPrivateIpv4(embedded)) {
    return { safe: false, reason: `IPv6 address "${host}" embeds the private/loopback IPv4 ${embedded.join('.')}` };
  }

  return { safe: true };
}

/** Is this dotted quad in private, loopback, link-local or CGNAT space? */
function isPrivateIpv4(octets) {
  const [a, b] = octets;
  return a === 127 || a === 0 || a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

/** Expand an IPv6 literal into eight 4-hex-digit groups, or null. */
function expandIpv6(h) {
  // A trailing dotted-quad (`::ffff:127.0.0.1`) becomes two hex groups.
  let s = h;
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const [, head, a, b, c, d] = dotted;
    const hi = ((Number(a) << 8) | Number(b)).toString(16).padStart(4, '0');
    const lo = ((Number(c) << 8) | Number(d)).toString(16).padStart(4, '0');
    s = `${head}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (missing < 0) return null;
  const all = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (all.length !== 8) return null;
  if (!all.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => x.padStart(4, '0'));
}

/**
 * The IPv4 address an IPv6 literal embeds, as `[a, b, c, d]`, or null.
 *
 * Covers the four forms that route to an IPv4 destination without a separate
 * decision:
 *   ::ffff:a.b.c.d      IPv4-mapped
 *   ::a.b.c.d           IPv4-compatible (deprecated but still routable)
 *   64:ff9b::a.b.c.d    NAT64 well-known prefix
 *   2002:AABB:CCDD::/48 6to4 — the IPv4 address is bytes 2–5
 *
 * Teredo (2001:0::/32) is NOT here: it needs a decision of its own (a real
 * Teredo address carries a server IPv4, a bogus one does not), so it is handled
 * in `classifyIpv6` where that decision can be stated.
 */
function embeddedIpv4(g) {
  const octets = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

  // ::ffff:a.b.c.d  and  ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return octets(g[6], g[7]);
  }
  // ::ffff:0:a.b.c.d — the "IPv4-translated" form (RFC 2765). It has an EXTRA
  // zero group before the ffff, so the check above misses it. Measured
  // 23 Nov 2026: `http://[::ffff:0:127.0.0.1]/` was reported SAFE. It did not
  // connect on this machine (UND_ERR_SOCKET), but the guard must not depend on
  // the local stack refusing it.
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) {
    return octets(g[6], g[7]);
  }
  // 64:ff9b::/96 (NAT64 well-known prefix) and 64:ff9b:1::/48 (NAT64 local-use,
  // RFC 8215). The local-use prefix is NOT covered by the /96 check, and it
  // embeds the IPv4 in the last 32 bits just the same.
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    if (g.slice(2, 6).every((x) => x === 0)) return octets(g[6], g[7]);
    if (g[2] === 0x0001 && g.slice(3, 6).every((x) => x === 0)) return octets(g[6], g[7]);
  }
  // 2002::/16 (6to4) — IPv4 sits in groups 1 and 2.
  if (g[0] === 0x2002) {
    return octets(g[1], g[2]);
  }
  return null;
}

/**
 * Read a reply body with a hard byte cap.
 *
 * The body is STREAMED and the counter aborts the read the moment the cap is
 * passed, so a hostile or broken host cannot make this process hold the whole
 * reply. Measured 24 Nov 2026: a 64 MB body cost 64 MB of RSS and 64 MB on disk
 * (the `Buffer` plus the `writeFileSync` copy), and `content-length` was never
 * even read — a 5 GiB reply was accepted as far as the header was concerned.
 *
 * A stub `Response` with no `body` stream (the test harness builds those) falls
 * back to `arrayBuffer()` and is checked after the fact; a real `fetch` always
 * has the stream, so the cap is enforced DURING the transfer on every live path.
 */
async function readBodyCapped(res, cap) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`the reply declares ${declared} bytes, over the ${cap}-byte cap for a paper PDF — refused before reading it`);
  }
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) {
      throw new Error(`the reply is ${buf.length} bytes, over the ${cap}-byte cap for a paper PDF`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* already gone */ }
      throw new Error(`the reply passed the ${cap}-byte cap for a paper PDF — download aborted at ${total} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Download the PDF with link guarding.
 *
 * Redirects are followed **OURSELVES, one at a time**, not handed to `fetch`.
 * The reason: `redirect: 'follow'` makes the second hop and beyond never visible
 * to us — so a guard on the initial link alone could be bypassed with one
 * redirect. Measured: `redirect: 'manual'` gives a 3xx status + a Location
 * header, so every hop can be checked with the same `isSafeUrl()`.
 */
export async function downloadPdf(url, destination, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects = 5, maxBytes = MAX_PDF_BYTES } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let current = String(url);
    let res = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = isSafeUrl(current);
      if (!check.safe) throw new Error(`link refused: ${check.reason}`);

      res = await fetch(current, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
      });

      const follow = res.status >= 300 && res.status < 400;
      if (!follow) break;
      const location = res.headers.get('location');
      if (!location) throw new Error(`HTTP ${res.status} without a Location header`);
      if (hop === maxRedirects) throw new Error(`too many redirects (more than ${maxRedirects})`);
      // Location may be relative — resolve it against the current URL.
      current = new URL(location, current).toString();
    }

    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    // `content-type` is checked only when the server STATES one — many
    // repositories omit it, and requiring it would refuse real PDFs. Measured
    // 24 Nov 2026: a `text/html` error page that happened to begin with `%PDF-`
    // was stored as the paper, because the magic prefix was the only test.
    const type = String(res.headers?.get?.('content-type') ?? '').toLowerCase();
    if (type && !/pdf|octet-stream|force-download|x-download|application\/download/.test(type)) {
      throw new Error(`the reply is "${type}", not a PDF`);
    }
    const buf = await readBodyCapped(res, maxBytes);
    const verdict = checkPdfBuffer(buf);
    if (!verdict.ok) {
      throw new Error(`the reply is not a PDF (${buf.length} bytes: ${verdict.reason})`);
    }
    const temporary = `${destination}.part`;
    // `try/finally` around the temporary file. Measured 24 Nov 2026: a failed
    // write or rename left `<destination>.part` behind, and nothing ever
    // collected them — on a full disk every attempt left another one.
    try {
      writeFileSync(temporary, buf);
      renameSync(temporary, destination);
    } catch (e) {
      try { unlinkSync(temporary); } catch { /* nothing was written */ }
      throw e;
    }
    return { bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Store the PDF then turn it into Markdown. NEVER throws for a foreseeable
 * failure (no OA copy, converter missing, download failed) — all of them come
 * back as `{ problem }` so the caller can report things as they are, in line
 * with this package's principle.
 *
 * `converter` is one converter; `converters` is the ordered list to fall through
 * when one fails to spawn or exits 127. Both are accepted because every existing
 * caller passes a single one.
 */
export async function prepareFullText({
  work, identifier, email, converter, converters, root = DEFAULT_ROOT, forceRefresh = false, findArxiv = arxivMatch,
  lookupTimeoutMs = LOOKUP_TIMEOUT_MS,
} = {}) {
  const dir = join(root, 'md');
  const slug = fileSlug(work, identifier);
  const converterList = (converters ?? (converter ? [converter] : [])).filter(Boolean);
  const result = {
    slug, dir, pdf: join(dir, `${slug}.pdf`), md: join(dir, `${slug}.md`),
    converter: converterList[0] ?? converter ?? null,
    fromCache: false, candidates: [], used: null, arxivId: null, arxivFromTitle: false, problem: null,
  };

  // BELT AND BRACES: a file name must never be able to write outside the library
  // folder. `fileSlug` sanitizes the year and the title, but a naming bug must
  // not be the only thing standing between a third-party reply and the rest of
  // the disk — measured 24 Nov 2026, a crafted `publication_year` wrote both the
  // PDF and the `.md` outside `<root>/md/` and reported `problem: null`.
  const insideDir = (p) => {
    const target = resolve(p);
    const base = resolve(dir);
    return target === base || target.startsWith(base + sep);
  };
  if (!insideDir(result.pdf) || !insideDir(result.md)) {
    result.problem = `refusing to write outside the library folder: "${slug}" resolves to ${resolve(result.md)}, which is not inside ${resolve(dir)}`;
    return result;
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    result.problem = `cannot create folder ${dir}: ${e?.message ?? e}`;
    return result;
  }

  /** Drop a cache entry — the `.md`, its PDF, and the marker that vouched for it. */
  const dropCache = () => {
    try { unlinkSync(result.md); } catch { /* leave it; it will be overwritten */ }
    try { unlinkSync(result.pdf); } catch { /* leave it */ }
    try { unlinkSync(markerPath(result.md)); } catch { /* nothing to drop */ }
  };

  // Already converted before? Use that — saves time & does not download twice.
  // BUT check its companion PDF first: that file may have been written by an OLD
  // plugin version, before the `%PDF-` validation existed. If it is damaged, drop
  // its cache companion and continue to the download path — self-healing, rather
  // than serving a `.md` that cannot be trusted.
  //
  // A MISSING PDF IS A MISS, NOT A PASS (measured 24 Nov 2026). The check used to
  // be `existsSync(pdf) ? checkPdf(pdf) : { ok: true, reason: 'no PDF in cache' }`,
  // so a `.md` with no companion PDF was returned as a verified cache hit with
  // `used.from = 'local file'` / note `'already converted'`. The report then
  // printed `pdf : … (not stored)` one line above `PDF source : local file —
  // already converted`, claiming a local PDF that never existed.
  //
  // How that state arises: this function writes the PDF first and converts it
  // second, so its own interrupted runs leave a PDF and no `.md`, never the
  // reverse. An orphaned `.md` comes from outside that sequence — the PDF
  // deleted to save space, the folder copied without the PDFs, a `.md` written
  // by hand or by an older plugin version. In every one of those cases the
  // content is unverifiable: there is nothing left to check it against.
  //
  // So the miss is taken. A cache miss costs one download; a wrong answer costs
  // the reader's trust in every quote taken from it. The `.md` is dropped with
  // the same self-healing path as an invalid PDF, and the reason is reported
  // through `cacheNote` so the user learns why their earlier conversion went
  // away.
  //
  // A NON-EMPTY `.md` IS NOT ENOUGH (measured 24 Nov 2026). The test used to be
  // `statSync(md).size > 0`, so a 29-byte file holding
  // `"# Human-level control\n\nWe pre"` — cut mid-word — beside a valid PDF was
  // returned as `fromCache: true` / `already converted` with zero fetches. The
  // hit now also requires the completion marker written after a successful
  // conversion (see `writeCompletionMarker`), so a `.md` from an older plugin
  // version is a MISS with a stated reason instead of a silent pass.
  if (!forceRefresh) {
    let mdStat = null;
    try { mdStat = statSync(result.md); } catch { /* no cache entry */ }
    if (mdStat && !mdStat.isFile()) {
      // A directory (or a FIFO) named `<slug>.md`. `statSync(dir).size` is 0 on
      // this filesystem, so this used to fall through to the download and then
      // throw `EISDIR` out of `openSync` — contradicting the "NEVER throws"
      // contract above. Measured 24 Nov 2026 through the registered tool:
      // `THREW EISDIR: illegal operation on a directory, open '…/<slug>.md'`.
      result.cacheNote = `cache dropped: ${result.md} is not a regular file — converting again`;
    } else if (mdStat && mdStat.size > 0) {
      const hasPdf = existsSync(result.pdf);
      const previous = hasPdf
        ? checkPdf(result.pdf)
        : { ok: false, reason: 'no PDF in cache to verify it against' };
      if (previous.ok) {
        const complete = verifyCompletionMarker(result.pdf, result.md);
        if (complete.ok) {
          result.fromCache = true;
          result.used = { from: 'local file', note: 'already converted' };
          return result;
        }
        result.cacheNote = `cache dropped: ${complete.reason} — converting again`;
        dropCache();
      } else {
        // The two reasons are different facts and are worded differently: a
        // damaged PDF is "not valid", a missing one is "unverifiable". Both lead
        // to the same action, but a note that called a missing file "not valid"
        // would be a third wrong statement about the same folder.
        result.cacheNote = hasPdf
          ? `cache dropped: its PDF is not valid (${previous.reason}) — downloading again`
          : `cache dropped: the Markdown had no companion PDF, so its content could not be verified (${previous.reason}) — downloading again`;
        dropCache();
      }
    }
  }

  if (converterList.length === 0) {
    result.problem = 'no PDF->Markdown converter on this machine (anydoc or markitdown)';
    return result;
  }

  // 1. The arXiv version — from the work itself, or searched by title.
  let arxivId = arxivIdFromWork(work);
  if (!arxivId && work?.title) {
    try {
      const match = await findArxiv(work.title);
      if (match) { arxivId = match.id; result.arxivFromTitle = true; result.arxivExact = match.exact; }
    } catch (e) {
      result.arxivNote = `arXiv search failed: ${e?.message ?? e}`;
    }
  }
  result.arxivId = arxivId;

  const candidates = pdfCandidates(work, { arxivId });
  const doi = normalizeDoi(work?.doi);
  if (doi && email) {
    // Unpaywall last: it needs an email and one extra request, so it is only
    // used when the candidates above it are absent.
    //
    // THE EMAIL IS NOT PART OF THE CANDIDATE URL (measured 24 Nov 2026). It used
    // to be, and the candidate list is printed to the user on failure — so the
    // user's own address was written into a transcript that may be shared:
    // `https://api.unpaywall.org/v2/10.1038%2Fnature14539?email=secret.person%40university.edu`.
    // The address is appended at request time instead, so the printed URL is the
    // one anyone can open.
    candidates.push({ url: `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`, from: 'unpaywall', note: 'looked up through Unpaywall', needsEmail: true });
  }
  result.candidates = candidates;
  if (candidates.length === 0) {
    // "WE COULD NOT CHECK" IS NOT "THERE IS NOTHING" (measured 24 Nov 2026).
    // With `findArxiv` throwing `ENOTFOUND`, the user saw
    // `FAILED: no open-access copy found for this work` — a definite negative
    // about the world — while the truth was that the arXiv lookup never
    // happened. The two runs are distinguishable in the returned object
    // (`arxivNote`), so the user-visible string must distinguish them too.
    result.problem = result.arxivNote
      ? `no open-access copy found in the OpenAlex reply, and the arXiv lookup FAILED (${result.arxivNote}) — so this is "could not check", not "there is nothing"`
      : 'no open-access copy found for this work';
    return result;
  }

  // 2. Try them one by one until there is a PDF that can actually be downloaded.
  const failures = [];
  // A local write failure is not a PDF-source failure. Measured 24 Nov 2026: a
  // read-only library root produced `all PDF candidates failed (openalex:
  // EACCES: permission denied, open '…/md/<slug>.pdf.part')`, which blames the
  // sources and sends the user to `paper_oa` for a permissions problem.
  const WRITE_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENAMETOOLONG', 'EISDIR', 'ENOTDIR']);
  for (const c of candidates) {
    try {
      let url = c.url;
      if (c.from === 'unpaywall') {
        // BOUNDED, like every other network call in this package. This `fetch`
        // used to carry no `AbortController` and no timeout while `downloadPdf`
        // (120 s) and `getText` (25 s) both had one, so a stub that never
        // settles left `prepareFullText` — and therefore the `paper_fulltext`
        // tool call — running indefinitely. Measured 24 Nov 2026: still running
        // after 3 s with no way to bound it. An unbounded wait is a hung tool,
        // and a tool call has no user watching it who could cancel.
        const lookupUrl = c.needsEmail ? `${c.url}?email=${encodeURIComponent(email)}` : c.url;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), lookupTimeoutMs);
        let r;
        try {
          r = await fetch(lookupUrl, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
        } catch (e) {
          // An abort surfaces as `AbortError` with no useful message; naming the
          // bound is what makes the failure actionable.
          if (ctl.signal.aborted) throw new Error(`timeout > ${formatDuration(lookupTimeoutMs)}`);
          throw e;
        } finally {
          clearTimeout(timer);
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        url = j?.best_oa_location?.url_for_pdf ?? j?.best_oa_location?.url;
        if (!url) throw new Error('Unpaywall names no open-access copy');
      }
      const { bytes } = await downloadPdf(url, result.pdf);
      result.used = { ...c, url, bytes };
      break;
    } catch (e) {
      if (WRITE_ERRORS.has(e?.code)) {
        result.problem = `cannot write to the library folder ${dir}: ${e?.message ?? e} — this is a permissions/disk problem with the library folder, not a problem with the PDF sources`;
        return result;
      }
      failures.push(`${c.from}: ${e?.message ?? e}`);
    }
  }
  if (!result.used) {
    result.problem = `all PDF candidates failed (${failures.join(' | ')})`;
    return result;
  }

  // 3. Conversion — walking the list, because one broken converter must not cost
  // the whole call when another one on this machine works.
  const attempts = [];
  let conv = null;
  let chosen = null;
  for (const candidate of converterList) {
    try {
      conv = await convertToMarkdown(result.pdf, result.md, candidate);
    } catch (e) {
      // `convertToMarkdown` reports its own failures; this catch is for the
      // unforeseeable ones (a descriptor that cannot be opened, a folder that
      // vanished) so that `prepareFullText` keeps its "NEVER throws" promise.
      conv = { ok: false, message: `conversion failed: ${e?.message ?? e}` };
    }
    if (conv.ok) { chosen = candidate; break; }
    attempts.push(`${candidate.name}: ${conv.message}`);
    // Only a converter that cannot RUN is worth replacing. A converter that ran
    // and rejected this PDF will reject it again, and trying the next one would
    // hide the real reason.
    if (!/spawn-failed|exit code 12[67]/.test(conv.message)) break;
  }
  if (!conv?.ok) {
    result.problem = `conversion failed through ${attempts.join(' | ')}`;
    return result;
  }
  result.converter = chosen;
  result.bytes = conv.bytes;
  return result;
}
