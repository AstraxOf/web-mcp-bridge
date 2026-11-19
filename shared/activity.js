/**
 * activity.js — Une el registro de eventos y el historial de llamadas en UN solo listado con insignias (badges).
 * Código puro (sin chrome.* ni DOM): se usa en el popup/panel lateral y se prueba con Node.
 */

export const CATEGORY_LABEL = {
  call: 'Llamada', ai: 'IA', sync: 'GitHub', result: 'Resultado', chat: 'Chat', server: 'Servidor', system: 'Sistema',
};

const PREFIX_TO_CATEGORY = {
  call: 'call', tool: 'call', ai: 'ai', sync: 'sync', result: 'result', chat: 'chat',
  server: 'server', servers: 'server', bridge: 'server',
};

/** Categoría de un evento a partir de su prefijo («call.exec.end» → call). */
export const categoryOf = (event) => PREFIX_TO_CATEGORY[String(event ?? '').split('.')[0]] ?? 'system';

const LABELS = {
  'ai.streaming': 'La IA empezó a responder',
  'ai.done': 'La IA terminó de responder',
  'ai.stuck_indicator': 'El indicador «generando» parece pegado',
  'ai.no_response': 'La IA no responde tras recibir el resultado',
  'call.detected': 'Llamada detectada',
  'call.skipped': 'Llamada descartada',
  'call.resolved': 'Servidor y herramienta localizados',
  'call.ignored': 'Llamada ignorada',
  'call.permission': 'Permiso del MCP',
  'call.approval.wait': 'Esperando tu aprobación',
  'call.approval': 'Respuesta a la aprobación',
  'call.brake': 'Freno de seguridad',
  'call.exec.start': 'Ejecutando la herramienta',
  'call.exec.end': 'La herramienta terminó',
  'call.unreadable': 'Bloque ilegible',
  'call.retry_stop': 'Reintento automático detenido',
  'call.failed': 'Fallo interno en la llamada',
  'tool.call': 'Herramienta ejecutada',
  'sync.check': 'Comparación con GitHub',
  'sync.choice': 'Decisión: GitHub o local',
  'result.deliver.start': 'Entregando el resultado al chat',
  'result.delivered': 'Resultado entregado al chat',
  'result.image_skipped': 'Imagen no adjuntada',
  'chat.start': 'Pestaña de chat iniciada',
  'server.connected': 'MCP conectado',
  'server.down': 'MCP sin conexión',
  'server.tools': 'Herramientas del MCP cargadas',
  'bridge.up': 'Puente local disponible',
  'bridge.down': 'Puente local caído',
  'sw.start': 'Extensión iniciada',
};

const HIDDEN_KEYS = new Set(['cid', 'message', 'server', 'tool', 'ms', 'status', 'platform']);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const show = (value) => clip(typeof value === 'string' ? value : JSON.stringify(value), 70);

/** Título legible del evento. En «chat.panel» el título es el propio mensaje. */
export function titleOf(entry) {
  if (entry.event === 'chat.panel' && entry.details?.message) return String(entry.details.message);
  // «Descartada» asustaba: casi siempre es volver a leer el MISMO mensaje cuya llamada ya se ejecutó.
  if (entry.event === 'call.skipped' && entry.details?.reason === 'duplicate') {
    return entry.details.seenHere ? 'Ya ejecutada: la web volvió a mostrar el mismo mensaje' : 'Llamada idéntica a una anterior: se te pregunta';
  }
  if (entry.event === 'call.skipped' && entry.details?.reason === 'locked') return 'Idéntica a la que está en curso: se te pregunta';
  if (entry.event === 'call.skipped' && entry.details?.reason === 'baseline') return 'Llamada antigua (de antes de abrir la pestaña)';
  return LABELS[entry.event] ?? entry.event;
}

/** Línea de detalle: «servidor › herramienta» más el resto de datos, recortados. */
export function summaryOf(entry) {
  const d = entry.details;
  if (!d || typeof d !== 'object') return d ? String(d) : '';
  const parts = [];
  if (d.server && d.tool) parts.push(`${d.server} › ${d.tool}`);
  else if (d.tool) parts.push(String(d.tool));
  for (const [key, value] of Object.entries(d)) {
    if (HIDDEN_KEYS.has(key) || value === undefined || value === null || value === '') continue;
    parts.push(`${key}: ${show(value)}`);
  }
  return clip(parts.join(' · '), 240);
}

/** Estado que se pinta como insignia de color: { tone: 'ok'|'warn'|'error', text } o null. */
export function statusOf(entry) {
  const s = entry.details?.status;
  if (s === 'ok') return { tone: 'ok', text: 'OK' };
  if (s === 'error') return { tone: 'error', text: 'Error' };
  if (s === 'rejected') return { tone: 'warn', text: 'Rechazada' };
  if (entry.level === 'error') return { tone: 'error', text: 'Error' };
  if (entry.level === 'warn') return { tone: 'warn', text: 'Aviso' };
  return null;
}

/**
 * Mezcla registro e historial en una lista ordenada (lo más reciente primero).
 * Las entradas del historial que ya tienen su evento `tool.call` en el registro no se repiten.
 */
export function mergeActivity(logs = [], history = []) {
  const toolCalls = logs.filter((l) => l.event === 'tool.call');
  const items = logs.map((l, i) => ({
    key: `l${l.ts}-${i}`, ts: l.ts, event: l.event, cat: categoryOf(l.event), level: l.level, source: l.source,
    platform: l.platform ?? null, cid: l.details?.cid ?? null, ms: l.details?.ms ?? null,
    title: titleOf(l), summary: summaryOf(l), status: statusOf(l), raw: l,
  }));
  history.forEach((h, i) => {
    if (toolCalls.some((l) => l.details?.tool === h.tool && Math.abs(l.ts - h.ts) < 3000)) return;
    const raw = { ts: h.ts, level: h.status === 'ok' ? 'info' : 'error', source: 'background', event: 'tool.call', details: { server: h.server, tool: h.tool, status: h.status, ms: h.ms, args: h.args, error: h.error } };
    items.push({
      key: `h${h.ts}-${i}`, ts: h.ts, event: 'tool.call', cat: 'call', level: raw.level, source: 'background', platform: null, cid: null,
      ms: h.ms ?? null, title: LABELS['tool.call'], summary: summaryOf(raw), status: statusOf(raw), raw,
    });
  });
  return items.sort((a, b) => b.ts - a.ts);
}

/** Filtros del listado: all · calls · ai · sync · errors; `query` busca en título, detalle, evento e id de llamada. */
export function matchesFilter(item, filter = 'all', query = '') {
  if (filter === 'calls' && !['call', 'result'].includes(item.cat)) return false;
  if (filter === 'ai' && item.cat !== 'ai') return false;
  if (filter === 'sync' && item.cat !== 'sync') return false;
  if (filter === 'errors' && !['warn', 'error'].includes(item.level) && !['error', 'warn'].includes(item.status?.tone)) return false;
  const q = String(query).trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  return `${item.title} ${item.summary} ${item.event} ${item.cid ?? ''} ${item.platform ?? ''}`.toLowerCase().includes(q);
}

export const fmtMs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
