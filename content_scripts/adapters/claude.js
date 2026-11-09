/**
 * claude.js - Adapter for Claude Web (claude.ai).
 * The editor is ProseMirror (contenteditable).
 *
 * Note: the Spanish-language aria-labels are real DOM selectors for Claude's
 * Spanish UI, not user-facing strings. Keep them as-is.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class ClaudeAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'claude',
        name: 'Claude',
        selectors: {
          composer: [
            'div[contenteditable="true"].ProseMirror',
            '[data-testid="chat-input"]',
            'fieldset div[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
          ],
          sendButton: [
            'button[aria-label="Send message"]',
            'button[aria-label="Enviar mensaje"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
          ],
          assistantMessages: [
            '.font-claude-response',
            '.font-claude-message',
            '[data-testid="assistant-message"]',
            'div[data-is-streaming]',
          ],
          stopButton: [
            'button[aria-label="Stop response"]',
            'button[aria-label="Detener respuesta"]',
            'button[aria-label*="Stop" i]',
            'div[data-is-streaming="true"]',
          ],
        },
      });
    }

    matches(hostname) {
      return hostname === 'claude.ai';
    }
  }

  WMB.registerAdapter(new ClaudeAdapter());
})();
