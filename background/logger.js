/**
 * logger.js — Registro de eventos y errores de la extensión (auditoría y depuración).
 *
 * - Cada entrada: { ts, level, source, event, platform?, details? }.
 *     level:  'info' | 'warn' | 'error'
 *     source: 'background' | 'popup' | 'content'
 * - Se guarda en chrome.storage.local (clave STORAGE_KEYS.logs), como anillo de LOG_LIMIT entradas.
 * - Las escrituras se agrupan (una cada LOG_FLUSH_MS) para no castigar el almacenamiento.
 * - Privacidad: no se guarda el contenido de los mensajes del chat; los textos largos se recortan.
 */
import { STORAGE_KEYS, LOG_LIMIT } from '../shared/constants.js';

const LOG_FLUSH_MS = 500;
const MAX_STRING = 300;
const LEVELS = new Set(['info', 'warn', 'error']);
const SOURCES = new Set(['background', 'popup', 'content']);

let queue = [];
let sink = null;   // receptor opcional de cada lote escrito (el puente local guarda la auditoría en disco)
let timer = null;
let writing = Promise.resolve();

/** Recorta textos y limita profundidad/tamaño de los detalles. */
export function sanitize(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (+${value.length - MAX_STRING})` : value;
  if (value instanceof Error) return sanitize(value.message, depth);
  if (depth >= 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = sanitize(v, depth + 1);
    return out;
  }
  return String(value);
}

function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  if (!batch.length) return writing;
  writing = writing.then(async () => {
    const data = await chrome.storage.local.get(STORAGE_KEYS.logs);
    const logs = [...(data[STORAGE_KEYS.logs] ?? []), ...batch].slice(-LOG_LIMIT);
    await chrome.storage.local.set({ [STORAGE_KEYS.logs]: logs });
    try { sink?.(batch); } catch { /* el receptor nunca debe romper el registro */ }
  }).catch((err) => console.error('[WMB] log', err));
  return writing;
}

/**
 * Registra un evento.
 * @param {'info'|'warn'|'error'} level
 * @param {string} event identificador corto, p. ej. 'tool.call', 'server.status'
 * @param {object} [details]
 * @param {{source?:string, platform?:string}} [meta]
 */
export function log(level, event, details, { source = 'background', platform } = {}) {
  const entry = {
    ts: Date.now(),
    level: LEVELS.has(level) ? level : 'info',
    source: SOURCES.has(source) ? source : 'background',
    event: String(event ?? 'evento').slice(0, 60),
  };
  if (platform) entry.platform = String(platform).slice(0, 30);
  if (details !== undefined) entry.details = sanitize(details);
  queue.push(entry);
  if (level === 'error') console.warn('[WMB]', entry.event, entry.details ?? '');
  if (!timer) timer = setTimeout(flush, LOG_FLUSH_MS);
}

/** Registra una función que recibe cada lote de entradas ya guardado (null para quitarla). */
export function setLogSink(fn) { sink = typeof fn === 'function' ? fn : null; }

/** Fuerza la escritura pendiente (tests y exportación). */
export function flushLogs() {
  clearTimeout(timer);
  return flush();
}

export async function getLogs() {
  await flushLogs();
  const data = await chrome.storage.local.get(STORAGE_KEYS.logs);
  return data[STORAGE_KEYS.logs] ?? [];
}

export async function clearLogs() {
  queue = [];
  clearTimeout(timer);
  timer = null;
  await writing;
  await chrome.storage.local.remove(STORAGE_KEYS.logs);
}
