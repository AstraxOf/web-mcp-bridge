/**
 * webllm.js — Adaptador para WebLLM Chat (chat.webllm.ai): modelos que se ejecutan en el propio navegador (sin cuenta).
 *
 * La interfaz es un derivado de NextChat (Next.js): cuadro `textarea#chat-input`, botón «enviar» que es un `div[role=button]`
 * con un icono, respuestas en `.markdown-body`. Las clases llevan sufijos generados por CSS Modules, por eso se busca por
 * fragmento de nombre (`[class*=...]`). No se pudo comprobar contra la web real desde el entorno de desarrollo: cada elemento
 * lleva varios candidatos. Si algo falla, ejecuta `tools/diagnostico-dom.js` en la consola y añade el selector que salga.
 *
 * Los modelos locales son pequeños y con poco contexto: usa pocos MCP activos a la vez.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class WebLlmAdapter extends WMB.BaseAdapter {
    /** Los modelos locales suelen no ver imágenes: las capturas de herramientas no se adjuntan. */
    acceptsImages = false;

    constructor() {
      super({
        id: 'webllm',
        name: 'WebLLM Chat',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea[class*="chat-input" i]',
            'textarea[placeholder]',
            'textarea',
          ],
          sendButton: [
            '[class*="chat-input-send" i]',
            'div[role="button"][class*="send" i]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'button[type="submit"]',
          ],
          assistantMessages: [
            '[class*="chat-message" i]:not([class*="user" i]) .markdown-body',
            '[class*="chat-message-item" i] .markdown-body',
            '.markdown-body',
          ],
          stopButton: [
            '[class*="chat-input-stop" i]',
            'div[role="button"][title*="Stop" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chat.webllm.ai';
    }

    /** Solo respuestas del asistente: el mensaje del usuario también usa `.markdown-body` y llevaría ejemplos de `mcp_call`. */
    getAssistantMessages() {
      const USER = /chat-message-user|message-user|user-message/i;
      return super.getAssistantMessages().filter((el) => {
        for (let node = el, depth = 0; node && node !== document.body && depth < 8; node = node.parentElement, depth += 1) {
          if (typeof node.className === 'string' && USER.test(node.className)) return false;
        }
        return true;
      });
    }
  }

  WMB.registerAdapter(new WebLlmAdapter());
})();
