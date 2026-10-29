# Contribuir a Web MCP Bridge

¡Gracias por ayudar! Las contribuciones más valiosas:

1. **Arreglar selectores** cuando una web cambia su interfaz (una línea suele bastar).
2. **Nuevos adaptadores** (Perplexity, DeepSeek, Le Chat…).
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
