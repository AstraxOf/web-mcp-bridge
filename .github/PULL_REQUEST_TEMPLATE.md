## Summary / Resumen

<!-- What does this PR change and why? Link the issue if there is one: Closes #123 -->
<!-- ¿Qué cambia este PR y por qué? Enlaza el issue si existe: Closes #123 -->

## Type of change / Tipo de cambio

- [ ] 🐛 Fix (bug or broken selector) / Corrección (error o selector roto)
- [ ] 🔌 New adapter / Nuevo adaptador: `<platform>`
- [ ] ✨ New feature / Nueva funcionalidad
- [ ] 🔒 Security improvement / Mejora de seguridad
- [ ] 📝 Documentation / Documentación
- [ ] ♻️ Refactor / Tests / CI

## Affected area / Área afectada

- [ ] Extension (`background/`, `content_scripts/`, `popup/`, `welcome/`)
- [ ] Adapter (`content_scripts/adapters/`)
- [ ] Python bridge / launcher (`server/`)
- [ ] `manifest.json` (permissions or `host_permissions`) / (permisos o `host_permissions`)
- [ ] Docs, CI or scripts

## How was it tested? / ¿Cómo se probó?

<!-- Describe what you ran and on which platform/browser. -->
<!-- Describe qué ejecutaste y en qué plataforma/navegador. -->

- OS / SO:
- Browser / Navegador (version):
- Platform tested / Plataforma probada: ChatGPT / Gemini / Claude / DeepSeek / n/a

## Checklist

- [ ] `npm test` passes locally / pasa en local
- [ ] Full cycle verified for adapter changes: inject instructions → call → approval → result sent back / Ciclo completo verificado en cambios de adaptadores
- [ ] No new dependencies in the extension (browser APIs only) / Sin dependencias nuevas en la extensión
- [ ] No `eval`, no `innerHTML` with page data, no external network requests / Sin `eval`, sin `innerHTML` con datos de la página, sin peticiones externas
- [ ] Code and comments follow the project style (small, documented modules) / Código y comentarios según el estilo del proyecto
- [ ] New or changed behavior is covered by tests when applicable / Comportamiento nuevo o modificado cubierto por tests si aplica
- [ ] Docs updated if needed (`README.md`, `README.es.md`, `CONTRIBUTING.md`) / Documentación actualizada si hace falta
- [ ] Any change to `manifest.json` permissions is justified below / Todo cambio de permisos en `manifest.json` está justificado abajo

## Security considerations / Consideraciones de seguridad

<!-- Does this touch permissions, Origin/Host checks, token handling, tool approval or MCP_RESULT framing? Explain, or write "None". -->
<!-- ¿Toca permisos, comprobaciones de Origin/Host, token, aprobación de herramientas o el marco MCP_RESULT? Explica, o escribe "Ninguna". -->

## Screenshots or logs (optional) / Capturas o logs (opcional)

<!-- Useful for popup/UI changes or bridge output. -->