/**
 * gemini.js — Adaptador para Google Gemini (gemini.google.com).
 * El editor es Quill (`.ql-editor`) dentro del componente <rich-textarea>.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class GeminiAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'gemini',
        name: 'Gemini',
        selectors: {
          composer: [
            'rich-textarea .ql-editor[contenteditable="true"]',
            'div.ql-editor[contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            'button.send-button:not(.stop)',
            'button[aria-label*="Send message" i]',
            'button[aria-label*="Enviar mensaje" i]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
          ],
          assistantMessages: [
            'model-response message-content',
            'model-response',
            'message-content',
            '.model-response-text',
          ],
          stopButton: [
            'button.send-button.stop',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
            'button[aria-label*="Parar" i]',
          ],
        },
      });
    }

    matches(hostname) {
      return hostname === 'gemini.google.com';
    }
  }

  WMB.registerAdapter(new GeminiAdapter());
})();
