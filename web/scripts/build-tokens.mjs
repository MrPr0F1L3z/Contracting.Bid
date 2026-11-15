import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokensToCss } from './tokens-css.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'design');
writeFileSync(join(dir, 'tokens.css'), tokensToCss(JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'))));
console.log('Wrote src/design/tokens.css');
