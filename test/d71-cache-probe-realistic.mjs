// test/d71-cache-probe-realistic.mjs — D71 (audit H2 + L4): the writability
// probe proved a 0-BYTE write, so `writable: true` was reported while every
// `set()` failed.
//
// THE DEFECT. `probeWritable()` wrote `''` and unlinked it. A 0-byte write
// succeeds under a file-size limit, on a disk with a few bytes left, and under
// an exhausted quota — and then every real `set()` fails. Measured 24 Nov 2026
// under `ulimit -f 1` (a 512-byte file-size limit):
//
//   writable (probe: one 0-byte create+unlink) = true
//   set() returned: false
//   get() -> null
//   dir contents: ["cache-search.json.part"]
//
// while the startup note still said "search cache active" — the exact defect
// the probe's own comment claims to have fixed. The user was told repeated
// searches were free and they never were.
//
// L4 rides along: a probe file left by a process that died between write and
// unlink was never removed, so one file per dead pid accumulated forever.
//
// WHAT THIS TEST PINS:
//   1. under a 512-byte file-size limit, `writable` is FALSE (the probe writes a
//      realistic payload, so it fails where the real write would);
//   2. the probe file is removed on that failure path too;
//   3. a normal directory still reports writable (the probe is not just "false");
//   4. a probe left by a dead process is swept at construction.
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const here = dirname(fileURLToPath(import.meta.url));
const root = join(tmpdir(), `dsh-d81-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// ── 1. A file-size limit: the probe must fail where the real write fails ────
{
  const dir = join(root, 'limited');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cache-search.json');
  const child = join(here, '_probe-limit-child.mjs');
  // `ulimit -f 1` = 512-byte files. `"$@"` runs node with the child + file.
  const r = spawnSync('bash', ['-c', 'ulimit -f 1; exec "$@"', 'bash', process.execPath, child, file],
    { encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { /* reported below */ }
  check('the limited child ran and reported', out !== null,
    out === null ? `exit=${r.status} stdout=${JSON.stringify(String(r.stdout).slice(0, 200))} stderr=${JSON.stringify(String(r.stderr).slice(0, 200))}` : 'ok');
  check('under a 512-byte file limit the probe reports writable: FALSE',
    out?.writable === false, out === null ? 'no report' : `writable=${out.writable}`);
  check('...and the real set() fails too, so the report matches reality',
    out?.setOk === false && out?.hit === false, out === null ? 'no report' : `setOk=${out.setOk} hit=${out.hit}`);
  check('the failed probe left no probe file behind',
    out !== null && !out.dir.some((n) => n.includes('.probe-')),
    out === null ? 'no report' : JSON.stringify(out.dir));
}

// ── 2. A normal directory still reports writable ────────────────────────────
{
  const dir = join(root, 'normal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cache-search.json');
  const cache = createCache({ file });
  check('a writable directory still reports writable: true', cache.writable === true);
  check('...and a real set() succeeds', cache.set('k', ['v']) === true);
  check('...and the probe file is gone', readdirSync(dir).every((n) => !n.includes('.probe-')),
    JSON.stringify(readdirSync(dir)));
}

// ── 3. A probe left by a dead process is swept ──────────────────────────────
{
  const dir = join(root, 'stale');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cache-search.json');
  const stale = `${file}.probe-999999`;
  writeFileSync(stale, 'leftover from a process that died');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(stale, old, old);
  const cache = createCache({ file });
  check('a probe left by a dead process is swept at construction',
    !existsSync(stale), existsSync(stale) ? 'still there' : 'swept');
  check('the sweep did not touch the cache file itself',
    cache.writable === true && readdirSync(dir).every((n) => !n.includes('.probe-')),
    JSON.stringify(readdirSync(dir)));
}

rmSync(root, { recursive: true, force: true });
done('D71 the writability probe proved a 0-byte write');
