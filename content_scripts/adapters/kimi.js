/**
 * kimi.js — Adaptador para Kimi (www.kimi.ai y kimi.com).
 *
 * Kimi usa un editor Lexical (`contenteditable` con `data-lexical-editor`), un botón de enviar que es un `div` (no un `button`)
 * y las respuestas en bloques con clase `markdown` dentro de un segmento «assistant». Los selectores no se pudieron comprobar
 * contra la web real desde el entorno de desarrollo (hace falta sesión): cada elemento lleva varios candidatos en orden de
 * prioridad. Si algo falla, ejecuta `tools/diagnostico-dom.js` en la consola de Kimi y añade el selector que salga.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class KimiAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'kimi',
        name: 'Kimi',
        selectors: {
          composer: [
            'div.chat-input-editor[contenteditable="true"]',
            'div[data-lexical-editor="true"][contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            '.send-button-container:not(.disabled):not(.stop) .send-button',
            '.send-button-container:not(.disabled):not(.stop)',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'div[class*="send-button" i]:not([class*="disabled" i])',
          ],
          assistantMessages: [
            '.segment-assistant .markdown-container',
            '.segment-assistant .markdown',
            '.segment-assistant',
            '[data-role="assistant"]',
            '.chat-content-item-assistant',
            'div.markdown',
          ],
          stopButton: [
            '.send-button-container.stop',
            '.stop-button',
            'div[class*="stop" i][class*="button" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return /(^|\.)kimi\.(ai|com)$/.test(hostname);
    }
  }

  WMB.registerAdapter(new KimiAdapter());
})();
