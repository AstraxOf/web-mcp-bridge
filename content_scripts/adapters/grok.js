/**
 * grok.js — Adaptador para Grok (grok.com / x.com/i/grok).
 * El editor principal es un contenteditable (ProseMirror / TipTap).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class GrokAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'grok',
        name: 'Grok',
        selectors: {
          composer: [
            // Más estables actualmente
            '[data-testid="chat-input"] [contenteditable="true"]',
            '[data-testid="chat-input"] .ProseMirror[contenteditable="true"]',
            '.tiptap.ProseMirror[contenteditable="true"]',
            '.ProseMirror[contenteditable="true"]',
            // Textarea
            'textarea[aria-label="Ask Grok anything"]',
            '[data-testid="chat-input"] textarea',
            // Fallbacks amplios
            'div[contenteditable="true"]',
            '[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"][data-placeholder]',
            'textarea',
          ],
          sendButton: [
            'button[data-testid="chat-submit"]',
            'button[aria-label="Send"]',
            'button[aria-label="Submit"]',
            'button[aria-label="提交"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Submit" i]',
            'button[aria-label*="Enviar" i]',
            'form button[type="submit"]',
            'button[type="submit"]',
          ],
          assistantMessages: [
            '[data-testid="assistant-message"]',
            '[data-testid="assistant-message"] .response-content-markdown',
            '.response-content-markdown',
            '.message-bubble.assistant',
            '[data-testid="grokResponse"]',
            '[class*="assistant"]',
          ],
          stopButton: [
            'button[data-testid="chat-stop"]',
            'button[data-testid="chat-stop-button"]',
            'button[aria-label="Stop"]',
            'button[aria-label="Stop generating"]',
            'button[aria-label="Stop response"]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Detener" i]',
            'button[aria-label*="Parar" i]',
          ],
          fileInput: [
            'input[type="file"]',
            'input[type="file"][name="files"]',
          ],
        },
      });
    }

    matches(hostname) {
      // Más permisivo
      return (
        hostname === 'grok.com' ||
        hostname === 'www.grok.com' ||
        hostname.endsWith('.grok.com') ||
        hostname === 'x.com' ||
        hostname === 'www.x.com' ||
        hostname === 'grok.x.ai'
      );
    }
  }

  WMB.registerAdapter(new GrokAdapter());
})();