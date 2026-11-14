/**
 * tool_catalog.js — Catálogo paginado de herramientas (v1.7.2).
 *
 * Problema: con muchos MCP activos a la vez (p. ej. 329 herramientas) el prompt completo pesa cientos de KB y escribirlo
 * en el chat bloquea el navegador («la página no responde», sobre todo en Gemini).
 *
 * Solución: si hay MÁS de `threshold` herramientas activas, el prompt NO las lista todas. Solo describe los servidores
 * conectados (nombre, nº de herramientas, páginas) y una herramienta LOCAL del puente —server "wmb", name "list_tools"—
 * con la que la propia IA pide lo que necesita: resumen, páginas de 50, búsqueda por palabras o la firma completa de una.
 * Esa llamada la resuelve la extensión en local (sin tocar ningún MCP, sin permisos, solo lectura).
 * Con pocas herramientas todo sigue exactamente igual que antes (lista completa en el prompt).
 *
 * Se carga DESPUÉS de prompt_builder.js (usa WMB.toolParams) y ANTES de core_bridge.js.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.catalog) return;

  const SERVER = 'wmb';
  const TOOL = 'list_tools';
  const MAX_PAGE = 50;
  /** Ajustes (se pueden sobreescribir con settings.catalogThreshold / settings.catalogPageSize). */
  const cfg = {
    threshold: 40, // más herramientas activas que esto → catálogo paginado
    pageSize: 50, // herramientas por página
    inlineServerMax: 12, // en modo catálogo, los servidores con ≤ N herramientas se siguen listando completos…
    inlineTotalMax: 24, // …mientras sumen como mucho M herramientas
    pageBudget: 9000, // caracteres máximos de una página (si se pasa, se acortan descripciones y parámetros)
  };

  const slugKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const clip = (text, max) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
  };
  const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : 0; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const arg = (o, ...keys) => {
    for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return undefined;
  };
  const paramsOf = (tool) => (typeof WMB.toolParams === 'function' ? WMB.toolParams(tool) : '');

  function groups(tools) {
    const map = new Map();
    for (const t of tools ?? []) {
      if (!map.has(t.server)) map.set(t.server, { slug: t.server, label: t.serverLabel || t.server, tools: [] });
      map.get(t.server).tools.push(t);
    }
    return [...map.values()];
  }

  const pagesOf = (count) => Math.max(1, Math.ceil(count / cfg.pageSize));
  const isActive = (tools) => Array.isArray(tools) && tools.length > cfg.threshold;

  /** Qué servidores se listan completos en el prompt (los pequeños) y cuáles solo por catálogo (los grandes). */
  function split(tools) {
    const all = groups(tools);
    let budget = cfg.inlineTotalMax;
    const inline = new Set();
    for (const g of [...all].sort((a, b) => a.tools.length - b.tools.length)) {
      if (g.tools.length <= cfg.inlineServerMax && g.tools.length <= budget) { inline.add(g.slug); budget -= g.tools.length; }
    }
    return { all, inline };
  }

  /** `get(31), list(22)…`: los prefijos más repetidos orientan a la IA sobre qué buscar. */
  function prefixes(list) {
    const count = new Map();
    for (const t of list) {
      const p = /^[A-Za-z0-9]+/.exec(String(t.name))?.[0]?.toLowerCase();
      if (p) count.set(p, (count.get(p) ?? 0) + 1);
    }
    return [...count].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p}(${n})`).join(', ');
  }

  /** Líneas que sustituyen a la lista completa de herramientas dentro del prompt. */
  function intro(tools, { all, inline }) {
    const big = all.filter((g) => !inline.has(g.slug));
    const lines = [
      `Hay ${tools.length} herramientas en ${all.length} servidor(es): demasiadas para listarlas aquí. Consúltalas por páginas con la herramienta LOCAL del puente (solo lectura, sin permisos):`,
      `{"mcp_call":{"server":"${SERVER}","name":"${TOOL}","arguments":{"server":"<servidor>","page":1}}}`,
      `· Sin arguments: resumen de servidores. \`page\`: páginas de ${cfg.pageSize} (la respuesta indica la siguiente). \`query\`: busca palabras en nombre/descripción (p. ej. "process kill"). \`tool\`: firma completa de una herramienta.`,
      '· Pasa de página o busca hasta hallar la que necesitas y llámala con su servidor REAL. Si ya conoces el nombre exacto, llámala directamente sin listar.',
      '',
    ];
    for (const g of big) {
      const pre = prefixes(g.tools);
      lines.push(`- \`${g.slug}\`${g.label && g.label !== g.slug ? ` (${g.label})` : ''}: ${g.tools.length} herramientas · ${pagesOf(g.tools.length)} página(s)${pre ? ` · prefijos: ${pre}` : ''}`);
    }
    if (inline.size) lines.push('', 'Servidores pequeños (listados completos):');
    return lines;
  }

  /** Recordatorio de una línea para el modo catálogo. */
  function reminder(tools, mode = 'user') {
    const servers = [...new Set(tools.map((t) => t.server))].join(', ');
    const find = `para verlas usa server "${SERVER}", name "${TOOL}" (arguments: server + page, o query)`;
    const use = 'responde SOLO con el bloque {"mcp_call":{"server":"…","name":"…","arguments":{…}}}';
    return mode === 'result'
      ? `[WMB] Sigues teniendo tus herramientas MCP locales (${servers}: ${tools.length}); ${find}. Continúa la tarea: si necesitas otra, ${use}; si ya terminaste, responde en texto.`
      : `[WMB] Tienes herramientas MCP locales reales (${servers}: ${tools.length}); ${find}; para usarlas ${use}.`;
  }

  // ───────────── La herramienta local `wmb.list_tools` ─────────────

  /** Definición para el parser tolerante (WMB.tools): así una llamada mal formada a list_tools también se rescata. */
  const metaTools = [{
    server: SERVER,
    serverLabel: 'Puente',
    name: TOOL,
    description: 'Lista por páginas, busca o detalla las herramientas de los MCP activos.',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string' }, page: { type: 'number' }, query: { type: 'string' }, tool: { type: 'string' }, limit: { type: 'number' } },
    },
  }];

  /** ¿La llamada va dirigida a la herramienta local del puente? */
  function isMeta(call, tools = [], servers = []) {
    if (!call) return false;
    if (servers.some((s) => s.slug === SERVER)) return false; // un MCP real llamado «wmb» manda
    if (slugKey(call.server) === SERVER) return true;
    return !call.server && call.name === TOOL && !tools.some((t) => t.name === TOOL);
  }

  function line(t, withServer, descMax, paramMax) {
    const params = clip(paramsOf(t), paramMax);
    const description = clip(t.description, descMax);
    return `- ${withServer ? `[${t.server}] ` : ''}${t.name}(${params})${description ? `: ${description}` : ''}`;
  }

  /** Dibuja una página; si pesa demasiado acorta descripciones y parámetros (el detalle completo se pide con `tool`). */
  function render(slice, withServer) {
    let lines = slice.map((t) => line(t, withServer, 110, 150));
    if (lines.join('\n').length > cfg.pageBudget) lines = slice.map((t) => line(t, withServer, 60, 80));
    return lines;
  }

  const next = (server, page, limit, extra = {}) => {
    const a = { ...(server ? { server } : {}), ...extra, page };
    if (limit !== cfg.pageSize) a.limit = limit;
    return `arguments ${JSON.stringify(a)}`;
  };

  function overview(all) {
    const lines = [`[WMB · list_tools] ${all.reduce((n, g) => n + g.tools.length, 0)} herramientas en ${all.length} servidor(es) (páginas de ${cfg.pageSize}):`];
    for (const g of all) {
      const pre = prefixes(g.tools);
      lines.push(`- ${g.slug}${g.label && g.label !== g.slug ? ` (${g.label})` : ''}: ${g.tools.length} herramientas · páginas 1-${pagesOf(g.tools.length)}${pre ? ` · prefijos: ${pre}` : ''}`);
    }
    lines.push('Siguiente paso: pide una página (arguments {"server":"<slug>","page":1}) o busca (arguments {"query":"palabras"}).');
    return { ok: true, text: lines.join('\n') };
  }

  function pageOf(g, page, limit) {
    const total = g.tools.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    if (page > pages) return { ok: false, text: `La página ${page} no existe: «${g.slug}» tiene ${pages} página(s) de ${limit} (${total} herramientas).` };
    const from = (page - 1) * limit;
    const slice = g.tools.slice(from, from + limit);
    const lines = [`### \`${g.slug}\` · página ${page}/${pages} · herramientas ${from + 1}-${from + slice.length} de ${total}`, ...render(slice, false)];
    lines.push(page < pages ? `Siguiente: ${next(g.slug, page + 1, limit)}` : 'Fin de la lista de este servidor.');
    lines.push(`Detalle de una: arguments {"server":"${g.slug}","tool":"<nombre>"} · Para usarla, llámala con server "${g.slug}".`);
    return { ok: true, text: lines.join('\n') };
  }

  const words = (q) => String(q).toLowerCase().split(/[\s_\-.,;:/\\]+/).filter(Boolean);

  function search(scope, query, page, limit) {
    const tokens = words(query);
    if (!tokens.length) return { ok: false, text: 'La búsqueda está vacía: escribe una o más palabras (p. ej. "process kill").' };
    const scored = [];
    for (const g of scope) {
      for (const t of g.tools) {
        const name = `${t.name} ${String(t.name).replace(/[_\-.]+/g, ' ')}`.toLowerCase();
        const hay = `${name} ${String(t.description ?? '').toLowerCase()}`;
        if (!tokens.every((w) => hay.includes(w))) continue;
        scored.push({ t, rank: tokens.every((w) => name.includes(w)) ? 0 : 1 });
      }
    }
    scored.sort((a, b) => a.rank - b.rank); // estable: dentro de cada grupo conserva el orden del servidor
    const withServer = scope.length > 1;
    const where = scope.length === 1 ? ` en \`${scope[0].slug}\`` : '';
    if (!scored.length) {
      return { ok: true, text: `Búsqueda «${query}»${where}: 0 resultados. Prueba con menos palabras o sinónimos (inglés/español), o pagina el servidor con arguments {"server":"<slug>","page":1}.` };
    }
    const pages = Math.max(1, Math.ceil(scored.length / limit));
    if (page > pages) return { ok: false, text: `La página ${page} no existe: la búsqueda «${query}» tiene ${pages} página(s) de ${limit} (${scored.length} resultados).` };
    const from = (page - 1) * limit;
    const slice = scored.slice(from, from + limit).map((s) => s.t);
    const lines = [`### Búsqueda «${query}»${where} · ${scored.length} resultado(s) · página ${page}/${pages}`, ...render(slice, withServer)];
    lines.push(page < pages ? `Siguiente: ${next(scope.length === 1 ? scope[0].slug : null, page + 1, limit, { query })}` : 'Fin de los resultados.');
    return { ok: true, text: lines.join('\n') };
  }

  function detail(scope, name) {
    const wanted = name.toLowerCase();
    const found = [];
    for (const g of scope) for (const t of g.tools) if (String(t.name).toLowerCase() === wanted) found.push(t);
    if (!found.length) {
      const near = [];
      for (const g of scope) for (const t of g.tools) if (String(t.name).toLowerCase().includes(wanted)) near.push(t.name);
      return { ok: false, text: `No existe la herramienta «${name}»${scope.length === 1 ? ` en «${scope[0].slug}»` : ''}.${near.length ? ` Parecidas: ${near.slice(0, 12).join(', ')}.` : ' Usa `query` para buscarla.'}` };
    }
    const out = [];
    for (const t of found) {
      const schema = t.inputSchema ?? {};
      out.push(`### \`${t.server}\` › ${t.name}`, `firma: ${t.name}(${paramsOf(t)})`);
      const description = clip(t.description, 1500);
      if (description) out.push(`descripción: ${description}`);
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        const d = clip(prop?.description, 300);
        if (d) out.push(`  · ${key}: ${d}`);
      }
    }
    return { ok: true, text: out.join('\n') };
  }

  /**
   * Resuelve una llamada a `wmb.list_tools`.
   * @returns {{ok:boolean,text:string}}
   */
  function run(rawArgs, tools) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const all = groups(tools);
    if (!all.length) return { ok: false, text: 'No hay herramientas activas en este momento.' };

    const serverArg = arg(args, 'server', 'servidor', 'mcp');
    const query = String(arg(args, 'query', 'q', 'search', 'buscar') ?? '').trim();
    const toolName = String(arg(args, 'tool', 'tool_name', 'herramienta') ?? '').trim();
    const limit = clamp(int(arg(args, 'limit', 'page_size', 'size')) || cfg.pageSize, 1, MAX_PAGE);
    const page = Math.max(1, int(arg(args, 'page', 'pagina', 'p')) || 1);

    let scope = all;
    if (serverArg !== undefined) {
      const want = slugKey(serverArg);
      const g = all.find((x) => x.slug === serverArg || slugKey(x.slug) === want || slugKey(x.label) === want);
      if (!g) return { ok: false, text: `No existe el servidor «${serverArg}». Servidores activos: ${all.map((x) => x.slug).join(', ')}.` };
      scope = [g];
    } else if (all.length === 1) {
      scope = all;
    }

    if (toolName) return detail(scope, toolName);
    if (query) return search(scope, query, page, limit);
    if (scope.length === 1 && (serverArg !== undefined || all.length === 1)) return pageOf(scope[0], page, limit);
    const res = overview(all);
    if (arg(args, 'page', 'pagina', 'p') !== undefined) res.text += '\nIndica también `server` para paginar un servidor concreto.';
    return res;
  }

  /** Texto para «Disponibles: …» cuando la IA llama a una herramienta que no existe: no vuelca cientos de nombres. */
  function unknownToolHint(tools, serverSlug, name) {
    const mine = (tools ?? []).filter((t) => t.server === serverSlug);
    if (mine.length <= 30) return mine.map((t) => t.name).join(', ') || 'ninguna';
    const tokens = words(name);
    const near = mine.filter((t) => tokens.some((w) => String(t.name).toLowerCase().includes(w))).slice(0, 10).map((t) => t.name);
    return `${mine.length} herramientas (demasiadas para listarlas)${near.length ? `; parecidas: ${near.join(', ')}` : ''}. Consúltalas con server "${SERVER}", name "${TOOL}", arguments {"server":"${serverSlug}","query":"<palabras>"}`;
  }

  function configure(settings) {
    if (!settings) return;
    const th = Number(settings.catalogThreshold);
    if (settings.catalogThreshold !== undefined && Number.isFinite(th)) cfg.threshold = Math.max(0, Math.floor(th));
    const ps = Number(settings.catalogPageSize);
    if (settings.catalogPageSize !== undefined && Number.isFinite(ps) && ps >= 1) cfg.pageSize = clamp(Math.floor(ps), 1, MAX_PAGE);
  }

  WMB.catalog = { SERVER, TOOL, cfg, metaTools, isActive, split, intro, reminder, isMeta, run, unknownToolHint, configure, groups };
})();
