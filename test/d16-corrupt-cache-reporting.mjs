// test/d16-corrupt-cache-reporting.mjs — D16: a corrupt cache file was silently
// treated as empty.
//
// `createCache`'s `read()` catches a JSON parse failure and returns an empty
// cache. That is the right BEHAVIOUR — a cache is an accelerator, not the source
// of truth — but nothing reported it. Measured on the round-1 baseline:
//
//   writeFileSync(file, '{ this is not json')
//   cache.get('anything')  -> null
//   cache.status()         -> { count: 0, validCount: 0, exists: true }
//
// `exists: true` with `count: 0` is the only hint, and `paper_status` printed the
// count without ever saying the file is unreadable. A user whose cache file got
// truncated saw "0 entries" forever and never learned why.
//
// The fix REPORTS the failure; it must not change `get()`/`set()` semantics.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { installFetch, loadTools, reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d16-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const file = join(root, 'cache-search.json');

// ── a corrupt file ───────────────────────────────────────────────────────────
writeFileSync(file, '{ this is not json');
const corrupt = createCache({ file });

check('a corrupt file still reads as an EMPTY cache (get -> null)',
  corrupt.get('anything') === null, String(corrupt.get('anything')));
const cs = corrupt.status();
check('status() reports the file as corrupt', cs.corrupt === true, JSON.stringify(cs.corrupt));
check('status() still reports exists: true', cs.exists === true, JSON.stringify(cs.exists));
check('status() still reports count: 0', cs.count === 0, JSON.stringify(cs.count));

// `set()` must still work: the corrupt file is replaced, not preserved.
check('set() still succeeds on a corrupt file', corrupt.set('k', { a: 1 }) === true);
check('after set() the entry is readable', corrupt.get('k')?.value?.a === 1, JSON.stringify(corrupt.get('k')));
check('after set() the file is valid JSON again',
  (() => { try { JSON.parse(readFileSync(file, 'utf8')); return true; } catch { return false; } })());
check('after set() status() no longer reports corrupt', corrupt.status().corrupt === false,
  JSON.stringify(corrupt.status().corrupt));

// ── a valid file is NOT reported as corrupt ──────────────────────────────────
const validFile = join(root, 'valid.json');
const valid = createCache({ file: validFile });
valid.set('k', { a: 2 });
check('a valid file is not reported as corrupt', valid.status().corrupt === false,
  JSON.stringify(valid.status().corrupt));

// ── a MISSING file is not corrupt either ─────────────────────────────────────
const missing = createCache({ file: join(root, 'nope.json') });
check('a missing file is not reported as corrupt', missing.status().corrupt === false,
  JSON.stringify(missing.status().corrupt));

// ── a file that parses but has the wrong SHAPE is corrupt too ────────────────
// `read()` already rejects it and starts clean; it is just as unreadable to the
// user as a parse failure, so it must be reported the same way.
const wrongShape = join(root, 'wrong-shape.json');
writeFileSync(wrongShape, '{"version":1,"entries":"not an object"}');
check('a wrong-shaped file is reported as corrupt', createCache({ file: wrongShape }).status().corrupt === true);

// ── paper_status must SAY it ─────────────────────────────────────────────────
const mock = installFetch(() => ({ body: {} }));
const tools = loadTools({ cache: true, libraryRoot: root, cacheFile: file });
writeFileSync(file, '{ this is not json');
const reply = await tools.get('paper_status').execute({});
mock.restore();

check('paper_status says the cache file could not be parsed',
  /could not be parsed|unreadable|corrupt/i.test(reply),
  reply.split('\n').filter((l) => /cache|parsed|corrupt/i.test(l)).join(' | ') || 'no line mentions the cache');
check('paper_status says the file will be overwritten on the next successful search',
  /overwritten/i.test(reply),
  reply.split('\n').filter((l) => /overwritten/i.test(l)).join(' | '));
check('the warning sits in the cache section, not somewhere else',
  (() => {
    const lines = reply.split('\n');
    const at = lines.findIndex((l) => /== search cache ==/.test(l));
    if (at < 0) return false;
    const end = lines.findIndex((l, i) => i > at && /^== /.test(l));
    const section = lines.slice(at, end < 0 ? undefined : end);
    return section.some((l) => /could not be parsed|unreadable|corrupt/i.test(l));
  })(),
  reply.split('\n').slice(0, 20).join(' | '));

// A healthy cache must NOT print the warning.
const healthyFile = join(root, 'healthy.json');
const healthy = createCache({ file: healthyFile });
healthy.set('k', { a: 3 });
const mock2 = installFetch(() => ({ body: {} }));
const tools2 = loadTools({ cache: true, libraryRoot: root, cacheFile: healthyFile });
const reply2 = await tools2.get('paper_status').execute({});
mock2.restore();
check('a healthy cache prints no corruption warning',
  !/could not be parsed|unreadable|corrupt/i.test(reply2),
  reply2.split('\n').filter((l) => /cache|parsed|corrupt/i.test(l)).join(' | '));

rmSync(root, { recursive: true, force: true });
done('D16 corrupt cache silently treated as empty');
