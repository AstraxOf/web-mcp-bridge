/**
 * mistral.js — Adaptador para Le Chat de Mistral (chat.mistral.ai, incluida la ruta /work).
 *
 * Los selectores son los habituales de Le Chat (editor ProseMirror, botones con aria-label, partes de mensaje con
 * `data-message-part-type`). No se pudieron comprobar contra la web real desde el entorno de desarrollo (Cloudflare pide
 * verificación), así que cada elemento lleva VARIOS candidatos en orden de prioridad. Si algo falla, ejecuta
 * `tools/diagnostico-dom.js` en la consola de chat.mistral.ai y añade el selector que salga a la lista que corresponda.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class MistralAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'mistral',
        name: 'Le Chat (Mistral)',
        selectors: {
          composer: [
            'div.ProseMirror[contenteditable="true"]',
            '.tiptap[contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"][data-placeholder]',
            'textarea',
          ],
          sendButton: [
            'button[type="submit"][aria-label*="Send" i]',
            'button[type="submit"][aria-label*="Enviar" i]',
            'button[type="submit"][aria-label*="Envoyer" i]',
            'button[aria-label*="Send message" i]',
            'button[aria-label*="Send" i]:not([aria-label*="Stop" i])',
            'button[type="submit"]',
          ],
          assistantMessages: [
            '[data-message-part-type="answer"]',
            '[data-message-author-role="assistant"]',
            '[data-role="assistant"]',
            '[data-testid*="assistant" i]',
            'div[class*="markdown" i]',
          ],
          stopButton: [
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
            'button[aria-label*="Arrêter" i]',
            'button[data-testid*="stop" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chat.mistral.ai';
    }
  }

  WMB.registerAdapter(new MistralAdapter());
})();
