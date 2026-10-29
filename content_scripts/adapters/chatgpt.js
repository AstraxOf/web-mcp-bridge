/**
 * chatgpt.js — Adaptador para ChatGPT (chatgpt.com).
 *
 * Si OpenAI cambia su interfaz, normalmente solo hay que añadir un selector
 * a la lista correspondiente (los primeros tienen prioridad).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class ChatGPTAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'chatgpt',
        name: 'ChatGPT',
        selectors: {
          composer: [
            '#prompt-textarea',
            'div.ProseMirror[contenteditable="true"]',
            'form div[contenteditable="true"]',
            'textarea[data-id="root"]',
            'form textarea',
          ],
          sendButton: [
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'form button[type="submit"]',
          ],
          assistantMessages: [
            '[data-message-author-role="assistant"]',
            '[data-turn="assistant"]',
            'article [data-message-author-role="assistant"]',
            'div.agent-turn',
          ],
          // Solo el botón de «detener generación» (no el de dictado). Si quedara «pegado», base_adapter lo detecta por texto estable.
          stopButton: [
            'button[data-testid="stop-button"]',
            'button[aria-label*="Stop streaming" i]',
            'button[aria-label*="Stop generating" i]',
            'button[aria-label*="Detener la transm" i]',
            'button[aria-label*="Detener generaci" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com');
    }
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();
