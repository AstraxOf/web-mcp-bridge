/**
 * prompt_builder.js — Genera el System Prompt que se inyecta en el chat.
 * Solo describe las herramientas de los servidores MCP actualmente habilitados.
 * Optimizado en tokens: las herramientas se describen como firmas `nombre(param: tipo)` en lugar de JSON Schema.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const oneLine = (text, max = 400) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  /** Tipo compacto de un JSON Schema: `string`, `"a"|"b"`, `number[]`, `{x: number, y?: number}`… */
  function typeOf(schema) {
    if (!schema || typeof schema !== 'object') return 'any';
    if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join('|');
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    const union = schema.anyOf || schema.oneOf;
    if (Array.isArray(union)) return [...new Set(union.map(typeOf))].join('|');
    if (Array.isArray(schema.type)) return schema.type.join('|');
    if (schema.type === 'array') return `${typeOf(schema.items)}[]`;
    if (schema.type === 'object') return schema.properties ? `{${signature(schema)}}` : 'object';
    if (schema.type) return schema.type;
    const { title, description, ...rest } = schema; // $ref u otros: se conserva el schema compacto
    return Object.keys(rest).length ? JSON.stringify(rest) : 'any';
  }

  /** `a: string, b?: number = 1` */
  function signature(schema) {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {})
      .map(([key, prop]) => `${key}${required.has(key) ? '' : '?'}: ${typeOf(prop)}${prop?.default !== undefined ? ` = ${JSON.stringify(prop.default)}` : ''}`)
      .join(', ');
  }

  /** Parámetros compactos de una herramienta (`a: string, b?: number`); también los usa el catálogo paginado (tool_catalog.js). */
  WMB.toolParams = (tool) => {
    const schema = tool?.inputSchema ?? {};
    return schema.type === 'object' || schema.properties ? signature(schema) : typeOf(schema);
  };

  /** Firma estable de un conjunto de herramientas (para detectar cambios). En modo catálogo cambia, para renovar las instrucciones. */
  WMB.toolsSignature = (tools) => WMB.hash(tools.map((t) => `${t.server}.${t.name}`).sort().join('|') + (WMB.catalog?.isActive(tools) ? '|catalogo' : ''));

  /**
   * Recordatorio de UNA línea (~45 tokens) que se añade a cada mensaje para que la IA no olvide que tiene herramientas locales.
   * @param {{server:string}[]} tools
   * @param {'user'|'result'} mode `result`: tras una herramienta; anima a continuar la tarea.
   */
  WMB.reminderLine = (tools, mode = 'user') => {
    if (WMB.catalog?.isActive(tools)) return WMB.catalog.reminder(tools, mode);
    const servers = [...new Set(tools.map((t) => t.server))].join(', ');
    return WMB.t(mode === 'result' ? 'pr.remind.result' : 'pr.remind.user', { servers, n: tools.length, use: WMB.t('pr.use') });
  };

  /**
   * @param {{server:string,serverLabel:string,name:string,description:string,inputSchema:object}[]} tools
   * @returns {string}
   */
  WMB.buildSystemPrompt = (tools) => {
    // v1.7.2: con muchas herramientas (> umbral) no se listan todas: la IA las consulta por páginas con wmb.list_tools.
    const catalog = WMB.catalog?.isActive(tools) ? WMB.catalog.split(tools) : null;
    const byServer = new Map();
    for (const tool of tools) {
      if (!byServer.has(tool.server)) byServer.set(tool.server, { label: tool.serverLabel, tools: [] });
      byServer.get(tool.server).tools.push(tool);
    }

    const lines = [
      `[WMB:${WMB.toolsSignature(tools)}]`,
      WMB.t('pr.title'),
      WMB.t('pr.intro'),
      '',
      WMB.t('pr.fmtH'),
      WMB.t('pr.fmtP'),
      '```json',
      `{"mcp_call":{"server":"${WMB.t('pr.phServer')}","name":"${WMB.t('pr.phTool')}","arguments":{}}}`,
      '```',
      '',
      WMB.t('pr.rulesH'),
      WMB.t('pr.r1'),
      WMB.t('pr.r2'),
      WMB.t('pr.r3'),
      WMB.t('pr.r4'),
      WMB.t('pr.r5'),
      '',
      WMB.t('pr.toolsH'),
    ];
    if (catalog) lines.push(...WMB.catalog.intro(tools, catalog));

    if (byServer.size === 0) lines.push(WMB.t('pr.noServers'));
    for (const [slug, { label, tools: serverTools }] of byServer) {
      if (catalog && !catalog.inline.has(slug)) continue; // los servidores grandes solo van por catálogo
      lines.push(`### \`${slug}\`${label && label !== slug ? ` (${label})` : ''}`);
      for (const tool of serverTools) {
        const schema = tool.inputSchema ?? {};
        const params = schema.type === 'object' || schema.properties ? signature(schema) : typeOf(schema);
        const description = oneLine(tool.description);
        lines.push(`- ${tool.name}(${params})${description ? `: ${description}` : ''}`);
        for (const [key, prop] of Object.entries(schema.properties ?? {})) {
          const detail = oneLine(prop?.description, 200);
          if (detail) lines.push(`  · ${key}: ${detail}`);
        }
      }
    }
    return lines.join('\n');
  };
})();