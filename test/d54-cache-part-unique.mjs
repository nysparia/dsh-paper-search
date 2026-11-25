// test/d54-cache-part-unique.mjs — D54 (audit M4 + L1): the fixed `.part` name
// raced across processes, and a failed rename left the temporary behind.
//
// THE DEFECT. `write()` used `<file>.part` for every writer, so two processes
// interleaved into ONE file and the last `renameSync` published whatever was on
// disk at that instant — including a 0-byte or half-written file, which `read()`
// then correctly reported as CORRUPT. Measured 24 Nov 2026 with three writers
// and one reader on the same file:
//
//   reads=53701 unparseable=41747 (41450 of them zero-byte)
//
// The user was told their cache was corrupt when nothing was wrong except
// concurrency. And when the rename itself failed, the `.part` file stayed in
// the library root: `set()` -> false with
// `["cache-search.json","cache-search.json.part"]` on disk.
//
// WHAT THIS TEST PINS:
//   1. a failed rename leaves NO temporary behind;
//   2. concurrent writers never publish a truncated file (0 unparseable reads);
//   3. every temporary name carries a pid and a counter, so two writers cannot
//      share one — the deterministic form of (2).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const here = dirname(fileURLToPath(import.meta.url));
const root = join(tmpdir(), `dsh-d54-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// ── 1. A failed rename must not leave the temporary behind ──────────────────
{
  const dir = join(root, 'rename-fails');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cache-search.json');
  // A NON-EMPTY directory at the target path: `renameSync` onto it fails.
  mkdirSync(file, { recursive: true });
  writeFileSync(join(file, 'blocker'), 'x');
  const cache = createCache({ file });
  check('set() fails when the target cannot be renamed onto', cache.set('k', ['v']) === false);
  const leftovers = readdirSync(dir).filter((n) => n.endsWith('.part'));
  check('a failed rename leaves NO .part file behind', leftovers.length === 0,
    leftovers.length ? JSON.stringify(leftovers) : 'clean');
}

// ── 2. Concurrent writers must never publish a truncated file ───────────────
{
  const dir = join(root, 'race');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cache-search.json');
  const writer = join(here, '_cache-writer-child.mjs');
  const children = [0, 1, 2].map(() => spawn(process.execPath, [writer, file, '250'], { stdio: 'ignore' }));

  let reads = 0;
  let unparseable = 0;
  const partNames = new Set();
  while (children.some((p) => p.exitCode === null)) {
    try {
      const text = readFileSync(file, 'utf8');
      reads += 1;
      try { JSON.parse(text); } catch { unparseable += 1; }
    } catch { /* not created yet, or renamed away between the two calls */ }
    for (const name of readdirSync(dir)) if (name.endsWith('.part')) partNames.add(name);
    await new Promise((r) => setImmediate(r));
  }

  check('the reader really observed the file', reads > 0, `${reads} reads`);
  check('no read ever saw a truncated file', unparseable === 0,
    `${unparseable} of ${reads} reads unparseable`);
  check('the final file parses', (() => { try { JSON.parse(readFileSync(file, 'utf8')); return true; } catch { return false; } })());
  check('no temporary file is left after the writers finish',
    readdirSync(dir).every((n) => !n.endsWith('.part')), JSON.stringify(readdirSync(dir)));

  // The deterministic form of the same fact: a temporary name must carry the
  // writer's pid and a counter. `<file>.part` carries neither, so two writers
  // share it — which is exactly how a truncated file got renamed into place.
  const pattern = new RegExp(`^${basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.\\d+\\.part$`);
  const bad = [...partNames].filter((n) => !pattern.test(n));
  check('every temporary name is unique per writer (pid + counter)',
    bad.length === 0, bad.length ? `shared names: ${JSON.stringify(bad)}` : `${partNames.size} distinct names`);
}

rmSync(root, { recursive: true, force: true });
done('D54 the fixed .part name raced across processes');
