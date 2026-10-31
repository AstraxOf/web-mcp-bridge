/**
 * constants.js — Constantes compartidas entre el service worker y el popup.
 * (Los content scripts no son módulos; reciben estos valores vía mensajes.)
 */

/** Máximo de servidores MCP activos a la vez. */
export const MAX_ACTIVE_SERVERS = 5;

/** Número recomendado de servidores activos (más = más tokens de contexto). */
export const RECOMMENDED_ACTIVE_SERVERS = 1;

export const STORAGE_KEYS = {
  servers: 'wmb_servers',
  settings: 'wmb_settings',
  history: 'wmb_history',
};

/** Permisos por MCP: allow = nunca pregunta · ask = pregunta en cada llamada · deny = bloqueado. */
export const PERMISSIONS = ['allow', 'ask', 'deny'];
export const PERMISSION_LABELS = { allow: 'Permitir siempre', ask: 'Preguntar siempre', deny: 'No permitir' };

export const DEFAULT_SETTINGS = {
  /** Interruptor general: si está en false no hay conexiones ni inyección. */
  bridgeEnabled: true,
  /** Añade las instrucciones de las herramientas automáticamente al enviar el primer mensaje. */
  autoInject: true,
  /** Permiso que reciben los MCP nuevos (y el que muestra el selector global). */
  defaultPermission: 'ask',
  /** Enviar automáticamente el resultado al chat. */
  autoSend: true,
  /** Máximo de caracteres de un resultado dentro del mensaje. Lo que lo supere se adjunta COMPLETO como archivo (nunca se recorta). */
  maxResultChars: 12000,
  /** Añade una línea corta a cada mensaje para que la IA no olvide que tiene herramientas locales. */
  reminder: true,
  /** Cada N mensajes del usuario se vuelven a enviar las instrucciones completas (0 = nunca). */
  reinjectEvery: 12,
  /** Si el chat no acepta el envío con la pestaña oculta, trae la pestaña al frente un instante y vuelve a la anterior. */
  focusFallback: true,
};

/** El servidor de prueba incluido en el repositorio (server/examples/demo_mcp_server.py). */
export const DEMO_SERVER = { name: 'demo', url: 'ws://localhost:8090' };

export const PROTOCOL_VERSION = '2025-03-26';
export const CALL_TIMEOUT_MS = 120_000;
export const HISTORY_LIMIT = 50;

export const SUPPORTED_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
  'https://claude.ai/*',
  'https://chat.deepseek.com/*',
];