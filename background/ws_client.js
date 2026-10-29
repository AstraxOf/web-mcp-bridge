/**
 * ws_client.js — Cliente MCP sobre WebSocket con reconexión automática.
 *
 * Cada instancia de `McpConnection` gestiona UN servidor MCP local:
 *   - Conecta, hace el handshake `initialize` y descarga `tools/list`.
 *   - Reconecta con backoff exponencial si el servidor se cae.
 *   - Mantiene un ping periódico para que el Service Worker MV3 no se duerma
 *     mientras haya conexiones abiertas.
 */
import { PROTOCOL_VERSION } from '../shared/constants.js';

const KEEPALIVE_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class McpConnection {
  #ws = null;
  #pending = new Map();
  #nextId = 1;
  #closedByUser = false;
  #attempt = 0;
  #reconnectTimer = null;
  #keepaliveTimer = null;
  #ready = null;
  #resolveReady = null;

  /**
   * @param {{id:string,name:string,url:string}} server
   * @param {(evt:{kind:'status'|'tools',prev?:string,next?:string}) => void} onChange
   */
  constructor(server, onChange = () => {}) {
    this.server = server;
    this.onChange = onChange;
    this.status = 'disconnected'; // connecting | connected | disconnected | error
    this.tools = [];
    this.serverInfo = null;
    this.lastError = null;
    this.#resetReady();
  }

  // ───────────────────────── API pública ─────────────────────────

  connect() {
    this.#closedByUser = false;
    clearTimeout(this.#reconnectTimer);
    const state = this.#ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    this.#setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.server.url);
    } catch (err) {
      this.lastError = err.message;
      this.#setStatus('error');
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.#handshake().catch((err) => {
        this.lastError = err.message;
        this.#setStatus('error');
        ws.close();
      });
    };
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onerror = () => {
      this.lastError = 'No se pudo conectar con el servidor MCP.';
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#teardown();
      if (!this.#closedByUser) {
        this.#setStatus('disconnected');
        this.#scheduleReconnect();
      }
    };
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    const ws = this.#ws;
    this.#ws = null;
    try { ws?.close(); } catch { /* noop */ }
    this.#teardown();
    this.#setStatus('disconnected');
  }

  /** Espera a que la conexión esté lista (handshake + tools/list). */
  whenReady(timeoutMs = 4000) {
    if (this.status === 'connected') return Promise.resolve(true);
    return Promise.race([
      this.#ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  /** Envía una petición JSON-RPC y espera la respuesta. */
  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Servidor MCP desconectado.'));
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Tiempo de espera agotado en «${method}».`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method, params) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
    }
  }

  callTool(name, args, timeoutMs) {
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
  }

  async refreshTools() {
    const tools = [];
    let cursor;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
    } while (cursor);
    this.tools = tools;
    this.onChange({ kind: 'tools' });
  }

  // ───────────────────────── Internos ─────────────────────────

  async #handshake() {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'web-mcp-bridge', version: '1.2.0' },
    });
    this.serverInfo = init?.serverInfo ?? null;
    this.notify('notifications/initialized');
    await this.refreshTools();

    this.lastError = null;
    this.#attempt = 0;
    this.#setStatus('connected');
    this.#resolveReady();
    this.#startKeepalive();
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Respuesta a una petición nuestra
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'Error MCP'));
      else pending.resolve(msg.result);
      return;
    }

    // Notificaciones / peticiones del servidor
    if (msg.method === 'notifications/tools/list_changed') {
      this.refreshTools().catch(() => {});
    } else if (msg.method && msg.id !== undefined) {
      const result = msg.method === 'ping' ? { result: {} }
        : { error: { code: -32601, message: 'Método no soportado por Web MCP Bridge' } };
      this.#ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...result }));
    }
  }

  #teardown() {
    clearInterval(this.#keepaliveTimer);
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('Conexión cerrada.'));
    }
    this.#pending.clear();
    this.tools = [];
    if (this.status === 'connected') this.#resetReady();
  }

  #resetReady() {
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
  }

  #startKeepalive() {
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = setInterval(() => {
      // Sin respuesta al ping la conexión está «zombi» (suspensión del equipo, red…): se cierra para que reconecte sola.
      this.request('ping', {}, 8000).catch(() => { try { this.#ws?.close(); } catch { /* noop */ } });
    }, KEEPALIVE_MS);
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#attempt) + Math.random() * 500;
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #setStatus(next) {
    const prev = this.status;
    this.status = next;
    if (prev !== next) this.onChange({ kind: 'status', prev, next });
  }
}
