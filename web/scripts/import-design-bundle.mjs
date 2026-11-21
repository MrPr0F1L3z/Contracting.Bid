// Usage: pnpm design:import <path to the design system's components folder>
// Copies bundle.js (converted to a module), bundle.css, index.d.ts and tokens.json into src/design,
// the bundle's sample open projects into src/design/sample-listings.json (for server code),
// and the bundle's own tests into test/design.test.js.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { extractSampleListings, toModule, toVitest } from './design-module.mjs';

const from = process.argv[2];
if (!from) {
  console.error('Usage: pnpm design:import <path to components folder>');
  process.exit(1);
}
const src = resolve(from);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'design');
writeFileSync(join(out, 'cb.js'), toModule(readFileSync(join(src, 'bundle.js'), 'utf8')));
copyFileSync(join(src, 'bundle.css'), join(out, 'components.css'));
copyFileSync(join(src, 'index.d.ts'), join(out, 'cb.d.ts'));
copyFileSync(join(src, '..', 'tokens.json'), join(out, 'tokens.json'));
writeFileSync(join(out, 'sample-listings.json'), JSON.stringify(extractSampleListings(readFileSync(join(src, 'bundle.js'), 'utf8'), React), null, 2) + '\n');
writeFileSync(join(out, '..', '..', 'test', 'design.test.js'), toVitest(readFileSync(join(src, 'src', 'bundle.test.js'), 'utf8')));
console.log('Imported design bundle into', out, '- now run: pnpm tokens');
