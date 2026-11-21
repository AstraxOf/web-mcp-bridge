/**
 * qwen.js — Adaptador para Qwen Chat (chat.qwen.ai).
 *
 * El cuadro de texto es un <textarea id="chat-input"> y el botón de enviar suele ser #send-message-button.
 * Las respuestas del asistente usan clases tipo `qwen-chat-message-assistant` / `response-message-content`.
 *
 * OJO: estos selectores salen del conocimiento general de la interfaz de Qwen (no de una captura de tu navegador),
 * por eso hay varios candidatos y fallbacks amplios. Si algo no funciona, basta con ajustar la lista correspondiente.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class QwenAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'qwen',
        name: 'Qwen',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea.chat-input',
            'textarea[placeholder*="Qwen" i]',
            'textarea[placeholder*="help" i]',
            'textarea[placeholder*="Message" i]',
            'textarea[placeholder*="Mensaje" i]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea',
          ],
          sendButton: [
            'button#send-message-button',
            'button[aria-label="Send message"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'button.send-button',
            'button[type="submit"]',
          ],
          assistantMessages: [
            '.qwen-chat-message-assistant .response-message-content',
            '.qwen-chat-message-assistant',
            '.response-message-content',
            '.chat-response-message',
            '[class*="assistant" i] .markdown-content-container',
            '.qwen-markdown',
          ],
          stopButton: [
            'button#stop-message-button',
            'button.stop-button',
            'button[class*="stop" i]',
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
      return hostname === 'chat.qwen.ai' || hostname === 'qwen.ai' || hostname.endsWith('.qwen.ai');
    }

    /** Evita duplicados cuando un selector amplio devuelve un contenedor y su hijo. */
    getAssistantMessages() {
      const list = super.getAssistantMessages();
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }
  }

  WMB.registerAdapter(new QwenAdapter());
})();
