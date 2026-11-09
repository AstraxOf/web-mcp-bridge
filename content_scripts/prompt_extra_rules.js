/**
 * prompt_extra_rules.js — Reglas adicionales para cargas grandes.
 * Se carga DESPUES de prompt_builder.js y envuelve WMB.buildSystemPrompt
 * para anadir reglas de chunking y anti-duplicado sin tocar el archivo original.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.extraRulesInstalled) return;
  WMB.extraRulesInstalled = true;

  WMB.EXTRA_RULES = [
    '',
    '## Reglas para cargas grandes (archivos de codigo)',
    '6. NUNCA incrustes en mcp_call el contenido completo de un archivo de mas de 150 lineas: el JSON se corta por limite de tokens y la llamada falla con status="format_error".',
    '7. Para archivos grandes, divide el contenido en bloques de <= 150 lineas y llama a create_or_update_file una vez por bloque (misma rama, mismo path), en orden, esperando el resultado de cada llamada antes de enviar la siguiente.',
    '8. Para los bloques 2 y siguientes, vuelve a leer el archivo con get_file_contents para obtener el sha actualizado antes de cada create_or_update_file.',
    '9. Si existe una herramienta de staging (stage_file / flush_staged_file), usala en lugar de incrustar contenido grande en un unico JSON.',
    '10. No repitas una llamada identica que ya devolvio status="ok": usa el resultado anterior. Si necesitas reejecutar, cambia los argumentos o explica por que.',
  ];

  const orig = WMB.buildSystemPrompt;
  if (typeof orig !== 'function') return;
  WMB.buildSystemPrompt = (tools) => {
    const base = orig(tools);
    const marker = '\n## Herramientas';
    const i = base.indexOf(marker);
    if (i === -1) return base + '\n' + WMB.EXTRA_RULES.join('\n');
    return base.slice(0, i) + '\n' + WMB.EXTRA_RULES.join('\n') + base.slice(i);
  };
})();
