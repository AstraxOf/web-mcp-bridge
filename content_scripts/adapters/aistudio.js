/**
 * aistudio.js — Adaptador para Google AI Studio (aistudio.google.com).
 *
 * AI Studio es una aplicación Angular con componentes propios (`ms-*`): cuadro de texto dentro de `ms-prompt-box`, botón «Run» (que
 * pasa a «Stop» mientras genera), un `ms-chat-turn` por turno y las respuestas en `ms-text-chunk` / `ms-cmark-node`. El razonamiento
 * («Thoughts») va en `ms-thought-chunk` y se excluye, igual que los turnos del usuario, para no ejecutar dos veces una llamada
 * escrita en un borrador ni leer los ejemplos del prompt.
 *
 * No se pudo comprobar contra la web real desde el entorno de desarrollo (pide sesión de Google): cada elemento lleva varios
 * candidatos en orden de prioridad. Si algo falla, ejecuta `tools/diagnostico-dom.js` en la consola de AI Studio y añade el selector.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const THOUGHT = 'ms-thought-chunk, [class*="thought" i], [class*="thinking" i]';
  const USER_TURN = /(^|[\s_-])user([\s_-]|$)/i;

  class AiStudioAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'aistudio',
        name: 'Google AI Studio',
        selectors: {
          composer: [
            'ms-prompt-box textarea',
            'ms-autosize-textarea textarea',
            'textarea[aria-label*="Type something" i]',
            'textarea[aria-label*="prompt" i]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea',
          ],
          sendButton: [
            'ms-run-button button:not([disabled])',
            'button.run-button:not([disabled])',
            'button[aria-label="Run"]:not([disabled])',
            'button[aria-label*="Run" i]:not([disabled]):not([aria-label*="settings" i])',
            'button[aria-label*="Send" i]:not([disabled])',
          ],
          assistantMessages: [
            'ms-chat-turn[data-turn-role="Model"] ms-text-chunk',
            'ms-chat-turn .model-prompt-container ms-text-chunk',
            'ms-chat-turn .model ms-text-chunk',
            'ms-text-chunk',
            'ms-cmark-node',
          ],
          // Mientras genera, el botón «Run» pasa a «Stop»: con la interfaz en español puede decir «Detener», «Parar» o «Cancelar».
          stopButton: [
            'ms-run-button button[aria-label*="Stop" i]',
            'ms-run-button button[aria-label*="Detener" i]',
            'ms-run-button button[aria-label*="Parar" i]',
            'ms-run-button button[aria-label*="Cancel" i]',
            'ms-run-button button[class*="stop" i]',
            'ms-run-button button[class*="loading" i]',
            'ms-run-button .stop-icon',
            'button.run-button.stop',
            'button[aria-label="Stop"]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
            'button[aria-label*="Parar" i]',
            'button[class*="stop-button" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'aistudio.google.com';
    }

    /** Solo respuestas del modelo: sin razonamiento y sin los turnos del usuario (que traen ejemplos de `mcp_call`). */
    getAssistantMessages() {
      const all = super.getAssistantMessages().filter((el) => {
        if (el.closest(THOUGHT)) return false;
        const turn = el.closest('ms-chat-turn');
        if (!turn) return true;
        const role = (turn.getAttribute('data-turn-role') || '').toLowerCase();
        if (role) return role === 'model';
        return !USER_TURN.test(typeof turn.className === 'string' ? turn.className : '');
      });
      return all.filter((el) => !all.some((other) => other !== el && el.contains(other))); // el más interno
    }
  }

  WMB.registerAdapter(new AiStudioAdapter());
})();
