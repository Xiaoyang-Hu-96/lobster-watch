// ─── OpenClaw Gateway Client ─────────────────────────────────────────────────
// Browser-side WebSocket RPC client for communicating with OpenClaw Gateway
// via the server.js proxy.

class OpenClawGateway {
  constructor() {
    this._ws = null;
    this._requestId = 0;
    this._pending = new Map();       // id → { resolve, reject, timeout }
    this._eventHandlers = new Map(); // event name → Set<callback>
    this._connected = false;
    this._proxyReady = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._url = null;
    this._onStatusChange = null;     // callback(connected, proxyReady)
  }

  // ─── Connection Lifecycle ────────────────────────────────────────────────

  /**
   * Connect to the server.js WebSocket proxy.
   * @param {string} [url] - WebSocket URL, defaults to ws://current-host/ws
   * @returns {Promise<void>} Resolves when proxy connection is ready
   */
  connect(url) {
    this._url = url || `ws://${location.host}/ws`;

    return new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this._url);
      } catch (err) {
        reject(err);
        return;
      }

      const onceReady = (payload) => {
        this._proxyReady = true;
        this._reconnectDelay = 1000; // Reset backoff
        this._notifyStatus();
        resolve();
      };

      // Listen for proxy ready event (gateway connected)
      this.on('_proxy_ready', onceReady);

      this._ws.onopen = () => {
        console.log('[Gateway] WebSocket connected to proxy');
        this._connected = true;
        this._notifyStatus();
      };

      this._ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      this._ws.onclose = (event) => {
        console.log('[Gateway] WebSocket closed:', event.code, event.reason);
        const wasConnected = this._connected;
        this._connected = false;
        this._proxyReady = false;
        this._notifyStatus();

        // Reject all pending requests
        for (const [id, pending] of this._pending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('WebSocket closed'));
        }
        this._pending.clear();

        // Auto-reconnect
        if (wasConnected) {
          this._scheduleReconnect();
        } else {
          reject(new Error('WebSocket connection failed'));
        }
      };

      this._ws.onerror = (err) => {
        console.error('[Gateway] WebSocket error');
      };

      // Timeout for initial connection
      setTimeout(() => {
        if (!this._connected) {
          this._ws.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close(1000, 'Client disconnect');
      this._ws = null;
    }
    this._connected = false;
    this._proxyReady = false;
    this._notifyStatus();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;

    console.log(`[Gateway] Reconnecting in ${this._reconnectDelay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);

      this.connect(this._url).catch((err) => {
        console.error('[Gateway] Reconnect failed:', err.message);
        this._scheduleReconnect();
      });
    }, this._reconnectDelay);
  }

  _notifyStatus() {
    if (this._onStatusChange) {
      this._onStatusChange(this._connected, this._proxyReady);
    }
  }

  /** Set a callback for connection status changes */
  onStatusChange(callback) {
    this._onStatusChange = callback;
  }

  get connected() { return this._connected; }
  get ready() { return this._proxyReady; }

  // ─── Message Handling ────────────────────────────────────────────────────

  _handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch (err) {
      console.error('[Gateway] Invalid JSON:', raw);
      return;
    }

    if (frame.type === 'res') {
      // Route to pending RPC request
      const pending = this._pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this._pending.delete(frame.id);
        if (frame.ok !== false && !frame.error) {
          pending.resolve(frame.payload || frame.result || frame);
        } else {
          pending.reject(new Error(frame.error?.message || frame.error || 'RPC error'));
        }
      }
    } else if (frame.type === 'event') {
      // Route to event handlers
      const handlers = this._eventHandlers.get(frame.event);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(frame.payload, frame);
          } catch (e) {
            console.error(`[Gateway] Event handler error for "${frame.event}":`, e);
          }
        }
      }
    }
  }

  // ─── RPC Request/Response ────────────────────────────────────────────────

  /**
   * Send an RPC request to the Gateway.
   * @param {string} method - RPC method name (e.g., 'sessions.list')
   * @param {object} params - Method parameters
   * @param {number} [timeoutMs=10000] - Request timeout
   * @returns {Promise<any>} Response payload
   */
  request(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      const id = String(++this._requestId);
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timeout });

      this._ws.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      }));
    });
  }

  // ─── Event Subscription ──────────────────────────────────────────────────

  /**
   * Subscribe to a Gateway event.
   * @param {string} eventName - Event name (e.g., 'heartbeat', 'exec.approval.requested')
   * @param {function} callback - Handler function(payload, frame)
   * @returns {function} Unsubscribe function
   */
  on(eventName, callback) {
    if (!this._eventHandlers.has(eventName)) {
      this._eventHandlers.set(eventName, new Set());
    }
    this._eventHandlers.get(eventName).add(callback);

    // Return unsubscribe function
    return () => {
      const handlers = this._eventHandlers.get(eventName);
      if (handlers) {
        handlers.delete(callback);
        if (handlers.size === 0) {
          this._eventHandlers.delete(eventName);
        }
      }
    };
  }

  // ─── High-Level API: Gateway RPC ─────────────────────────────────────────

  /** List all agent sessions */
  async getSessions() {
    return this.request('sessions.list');
  }

  /** Get chat history for a session */
  async getChatHistory(sessionId) {
    return this.request('chat.history', { sessionId });
  }

  /** Send a chat message */
  async sendChat(sessionId, message) {
    return this.request('chat.send', { sessionId, message });
  }

  /** Get pending exec approvals */
  async getPendingApprovals() {
    return this.request('exec.approval.pending');
  }

  /** Resolve an exec approval (allow-once / allow-always / deny) */
  async resolveApproval(approvalId, decision, reason) {
    return this.request('exec.approval.resolve', { approvalId, decision, reason });
  }

  /** Get available tools catalog */
  async getToolsCatalog() {
    return this.request('tools.catalog');
  }

  /** Get current config (includes skills) */
  async getConfig() {
    return this.request('config.get');
  }

  /** Get gateway health snapshot */
  async getHealth() {
    return this.request('health');
  }

  /** Tail streaming logs */
  async tailLogs(options = {}) {
    return this.request('logs.tail', options);
  }

  /** Get connected nodes status */
  async getNodesStatus() {
    return this.request('nodes.status');
  }

  // ─── High-Level API: Memory (REST via server.js) ─────────────────────────

  /** Get all memory entries */
  async getMemories() {
    const res = await fetch('/api/memory');
    if (!res.ok) throw new Error(`Memory fetch failed: ${res.status}`);
    return res.json();
  }

  /** Get list of daily memory files */
  async getDailyMemories() {
    const res = await fetch('/api/memory/daily');
    if (!res.ok) throw new Error(`Daily memory fetch failed: ${res.status}`);
    return res.json();
  }

  /** Get a specific daily memory file */
  async getDailyMemory(date) {
    const res = await fetch(`/api/memory/daily/${date}`);
    if (!res.ok) throw new Error(`Daily memory fetch failed: ${res.status}`);
    return res.json();
  }

  /** Add a new memory entry */
  async addMemory(text, source = 'user') {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source }),
    });
    if (!res.ok) throw new Error(`Memory write failed: ${res.status}`);
    return res.json();
  }

  /** Delete a memory entry by ID */
  async deleteMemory(id) {
    const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Memory delete failed: ${res.status}`);
    return res.json();
  }

  // ─── Server Health (REST) ────────────────────────────────────────────────

  /** Get server + gateway health status */
  async getServerHealth() {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json();
  }

  /** Get server config (LAN address, etc.) */
  async getServerConfig() {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    return res.json();
  }
}

// Singleton export
export const gateway = new OpenClawGateway();
