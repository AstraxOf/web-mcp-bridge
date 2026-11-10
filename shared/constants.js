/**
 * constants.js - Shared constants between the service worker and the popup.
 * (Content scripts are not modules; they receive these values via messages.)
 */

/** Maximum number of active MCP servers at once. */
export const MAX_ACTIVE_SERVERS = 5;

/** Recommended number of active servers (more = more context tokens). */
export const RECOMMENDED_ACTIVE_SERVERS = 1;

export const STORAGE_KEYS = {
  servers: 'wmb_servers',
  settings: 'wmb_settings',
  history: 'wmb_history',
  dismissed: 'wmb_dismissed',
  notices: 'wmb_notices',
  bridge: 'wmb_bridge',
};

/** Keys from earlier versions that get cleared on their own (v1.4: the auto-update system was removed). */
export const LEGACY_STORAGE_KEYS = ['wmb_update'];

/** Per-MCP permissions: allow = never asks - ask = asks on every call - deny = blocked. */
export const PERMISSIONS = ['allow', 'ask', 'deny'];
export const PERMISSION_LABELS = { allow: 'Always allow', ask: 'Always ask', deny: 'Do not allow' };

export const DEFAULT_SETTINGS = {
  /** Master switch: if false, no connections and no injection. */
  bridgeEnabled: true,
  /** Adds the tool instructions automatically when you send the first message. */
  autoInject: true,
  /** Permission that new MCPs receive (and what the global selector shows). */
  defaultPermission: 'ask',
  /** Send the result to the chat automatically. */
  autoSend: true,
  /** Max characters of a result inside the message. Anything beyond is attached IN FULL as a file (never trimmed). */
  maxResultChars: 12000,
  /** Adds a short line to each message so the AI does not forget it has local tools. */
  reminder: true,
  /** Every N user messages, the full instructions are sent again (0 = never). */
  reinjectEvery: 12,
  /** If the chat will not accept the send while the tab is hidden, bring the tab to the front briefly and switch back. */
  focusFallback: true,
  /** Auto-detect servers from servers.json by asking the bridge (control port). */
  autoDiscover: true,
  /** Also enable the detected servers (up to the maximum). If false, only the first one is enabled when none is active. */
  autoEnableDiscovered: false,
  /** Bridge control port (http://127.0.0.1:PORT/servers). */
  controlPort: 8099,
  /** Show author notices (news, new versions, incidents). Installs nothing: informational only. */
  showNotices: true,
};

/** The test server bundled with the repository (server/examples/demo_mcp_server.py). */
export const DEMO_SERVER = { name: 'demo', url: 'ws://localhost:8090' };

/**
 * Author notices: a public JSON file (notices.json) in the repository. Free, no server of our own.
 * Checked every few hours; nothing is ever downloaded or executed: only text and a link are shown.
 */
export const NOTICES_URL = 'https://raw.githubusercontent.com/ranggaas6/web-mcp-bridge/main/notices.json';
export const NOTICES_EVERY_MS = 10 * 60 * 1000;
export const NOTICES_RETRY_MS = 5 * 60 * 1000;
export const NOTICES_MAX_BYTES = 64 * 1024;
export const NOTICES_MAX_ITEMS = 20;
/** A notice's links may only point to these sites (https). */
export const NOTICE_LINK_HOSTS = ['github.com', 'gist.github.com'];
export const NOTICE_LINK_SUFFIXES = ['.github.io'];

export const PROTOCOL_VERSION = '2025-03-26';
export const CALL_TIMEOUT_MS = 120_000;
export const HISTORY_LIMIT = 50;

export const SUPPORTED_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
  'https://claude.ai/*',
  'https://chat.deepseek.com/*',
];
