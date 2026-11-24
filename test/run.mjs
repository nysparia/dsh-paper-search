// Run every test in this directory. `node test/run.mjs`
//
// Each test file is a standalone `.mjs` that prints PASS/FAIL per assertion and
// sets a non-zero exit code on failure; this runner just spawns them and
// aggregates, so a single failing file cannot hide the others.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  // `_`-prefixed files are shared helpers, not tests. `harness.mjs` is the same
  // thing under the name the other defect branches use — skipped by name so a
  // merge that brings both harnesses in does not try to "run" one of them.
  .filter((f) => f.endsWith('.mjs') && f !== 'run.mjs' && f !== 'harness.mjs' && !f.startsWith('_'))
  .sort();

let failed = 0;
for (const f of files) {
  console.log(`\n── ${f} ${'─'.repeat(Math.max(0, 60 - f.length))}`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed} of ${files.length} test files passed`);
if (failed) process.exitCode = 1;
