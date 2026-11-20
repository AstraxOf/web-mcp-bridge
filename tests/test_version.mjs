// Pruebas de shared/versioning.js (sin navegador).
import assert from 'node:assert/strict';
import { parseGit, packedRef, versionInfo, reposInfo } from '../shared/versioning.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const packed = `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/main\n${C} refs/remotes/origin/main\n${A} refs/remotes/origin/otra\n`;
assert.equal(packedRef(packed, 'refs/remotes/origin/main'), C);
assert.equal(packedRef(packed, 'refs/heads/nada'), null);
assert.equal(packedRef(null, 'refs/heads/main'), null);

// rama con ref suelto + origin/main en packed-refs
let g = parseGit({ head: 'ref: refs/heads/mistral\n', readRef: (n) => (n === 'refs/heads/mistral' ? `${A}\n` : null), packed });
assert.deepEqual(g, { branch: 'mistral', commit: A, latest: C });
// la rama solo está en packed-refs
g = parseGit({ head: 'ref: refs/heads/main', readRef: () => null, packed });
assert.deepEqual(g, { branch: 'main', commit: B, latest: C });
// ref suelto de origin/main gana sobre packed-refs
g = parseGit({ head: 'ref: refs/heads/main', readRef: (n) => (n === 'refs/remotes/origin/main' ? A : null), packed: null });
assert.equal(g.latest, A);
// HEAD suelto
g = parseGit({ head: B, readRef: () => null, packed: null });
assert.deepEqual(g, { branch: null, commit: B, latest: null });
// nada legible
assert.deepEqual(parseGit({ head: null, readRef: () => null, packed: null }), { branch: null, commit: null, latest: null });
assert.deepEqual(parseGit({ head: 'ref: refs/heads/x', readRef: () => 'basura', packed: null }), { branch: 'x', commit: null, latest: null });

// estados
const base = { version: '1.2.0', commit: A, branch: 'main', latest: A, bootCommit: A };
let v = versionInfo(base);
assert.equal(v.state, 'ok'); assert.equal(v.label, `v1.2.0 · ${A.slice(0, 7)}`); assert.match(v.title, /más reciente/);
assert.equal(versionInfo({ ...base, latest: C }).state, 'old');
assert.equal(versionInfo({ ...base, branch: 'mistral', latest: C }).state, 'branch');
assert.match(versionInfo({ ...base, branch: 'mistral', latest: C }).note, /mistral/);
assert.equal(versionInfo({ ...base, bootCommit: B }).state, 'reload');
assert.equal(versionInfo({ ...base, latest: null }).state, 'unknown');
v = versionInfo({ version: '1.2.0', commit: null });
assert.equal(v.state, 'unknown'); assert.equal(v.label, 'v1.2.0');
assert.equal(versionInfo({ commit: A, latest: A, branch: 'main', bootCommit: A }).label.startsWith('v? '), true);
// repositorios de los MCP
let r = reposInfo([{ name: 'mis-mcp', branch: 'main', commit: A, latest: A, servers: ['telegram-mcp'] }]);
assert.equal(r.state, 'ok'); assert.match(r.lines[0], /mis-mcp \(telegram-mcp\): main aaaaaaa · al día/);
assert.equal(reposInfo([{ name: 'm', branch: 'main', commit: A, latest: C }]).state, 'old');
r = reposInfo([{ name: 'm', branch: 'main', commit: A, latest: A }, { name: 'n', branch: 'vieja', commit: A, latest: C }]);
assert.equal(r.state, 'branch'); assert.match(r.lines[1], /vieja/);
assert.deepEqual(reposInfo(null), { state: 'unknown', lines: [] });
assert.match(versionInfo(base).title, /^Extensión Web MCP Bridge v1.2.0/);
console.log('✔ test_version: todo correcto');
