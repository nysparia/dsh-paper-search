#!/usr/bin/env node
// test/fake-converter.mjs — a stand-in for anydoc/markitdown.
//
// `convertToMarkdown` runs `<converter> <pdf> -o <md>`, so a test needs a real
// executable that writes a non-empty Markdown file. This one does exactly that
// and nothing else — no PDF parsing, because the test is about the reply text,
// not about conversion quality.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args.indexOf('-o') >= 0 ? args[args.indexOf('-o') + 1] : null;
if (!out) {
  console.error('usage: fake-converter.mjs <pdf> -o <md>');
  process.exit(2);
}
writeFileSync(out, '# Converted paper\n\nThis is the converted body.\n');
