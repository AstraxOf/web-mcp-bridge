/**
 * idempotency.js — Deduplicacion de llamadas de ESCRITURA a herramientas MCP.
 *
 * Problema: si el modelo reenvia un bloque identico (o el usuario pulsa enviar dos veces),
 * una herramienta como create_or_update_file se ejecuta dos veces y produce dos commits.
 *
 * Solucion: para herramientas marcadas como "write", se calcula una clave estable
 * (server + nombre + argumentos normalizados). Mientras haya una llamada en vuelo con
 * la misma clave, se reutiliza la promesa. Si la llamada termino bien, el resultado se
 * guarda en cache durante TTL_MS y las repeticiones lo devuelven sin reejecutar.
 *
 * Los errores NO se cachean: un reintento tras un fallo debe poder ejecutarse.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutos
const MAX_ENTRIES = 200;

// Herramientas con efecto secundario. Una repeticion de estas es peligrosa.
export const WRITE_TOOLS = new Set([
  'create_or_update_file',
  'delete_file',
  'push_files',
  'create_branch',
  'create_pull_request',
  'merge_pull_request',
  'update_pull_request',
  'update_pull_request_branch',
  'create_repository',
  'fork_repository',
  'issue_write',
  'add_issue_comment',
  'update_issue_comment',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
  'pull_request_review_write',
  'sub_issue_write',
  'assign_copilot_to_issue',
  'request_copilot_review',
  'stage_file',
  'flush_staged_file',
  'abort_staged_file',
]);

const settled = new Map();   // key -> { at, result }
const inflight = new Map();  // key -> Promise

/** JSON estable: ordena las claves para que {a,b} y {b,a} produzcan la misma cadena. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Hash FNV-1a de 64 bits (rapido, sin crypto.subtle async). */
function hash(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function keyOf(serverId, name, args) {
  return hash(`${serverId}\u0000${name}\u0000${stableStringify(args ?? {})}`);
}

function prune() {
  const now = Date.now();
  for (const [k, v] of settled) {
    if (now - v.at > TTL_MS) settled.delete(k);
  }
  while (settled.size > MAX_ENTRIES) {
    const oldest = [...settled.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    settled.delete(oldest[0]);
  }
}

export function isWriteTool(name) {
  if (!name) return false;
  if (WRITE_TOOLS.has(name)) return true;
  // Los servidores MCP pueden prefijar el nombre (ej. github_create_or_update_file)
  for (const tool of WRITE_TOOLS) {
    if (name.endsWith(`_${tool}`)) return true;
  }
  return false;
}

/**
 * Ejecuta `run()` con deduplicacion si `name` es una herramienta de escritura.
 * @returns {Promise<{result:any, cached:boolean}>}
 */
export async function runIdempotent(serverId, name, args, run) {
  if (!isWriteTool(name)) {
    return { result: await run(), cached: false };
  }
  const key = keyOf(serverId, name, args);
  prune();
  const hit = settled.get(key);
  if (hit) return { result: hit.result, cached: true };
  const pending = inflight.get(key);
  if (pending) return { result: await pending, cached: true };

  const p = (async () => {
    try {
      const result = await run();
      settled.set(key, { at: Date.now(), result });
      return result;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return { result: await p, cached: false };
}

/** Solo para pruebas / diagnostico. */
export function _reset() {
  settled.clear();
  inflight.clear();
}

export function stats() {
  return { settled: settled.size, inflight: inflight.size };
}
