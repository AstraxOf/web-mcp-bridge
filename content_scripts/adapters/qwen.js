/**
 * qwen.js — Adaptador para Qwen Chat (chat.qwen.ai).
 *
 * Selectores tomados del código público de la propia app (qwen-chat-fe): cuadro `textarea#chat-input` (clase
 * `message-input-textarea`), botón de enviar/detener dentro de `.message-input-right-button-send` (al generar muestra el icono
 * `icon-stop`) y respuestas renderizadas con la clase `qwen-markdown`. No se pudieron comprobar con una sesión real: cada
 * elemento lleva varios candidatos en orden de prioridad. Si algo falla, ejecuta `tools/diagnostico-dom.js` en la consola de
 * Qwen y añade el selector que salga.
 *
 * Con el modo de pensamiento activado, el razonamiento también se renderiza como Markdown y puede traer un borrador de la
 * llamada `mcp_call`: se excluye para no ejecutarla dos veces.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  /** Clases de razonamiento, solo como palabra completa y en los ancestros cercanos. */
  const THINK_CLASS = /(^|[\s_-])(think|thinking|thought|reasoning|deepthink)([\s_-]|$)/i;
  const THINK_DEPTH = 8;

  class QwenAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'qwen',
        name: 'Qwen Chat',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea.message-input-textarea',
            'textarea[class*="message-input" i]',
            'textarea',
          ],
          sendButton: [
            '.message-input-right-button-send button.send-button:not(.disabled):not([disabled])',
            '.message-input-right-button-send button:not([disabled])',
            'button.send-button:not(.disabled):not([disabled])',
            'button[aria-label*="Send" i]',
          ],
          assistantMessages: [
            '.response-message-content .qwen-markdown',
            '.qwen-markdown',
            '.response-message-content',
          ],
          stopButton: [
            '.message-input-right-button-send [class*="icon-stop" i]',
            '.message-input-right-button-send .stop-button',
            'button[class*="stop" i]',
            'button[aria-label*="Stop" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chat.qwen.ai';
    }

    /** Solo la respuesta (no el razonamiento) y sin bloques Markdown anidados. */
    getAssistantMessages() {
      const all = super.getAssistantMessages().filter((el) => {
        for (let node = el, depth = 0; node && node !== document.body && depth < THINK_DEPTH; node = node.parentElement, depth += 1) {
          const cls = typeof node.className === 'string' ? node.className : '';
          if (cls && THINK_CLASS.test(cls)) return false;
        }
        return true;
      });
      return all.filter((el) => !all.some((other) => other !== el && el.contains(other))); // anidados: se queda el más interno
    }
  }

  WMB.registerAdapter(new QwenAdapter());
})();
