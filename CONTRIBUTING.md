# Contributing to Web MCP Bridge

> [Leer en español](#contribuir-a-web-mcp-bridge)

Thanks for helping out! The most valuable contributions:

1. **Fix selectors** when a website changes its interface (a single line is often enough).
2. **New adapters** (Perplexity, Le Chat, ...).
3. Improvements to the Python bridge and to security.

## Adding a platform

1. Copy `content_scripts/adapters/claude.js` to `content_scripts/adapters/<platform>.js` (`deepseek.js` is another working example).
2. Change `id`, `name`, `matches()` and the selectors (`composer`, `sendButton`, `assistantMessages`, `stopButton`).
   Put the most stable selectors first (`data-testid`, `aria-label`) and keep CSS classes as a last resort.
3. If the site exposes an ID per message, override `getMessageKey(element, index)`.
4. Add a `content_scripts` block to `manifest.json` and the required `host_permissions`.
5. Test the full cycle: inject instructions -> call -> approval -> result sent back.

## Before opening a PR

```bash
npm test
```

- Code and comments in Spanish, small and documented modules.
- No dependencies in the extension (browser APIs only).
- Do not use `eval`, `innerHTML` with page data, or external network requests.

## Reporting problems and questions

Use the issue templates: `selector_roto` (broken selector) when a site changes its interface, and `adaptador_nuevo` (new adapter) to propose a platform. For questions, write in the [Telegram channel](https://t.me/AstraxMCP).

---

# Contribuir a Web MCP Bridge

> [Read in English](#contributing-to-web-mcp-bridge)

¡Gracias por ayudar! Las contribuciones más valiosas:

1. **Arreglar selectores** cuando una web cambia su interfaz (una línea suele bastar).
2. **Nuevos adaptadores** (Perplexity, Le Chat…).
3. Mejoras del puente Python y de la seguridad.

## Añadir una plataforma

1. Copia `content_scripts/adapters/claude.js` a `content_scripts/adapters/<plataforma>.js`.
2. Cambia `id`, `name`, `matches()` y los selectores (`composer`, `sendButton`, `assistantMessages`, `stopButton`).
   Pon primero los selectores más estables (`data-testid`, `aria-label`) y deja las clases CSS como último recurso.
3. Si la web expone un ID por mensaje, sobreescribe `getMessageKey(element, index)`.
4. Añade un bloque `content_scripts` en `manifest.json` y los `host_permissions` necesarios.
5. Prueba el ciclo completo: inyectar instrucciones → llamada → aprobación → resultado enviado.

## Antes de abrir un PR

```bash
npm test
```

- Código y comentarios en español, módulos pequeños y documentados.
- Sin dependencias en la extensión (solo APIs del navegador).
- No uses `eval`, `innerHTML` con datos de la página ni peticiones de red externas.

## Reportar problemas y dudas

Usa las plantillas de issues: `selector_roto` cuando una web cambia su interfaz y `adaptador_nuevo` para proponer una plataforma. Para dudas, escribe en el [canal de Telegram](https://t.me/AstraxMCP).
