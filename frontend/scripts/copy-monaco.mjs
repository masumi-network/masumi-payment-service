// Copies Monaco's prebuilt AMD bundle into public/ so the admin UI serves it from
// its own origin. @monaco-editor/loader otherwise pulls it from jsdelivr, which
// the node's CSP (script-src 'self') blocks — the editor then hangs on "Loading..."
// forever because @monaco-editor/react swallows the rejection into a console.error.
//
// Runs as `prebuild`, so `next build` (and the Docker frontend stage) always ships
// assets matching the installed monaco-editor version. See InputSchemaValidator.tsx
// for the matching loader.config() path.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(frontendRoot, 'node_modules/monaco-editor/min/vs');
const target = resolve(frontendRoot, 'public/monaco/vs');

if (!existsSync(source)) {
  console.error(`[copy-monaco] monaco-editor assets not found at ${source}`);
  console.error('[copy-monaco] run `pnpm install` before building the frontend');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-monaco] copied ${source} -> ${target}`);
