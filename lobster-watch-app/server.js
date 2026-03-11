require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const OPENCLAW_HOME = (process.env.OPENCLAW_HOME || '~/.openclaw').replace(/^~/, os.homedir());
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MEMORY_FILE = path.join(OPENCLAW_HOME, 'workspace', 'MEMORY.md');
const MEMORY_DIR = path.join(OPENCLAW_HOME, 'workspace', 'memory');

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.json());

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── MEMORY REST API ─────────────────────────────────────────────────────────

// Parse MEMORY.md into structured entries
function parseMemoryFile(content) {
  const entries = [];
  const lines = content.split('\n');
  let id = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Remove leading bullet (-, *, •)
    const text = trimmed.replace(/^[-*•]\s*/, '');
    if (!text) continue;

    // Try to extract source tag: <!-- source:user --> or <!-- source:agent -->
    let source = 'agent';
    const sourceMatch = text.match(/<!--\s*source:\s*(user|agent|imported)\s*-->/);
    if (sourceMatch) {
      source = sourceMatch[1];
    }
    const cleanText = text.replace(/<!--.*?-->/g, '').trim();

    // Try to extract date tag: <!-- date:Feb 28 -->
    let date = null;
    const dateMatch = text.match(/<!--\s*date:\s*(.+?)\s*-->/);
    if (dateMatch) {
      date = dateMatch[1];
    }

    // Try to extract import source: <!-- import:ChatGPT -->
    let importSource = null;
    const importMatch = text.match(/<!--\s*import:\s*(.+?)\s*-->/);
    if (importMatch) {
      importSource = importMatch[1];
      source = 'imported';
    }

    if (cleanText) {
      entries.push({
        id: ++id,
        source,
        text: cleanText,
        date: date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        importSource,
        _lineIndex: lines.indexOf(line),
      });
    }
  }

  return entries;
}

// GET /api/memory — read all memories
app.get('/api/memory', (req, res) => {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return res.json({ entries: [], raw: '' });
    }
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const entries = parseMemoryFile(content);
    res.json({ entries, raw: content });
  } catch (err) {
    console.error('Error reading memory:', err.message);
    res.status(500).json({ error: 'Failed to read memory file', detail: err.message });
  }
});

// GET /api/memory/daily — list daily memory files
app.get('/api/memory/daily', (req, res) => {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      return res.json({ files: [] });
    }
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
    res.json({ files });
  } catch (err) {
    console.error('Error listing daily memories:', err.message);
    res.status(500).json({ error: 'Failed to list daily memories', detail: err.message });
  }
});

// GET /api/memory/daily/:date — read specific daily memory
app.get('/api/memory/daily/:date', (req, res) => {
  try {
    const filePath = path.join(MEMORY_DIR, `${req.params.date}.md`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Daily memory not found' });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content, date: req.params.date });
  } catch (err) {
    console.error('Error reading daily memory:', err.message);
    res.status(500).json({ error: 'Failed to read daily memory', detail: err.message });
  }
});

// POST /api/memory — add a new memory entry
app.post('/api/memory', (req, res) => {
  try {
    const { text, source = 'user' } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Memory text is required' });
    }

    // Ensure directory exists
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const entry = `- ${text.trim()} <!-- source:${source} --> <!-- date:${dateStr} -->\n`;

    fs.appendFileSync(MEMORY_FILE, entry);
    res.json({ ok: true, text: text.trim(), source, date: dateStr });
  } catch (err) {
    console.error('Error writing memory:', err.message);
    res.status(500).json({ error: 'Failed to write memory', detail: err.message });
  }
});

// DELETE /api/memory/:id — remove a memory entry by line index
app.delete('/api/memory/:id', (req, res) => {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return res.status(404).json({ error: 'Memory file not found' });
    }

    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const entries = parseMemoryFile(content);
    const entry = entries.find(e => e.id === parseInt(req.params.id, 10));

    if (!entry) {
      return res.status(404).json({ error: 'Memory entry not found' });
    }

    const lines = content.split('\n');
    lines.splice(entry._lineIndex, 1);
    fs.writeFileSync(MEMORY_FILE, lines.join('\n'));

    res.json({ ok: true, deleted: entry.id });
  } catch (err) {
    console.error('Error deleting memory:', err.message);
    res.status(500).json({ error: 'Failed to delete memory', detail: err.message });
  }
});

// ─── HEALTH / CONFIG API ─────────────────────────────────────────────────────

let gatewayAlive = false;

app.get('/api/health', (req, res) => {
  res.json({
    server: true,
    gateway: gatewayAlive,
    gatewayUrl: GATEWAY_URL,
    openclawHome: OPENCLAW_HOME,
    memoryFileExists: fs.existsSync(MEMORY_FILE),
  });
});

app.get('/api/config', (req, res) => {
  // Return non-sensitive config for the frontend
  const lanIP = getLanIP();
  res.json({
    openclawHome: OPENCLAW_HOME,
    gatewayConnected: gatewayAlive,
    port: PORT,
    lanAddress: lanIP ? `${lanIP}:${PORT}` : null,
  });
});

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return null;
}

// ─── WEBSOCKET PROXY ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs, req) => {
  console.log('[WS] Browser client connected');

  let gatewayWs = null;

  try {
    gatewayWs = new WebSocket(GATEWAY_URL);
  } catch (err) {
    console.error('[WS] Failed to create gateway connection:', err.message);
    clientWs.send(JSON.stringify({
      type: 'event',
      event: '_proxy_error',
      payload: { message: 'Failed to connect to OpenClaw Gateway', detail: err.message },
    }));
    clientWs.close(1011, 'Gateway connection failed');
    return;
  }

  gatewayWs.on('open', () => {
    console.log('[WS] Connected to OpenClaw Gateway');
    gatewayAlive = true;

    // Send auth handshake if token is configured
    if (GATEWAY_TOKEN) {
      gatewayWs.send(JSON.stringify({
        type: 'req',
        id: '__proxy_auth__',
        method: 'auth',
        params: { token: GATEWAY_TOKEN },
      }));
    }

    // Notify browser that gateway connection is ready
    clientWs.send(JSON.stringify({
      type: 'event',
      event: '_proxy_ready',
      payload: { gatewayUrl: GATEWAY_URL },
    }));
  });

  // Forward: browser → gateway
  clientWs.on('message', (data) => {
    if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.send(data.toString());
    }
  });

  // Forward: gateway → browser
  gatewayWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  // Cleanup
  clientWs.on('close', () => {
    console.log('[WS] Browser client disconnected');
    if (gatewayWs) gatewayWs.close();
  });

  gatewayWs.on('close', () => {
    console.log('[WS] Gateway connection closed');
    gatewayAlive = false;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'event',
        event: '_proxy_disconnected',
        payload: { message: 'Gateway connection lost' },
      }));
    }
  });

  gatewayWs.on('error', (err) => {
    console.error('[WS] Gateway error:', err.message);
    gatewayAlive = false;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'event',
        event: '_proxy_error',
        payload: { message: 'Gateway connection error', detail: err.message },
      }));
    }
  });

  clientWs.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

// ─── STATIC FILES (serve last, so API routes take priority) ──────────────────
app.use(express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html',
}));

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const lanIP = getLanIP();
  console.log('');
  console.log('  🦞 Lobster Watch server running');
  console.log(`     Local:   http://localhost:${PORT}`);
  if (lanIP) {
    console.log(`     LAN:     http://${lanIP}:${PORT}`);
    console.log(`     Phone:   http://${lanIP}:${PORT}`);
  }
  console.log(`     Gateway: ${GATEWAY_URL}`);
  console.log(`     Memory:  ${MEMORY_FILE}`);
  console.log('');
});
