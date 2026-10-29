// Empaqueta la extensión en dist/web-mcp-bridge.zip (lista para Chrome Web Store / GitHub Releases).
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('dist', { recursive: true });
const res = spawnSync('zip', ['-r', 'dist/web-mcp-bridge.zip', 'manifest.json', 'background', 'content_scripts', 'popup', 'shared', 'icons', '-x', '*.DS_Store'], { stdio: 'inherit' });
process.exit(res.status ?? 1);
