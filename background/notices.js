/**
 * notices.js - Avisos del autor (novedades, versiones nuevas, incidencias).
 *
 * Cómo funciona: el autor edita un archivo `notices.json` en su repositorio de GitHub (gratis, sin servidor)
 * y la extensión lo consulta cada pocas horas. NO descarga ni instala nada: solo muestra título, texto y un enlace
 * (a GitHub) que el usuario decide abrir. Todo lo que llega se valida y se recorta: un archivo mal escrito se ignora
 * y la extensión conserva los últimos avisos buenos.
 *
 * Formato de notices.json:
 *   { "notices": [ { "id": "2026-11-v1.5.0", "title": "Versión 1.5.0", "message": "Qué cambia…",
 *       "url": "https://github.com/…/releases/tag/v1.5.0", "level": "update",
 *       "date": "2026-11-02", "expires": "2027-02-01", "minVersion": "1.0.0", "maxVersion": "1.4.9" } ] }
 *   - id        (obligatorio) único y estable; así cada aviso se muestra y se notifica UNA sola vez.
 *   - title     (obligatorio) hasta 80 caracteres.
 *   - message   texto plano, hasta 400.
 *   - url       enlace https a github.com / *.github.io (otros se descartan).
 *   - level     info | update | warning.
 *   - expires   fecha a partir de la cual deja de mostrarse.
 *   - minVersion / maxVersion  solo lo ven las versiones dentro de ese rango (p. ej. maxVersion = la última sin el arreglo:
 *               quien ya actualizó no ve el aviso de "actualiza").
 */
import {
  NOTICES_MAX_ITEMS, NOTICE_LINK_HOSTS, NOTICE_LINK_SUFFIXES,
} from '../shared/constants.js';

export const NOTICE_LEVELS = ['info', 'update', 'warning'];

/** "1.4.0" → [1,4,0]; devuelve null si no parece una versión. */
export function parseVersion(value) {
  const match = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/i.exec(String(value ?? '').trim());
  return match ? match[1].split('.').map((n) => parseInt(n, 10)) : null;
}

/** -1, 0 o 1. Si alguna no es una versión válida devuelve null. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Solo https hacia github.com / gist.github.com / *.github.io. Devuelve la URL limpia o null. */
export function safeLink(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  const allowed = NOTICE_LINK_HOSTS.includes(host) || NOTICE_LINK_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
  return allowed ? url.toString() : null;
}

const clean = (value, max, { keepNewlines = false } = {}) => {
  let text = String(value ?? '').replace(keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g : /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
  text = text.replace(/[ \t]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

const toTime = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
};

/**
 * Valida y normaliza el JSON recibido. Nunca lanza excepción.
 * @returns {{ok:boolean, items:object[], skipped:number, error?:string}}
 */
export function normalizeFeed(raw, { version = '0.0.0', now = Date.now() } = {}) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? raw.notices : null);
  if (!Array.isArray(list)) return { ok: false, items: [], skipped: 0, error: 'El archivo de avisos no tiene la lista "notices".' };

  const items = [];
  const seen = new Set();
  let skipped = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { skipped += 1; continue; }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const title = clean(entry.title, 80);
    if (!/^[\w.:-]{1,64}$/.test(id) || !title || seen.has(id)) { skipped += 1; continue; }

    const expires = toTime(entry.expires);
    if (expires !== null && expires <= now) { skipped += 1; continue; }
    if (typeof entry.minVersion === 'string' && compareVersions(version, entry.minVersion) === -1) { skipped += 1; continue; }
    if (typeof entry.maxVersion === 'string' && compareVersions(version, entry.maxVersion) === 1) { skipped += 1; continue; }

    seen.add(id);
    items.push({
      id,
      title,
      message: clean(entry.message, 400, { keepNewlines: true }),
      level: NOTICE_LEVELS.includes(entry.level) ? entry.level : 'info',
      url: safeLink(entry.url),
      date: toTime(entry.date),
    });
    if (items.length >= NOTICES_MAX_ITEMS) break;
  }
  // Más recientes primero; sin fecha, al final y en el orden del archivo.
  items.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
  return { ok: true, items, skipped };
}

/**
 * Estado público para el popup a partir del registro guardado.
 * @param {{items?:object[], read?:string[], dismissed?:string[], checkedAt?:number, error?:string|null}} record
 */
export function publicNotices(record) {
  const rec = record ?? {};
  const read = new Set(rec.read ?? []);
  const dismissed = new Set(rec.dismissed ?? []);
  const items = (rec.items ?? []).filter((n) => !dismissed.has(n.id)).map((n) => ({ ...n, unread: !read.has(n.id) }));
  return {
    items,
    unread: items.filter((n) => n.unread).length,
    checkedAt: rec.checkedAt ?? 0,
    error: rec.error ?? null,
  };
}

/**
 * Combina el registro anterior con un feed nuevo y decide qué avisos hay que notificar.
 * - En la primera consulta de la vida de la extensión nada se notifica (no se llena el escritorio de avisos viejos).
 * - Solo se notifica un aviso una vez (aunque el popup siga mostrándolo).
 */
export function mergeFeed(prev, items, now = Date.now()) {
  const ids = new Set(items.map((n) => n.id));
  const keep = (list) => (list ?? []).filter((id) => ids.has(id));
  const first = !prev?.lastOkAt;
  const read = keep(prev?.read);
  const dismissed = keep(prev?.dismissed);
  const notified = first ? items.map((n) => n.id) : keep(prev?.notified);
  const toNotify = first ? [] : items.filter((n) => !notified.includes(n.id) && !dismissed.includes(n.id) && !read.includes(n.id));
  return {
    record: { items, read, dismissed, notified: [...new Set([...notified, ...toNotify.map((n) => n.id)])], checkedAt: now, lastOkAt: now, error: null },
    toNotify,
  };
}