// Comprueba la sintaxis de todos los .js del proyecto y valida manifest.json.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const skip = new Set(['node_modules', '.git', 'dist']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|mjs)$/.test(name)) files.push(path);
  }
})('.');

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) { failed += 1; console.error(`✘ ${file}\n${res.stderr}`); }
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
for (const cs of manifest.content_scripts) {
  for (const js of cs.js) { try { statSync(js); } catch { failed += 1; console.error(`✘ manifest referencia un archivo inexistente: ${js}`); } }
}
for (const icon of Object.values(manifest.icons)) { try { statSync(icon); } catch { failed += 1; console.error(`✘ falta el icono ${icon}`); } }

if (failed) process.exit(1);
console.log(`✔ ${files.length} archivos JS válidos y manifest coherente`);
