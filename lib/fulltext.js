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
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
 * Which converter actually EXISTS on this machine.
 * `anydoc` is preferred (fast, Rust, no Python); `markitdown` is the fallback.
 * Returns `null` if there is not a single one — and that is reported as it is,
 * not hidden until this feature looks "broken".
 */
export function findConverter(config = {}) {
  const list = [];
  const anydocConfig = config.anydocPath ?? config.ANYDOC_PATH;
  if (anydocConfig) list.push({ name: 'anydoc', path: anydocConfig, from: 'plugin config' });
  for (const p of usualPaths('anydoc', 'anydoc.exe')) list.push({ name: 'anydoc', path: p, from: 'usual path' });

  const mdConfig = config.markitdownPath ?? config.MARKITDOWN_PATH;
  if (mdConfig) list.push({ name: 'markitdown', path: mdConfig, from: 'plugin config' });
  for (const p of usualPaths('markitdown', 'markitdown.exe')) list.push({ name: 'markitdown', path: p, from: 'usual path' });

  for (const c of list) if (existsSync(c.path)) return c;
  return null;
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

/**
 * Turn a PDF into Markdown at `md`.
 * The child's output is directed to a FILE through a file descriptor (not a
 * pipe), and stderr is captured separately so its original message can be
 * reported.
 */
export async function convertToMarkdown(pdf, md, converter, { timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  if (!existsSync(pdf)) return { ok: false, message: `PDF does not exist: ${pdf}` };
  if (existsSync(md)) { try { unlinkSync(md); } catch { /* leave it; it will be overwritten */ } }
  const errorFile = `${md}.err`;
  const fdOut = openSync(md, 'w');
  const fdErr = openSync(errorFile, 'w');
  let succeeded = false;
  try {
    // `-o <path>` is used by anydoc AND by newer markitdown. If the converter
    // does not know `-o`, the output is empty -> reported as a failure.
    const args = [pdf, '-o', md];
    const { cmd, args: argv } = spawnCommand(converter, args);
    const code = await new Promise((done) => {
      let child;
      try {
        child = spawn(cmd, argv, { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
      } catch (e) {
        done(`spawn-failed: ${e?.message ?? e}`);
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already dead */ }
        done('timeout');
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); done(`spawn-failed: ${e?.message ?? e}`); });
      child.on('close', (c) => { clearTimeout(timer); done(c); });
    });

    const error = existsSync(errorFile) ? readFileSync(errorFile, 'utf8').trim().slice(0, 400) : '';
    const size = existsSync(md) ? statSync(md).size : 0;
    if (code === 0 && size > 0) { succeeded = true; return { ok: true, bytes: size, message: error }; }
    const reason = code === 'timeout' ? `timeout > ${Math.round(timeoutMs / 1000)} s`
      : typeof code === 'number' && code !== 0 ? `exit code ${code}`
        : String(code);
    return { ok: false, message: [reason, error].filter(Boolean).join(' — ').slice(0, 500) };
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
    // The error file is only useful when it FAILS. On success its content is
    // empty and it used to pile up one per paper (measured 29 Sep 2026: 1
    // zero-byte file per conversion). Deleted AFTER the descriptors are closed —
    // on Windows, deleting a file that is still open will fail.
    if (succeeded) {
      try { unlinkSync(errorFile); } catch { /* leave it */ }
    } else {
      // FAILED: drop the EMPTY Markdown left over from the attempt so the library
      // folder does not keep a zero-byte file. The `.err` file is DELIBERATELY
      // left behind — it holds the converter's original message, and the caller
      // has already read it above.
      // (Other callers are safe: line 243 requires size > 0.)
      try { if (existsSync(md) && statSync(md).size === 0) unlinkSync(md); } catch { /* leave it */ }
    }
  }
}

// ── Finding & downloading the PDF ────────────────────────────────────────────

/**
 * List of open-access PDFs worth trying, IN ORDER: **arXiv first**
 * (upstream PR #124), then the OpenAlex OA locations.
 *
 * `arxivId` is filled with the result of `arxivMatch()` when the work itself
 * does not name its arXiv id — the caller does the searching, so this function
 * stays pure & testable without a network.
 */
export function pdfCandidates(work, { arxivId = null } = {}) {
  const out = [];
  const add = (url, from, note) => {
    if (!url || out.some((c) => c.url === url)) return;
    out.push({ url, from, note });
  };

  const idArxiv = arxivId ?? arxivIdFromWork(work);
  if (idArxiv) {
    add(`https://arxiv.org/pdf/${idArxiv}`, 'arxiv', `arXiv preprint ${idArxiv} — usually the fastest & the most often hit`);
  }
  const oa = summarizeOA(work);
  for (const l of oa.locations) {
    if (!l.pdf) continue;
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
  const year = work?.publication_year ?? 'x';
  const normalizedTitle = rawTitle.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${readable || 'paper'}-${year}-${shortHash(`${normalizedTitle}\u0000${year}`)}`;
}

/**
 * Is this file really a PDF? The conditions: it exists, is >= 1000 bytes, and
 * starts with `%PDF-`. Used in TWO places: before writing a new file (rejecting
 * a reply that is not a PDF) and before using a PDF from the cache (healing a
 * damaged file that an older plugin version may have written, before this
 * validation existed).
 *
 * The conditions used to be rewritten inside `downloadPdf`, so they could not be
 * used to check a file already on disk.
 */
export function checkPdf(file) {
  if (!existsSync(file)) return { ok: false, reason: 'file does not exist' };
  let size;
  try {
    size = statSync(file).size;
  } catch (e) {
    return { ok: false, reason: `cannot be read: ${e?.message ?? e}` };
  }
  if (size < 1000) return { ok: false, reason: `only ${size} bytes` };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(5);
    const n = readSync(fd, buf, 0, 5, 0);
    const prefix = buf.subarray(0, n).toString('latin1');
    if (prefix !== '%PDF-') return { ok: false, reason: `prefix "${prefix.replace(/[^\x20-\x7e]/g, '.')}"` };
    return { ok: true, bytes: size };
  } catch (e) {
    return { ok: false, reason: `cannot be read: ${e?.message ?? e}` };
  } finally {
    closeSync(fd);
  }
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
  const embedded = embeddedIpv4(g);
  if (embedded) {
    const [a, b] = embedded;
    const isPrivate =
      a === 127 || a === 0 || a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    if (isPrivate) {
      return { safe: false, reason: `IPv6 address "${host}" embeds the private/loopback IPv4 ${embedded.join('.')}` };
    }
  }

  return { safe: true };
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
 * Covers the five forms that actually route to an IPv4 destination:
 *   ::ffff:a.b.c.d      IPv4-mapped
 *   ::a.b.c.d           IPv4-compatible (deprecated but still routable)
 *   64:ff9b::a.b.c.d    NAT64 well-known prefix
 *   2002:AABB:CCDD::/48 6to4 — the IPv4 address is bytes 2–5
 *   2001:0:...          Teredo — the client IPv4 is the last 32 bits, bit-inverted
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
  // 2001:0::/32 (Teredo) — last 32 bits are the client IPv4, bit-inverted.
  if (g[0] === 0x2001 && g[1] === 0x0000) {
    const hi = (~g[6]) & 0xffff;
    const lo = (~g[7]) & 0xffff;
    return octets(hi, lo);
  }
  return null;
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
export async function downloadPdf(url, destination, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects = 5 } = {}) {
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
    const buf = Buffer.from(await res.arrayBuffer());
    const prefix = buf.subarray(0, 5).toString('latin1');
    if (buf.length < 1000 || prefix !== '%PDF-') {
      throw new Error(`the reply is not a PDF (${buf.length} bytes, prefix "${prefix.replace(/[^\x20-\x7e]/g, '.')}")`);
    }
    const temporary = `${destination}.part`;
    writeFileSync(temporary, buf);
    renameSync(temporary, destination);
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
 */
export async function prepareFullText({
  work, identifier, email, converter, root = DEFAULT_ROOT, forceRefresh = false, findArxiv = arxivMatch,
} = {}) {
  const dir = join(root, 'md');
  const slug = fileSlug(work, identifier);
  const result = {
    slug, dir, pdf: join(dir, `${slug}.pdf`), md: join(dir, `${slug}.md`),
    converter, fromCache: false, candidates: [], used: null, arxivId: null, arxivFromTitle: false, problem: null,
  };

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    result.problem = `cannot create folder ${dir}: ${e?.message ?? e}`;
    return result;
  }

  // Already converted before? Use that — saves time & does not download twice.
  // BUT check its companion PDF first: that file may have been written by an OLD
  // plugin version, before the `%PDF-` validation existed. If it is damaged, drop
  // its cache companion and continue to the download path — self-healing, rather
  // than serving a `.md` that cannot be trusted.
  if (!forceRefresh && existsSync(result.md) && statSync(result.md).size > 0) {
    const previous = existsSync(result.pdf) ? checkPdf(result.pdf) : { ok: true, reason: 'no PDF in cache' };
    if (previous.ok) {
      result.fromCache = true;
      result.used = { from: 'local file', note: 'already converted' };
      return result;
    }
    result.cacheNote = `cache dropped: its PDF is not valid (${previous.reason}) — downloading again`;
    try { unlinkSync(result.md); } catch { /* leave it; it will be overwritten */ }
    try { unlinkSync(result.pdf); } catch { /* leave it */ }
  }

  if (!converter) {
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
    candidates.push({ url: `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, from: 'unpaywall', note: 'looked up through Unpaywall' });
  }
  result.candidates = candidates;
  if (candidates.length === 0) {
    result.problem = 'no open-access copy found for this work';
    return result;
  }

  // 2. Try them one by one until there is a PDF that can actually be downloaded.
  const failures = [];
  for (const c of candidates) {
    try {
      let url = c.url;
      if (c.from === 'unpaywall') {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        url = j?.best_oa_location?.url_for_pdf ?? j?.best_oa_location?.url;
        if (!url) throw new Error('Unpaywall names no open-access copy');
      }
      const { bytes } = await downloadPdf(url, result.pdf);
      result.used = { ...c, url, bytes };
      break;
    } catch (e) {
      failures.push(`${c.from}: ${e?.message ?? e}`);
    }
  }
  if (!result.used) {
    result.problem = `all PDF candidates failed (${failures.join(' | ')})`;
    return result;
  }

  // 3. Conversion.
  const conv = await convertToMarkdown(result.pdf, result.md, converter);
  if (!conv.ok) {
    result.problem = `conversion failed through ${converter.name}: ${conv.message}`;
    return result;
  }
  result.bytes = conv.bytes;
  return result;
}
