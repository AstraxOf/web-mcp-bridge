/**
 * notices.js - Author notices (news, new versions, incidents).
 *
 * How it works: the author edits a `notices.json` file in their GitHub repository (free, no server)
 * and the extension checks it every few hours. It does NOT download or install anything: it only
 * shows a title, text and a link (to GitHub) that the user chooses to open. Everything that arrives
 * is validated and trimmed: a malformed file is ignored and the extension keeps the last good notices.
 *
 * notices.json format:
 *   { "notices": [ { "id": "2026-11-v1.5.0", "title": "Version 1.5.0", "message": "What changes...",
 *       "url": "https://github.com/.../releases/tag/v1.5.0", "level": "update",
 *       "date": "2026-11-02", "expires": "2027-02-01", "minVersion": "1.0.0", "maxVersion": "1.4.9" } ] }
 *   - id          (required) unique and stable; this way each notice is shown and notified only once.
 *   - title       (required) up to 80 characters.
 *   - message     plain text, up to 400.
 *   - url         https link to github.com / *.github.io (others are discarded).
 *   - level       info | update | warning.
 *   - expires     date from which it stops being shown.
 *   - minVersion / maxVersion  only visible to versions within that range (e.g. maxVersion = the last
 *                 one without the fix: those who already updated do not see the "update" notice).
 */
import {
  NOTICES_MAX_ITEMS, NOTICE_LINK_HOSTS, NOTICE_LINK_SUFFIXES,
} from '../shared/constants.js';

export const NOTICE_LEVELS = ['info', 'update', 'warning'];

/** "1.4.0" -> [1,4,0]; returns null if it does not look like a version. */
export function parseVersion(value) {
  const match = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/i.exec(String(value ?? '').trim());
  return match ? match[1].split('.').map((n) => parseInt(n, 10)) : null;
}

/** -1, 0 or 1. If either one is not a valid version returns null. */
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

/** Only https to github.com / gist.github.com / *.github.io. Returns the clean URL or null. */
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
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
};

const toTime = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
};

/**
 * Validates and normalizes the received JSON. Never throws.
 * @returns {{ok:boolean, items:object[], skipped:number, error?:string}}
 */
export function normalizeFeed(raw, { version = '0.0.0', now = Date.now() } = {}) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? raw.notices : null);
  if (!Array.isArray(list)) return { ok: false, items: [], skipped: 0, error: 'The notices file has no "notices" list.' };

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
  items.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
  return { ok: true, items, skipped };
}

/**
 * Public state for the popup from the stored record.
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
 * Merges the previous record with a new feed and decides which notices should be notified.
 * - On the very first check of the extension nothing is notified (desktop not flooded with old notices).
 * - Each notice is notified only once (even if the popup keeps showing it).
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
