/**
 * kimi.js — Adaptador para Kimi (www.kimi.com / kimi.moonshot.cn).
 *
 * El editor es un contenteditable (Lexical): `.chat-input-editor[contenteditable="true"]`.
 * El botón de enviar es un <div class="send-button-container"> (no un <button>), y durante la generación
 * ese mismo contenedor cambia a «detener» (clase `stop`), por eso aquí se envía con Enter y el botón
 * solo se pulsa si no se está generando (si no, un clic CANCELARÍA la respuesta).
 * Las respuestas del asistente van en `.segment-assistant` con el texto en `.markdown`.
 *
 * OJO: estos selectores salen del conocimiento general de la interfaz de Kimi (no de una captura de tu navegador),
 * por eso hay varios candidatos y fallbacks amplios. Si algo no funciona, basta con ajustar la lista correspondiente.
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
            '.chat-input-editor[contenteditable="true"]',
            'div[data-lexical-editor="true"][contenteditable="true"]',
            '.chat-input div[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            '.send-button-container:not(.stop)',
            '.send-button-container',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'button[type="submit"]',
          ],
          assistantMessages: [
            '.segment-assistant .markdown',
            '.segment-assistant .markdown-container',
            '.segment-assistant',
            '.chat-content-item-assistant',
            '.markdown-container',
          ],
          stopButton: [
            '.send-button-container.stop',
            '[class*="stop-button" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
            'button[aria-label*="停止"]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'kimi.com' || hostname.endsWith('.kimi.com')
        || hostname === 'kimi.moonshot.cn' || hostname === 'kimi.ai' || hostname.endsWith('.kimi.ai');
    }

    /** Evita duplicados cuando un selector amplio devuelve un contenedor y su hijo. */
    getAssistantMessages() {
      const list = super.getAssistantMessages();
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }

    /**
     * Envía con Enter (durante una generación no hace nada, así que es seguro) y solo si no sale pulsa el botón.
     * Solo cuenta como enviado si el texto SALIÓ del cuadro.
     */
    async submit(timeout = 4000) {
      const composer = this.getComposer();
      if (!composer) return false;
      const hasText = () => WMB.dom.getText(composer).trim().length > 0;
      if (!hasText()) return true;

      if (this.isStreaming()) {
        const idle = await WMB.waitFor(() => !this.isStreaming(), { timeout, interval: 200 });
        if (!idle) return false;
      }
      const gone = () => !hasText();

      composer.focus();
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keypress', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;

      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !b.classList.contains('disabled') ? b : null;
      }, { timeout, interval: 150 });
      if (button && hasText() && !this.isStreaming()) {
        button.click();
        if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;
      }
      return !hasText();
    }
  }

  WMB.registerAdapter(new KimiAdapter());
})();
