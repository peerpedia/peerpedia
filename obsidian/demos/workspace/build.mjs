import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({entryPoints: [root + 'demo.ts'], outfile: root + 'demo.js', bundle: true, platform: 'browser', format: 'iife', sourcemap: false, minify: true, target: 'chrome120'});
