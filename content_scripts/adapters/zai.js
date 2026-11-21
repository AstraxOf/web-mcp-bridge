/**
 * zai.js — Adaptador para Z.ai (chat.z.ai, GLM).
 *
 * Selectores tomados de la página real (HTML guardado):
 *   - Cuadro de texto: <textarea id="chat-input"> (normal, no contenteditable).
 *   - Botón de enviar: <button id="send-message-button" aria-label="Send Message">.
 *   - Respuestas: <div class="chat-assistant"> con el texto en #response-content-container / .chat-markdown.
 *   - El chat se abre en /c/<id>.
 *
 * Si Z.ai cambia su interfaz, normalmente solo hay que añadir un selector a la lista correspondiente.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class ZaiAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'zai',
        name: 'Z.ai',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea[data-slot="textarea-control"]',
            'textarea[placeholder*="Message" i]',
            'textarea[placeholder*="Mensaje" i]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea',
          ],
          sendButton: [
            'button#send-message-button',
            'button[aria-label="Send Message"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'button[type="submit"]',
          ],
          assistantMessages: [
            '.chat-assistant',
            '.chat-assistant #response-content-container',
            '#response-content-container',
            '.chat-markdown',
          ],
          stopButton: [
            'button#stop-message-button',
            'button[id*="stop" i]',
            'button[aria-label="Stop"]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
            'button[aria-label*="Parar" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'z.ai' || hostname.endsWith('.z.ai');
    }

    /** Evita duplicados cuando un selector amplio devuelve un contenedor y su hijo. */
    getAssistantMessages() {
      const list = super.getAssistantMessages();
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }
  }

  WMB.registerAdapter(new ZaiAdapter());
})();
