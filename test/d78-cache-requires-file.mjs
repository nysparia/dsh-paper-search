// test/d78-cache-requires-file.mjs — D78 (audit L6): `createCache()` with no
// `file` produced `file: undefined` plus a Node deprecation warning.
//
// THE DEFECT. Measured 24 Nov 2026:
//
//   createCache() -> file = undefined | writable = false
//   set() -> false | get() -> null | status().exists = false
//   (DEP0187) DeprecationWarning: Passing invalid argument types to
//   fs.existsSync is deprecated
//
// No throw, so a caller printing `status().file` printed `undefined` — a cache
// reported at a path that does not exist. A missing path is a programming
// error, not a runtime condition, so it now throws a clear TypeError.
//
// WHAT THIS TEST PINS:
//   1. no argument, `{}`, and an empty string all throw a TypeError that names
//      the problem;
//   2. a real path still constructs and works (the guard did not over-reject).
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCache } from '../lib/cache.js';
import { reporter } from './harness.mjs';

const { check, done } = reporter();

const root = join(tmpdir(), `dsh-d69-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const outcome = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (e) {
    return { threw: true, name: e.constructor.name, message: String(e.message) };
  }
};

const noArgs = outcome(() => createCache());
check('createCache() with no argument throws', noArgs.threw === true, noArgs.threw ? 'threw' : 'returned a cache');
check('...with a TypeError that names the missing path',
  noArgs.name === 'TypeError' && /file path/i.test(noArgs.message), `${noArgs.name}: ${noArgs.message}`);

const emptyObject = outcome(() => createCache({}));
check('createCache({}) throws too', emptyObject.threw === true && emptyObject.name === 'TypeError',
  emptyObject.threw ? `${emptyObject.name}: ${emptyObject.message}` : 'returned a cache');

const emptyString = outcome(() => createCache({ file: '' }));
check('createCache({ file: "" }) throws', emptyString.threw === true && emptyString.name === 'TypeError',
  emptyString.threw ? `${emptyString.name}: ${emptyString.message}` : 'returned a cache');

// A real path is still accepted, and the cache still works.
const file = join(root, 'cache-search.json');
const real = outcome(() => createCache({ file }));
check('a real path still constructs', real.threw === false, real.threw ? real.message : 'ok');
check('...and stores and serves', real.threw === false
  && real.value.set('k', ['v']) === true
  && real.value.get('k')?.value?.[0] === 'v');
check('...and status() reports the path, not undefined', real.threw === false && real.value.status().file === file);

rmSync(root, { recursive: true, force: true });
done('D78 createCache() with no file');
