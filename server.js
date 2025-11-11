// server.js
'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PING_INTERVAL_MS = 30_000;
const STALE_CLIENT_MS = 120_000;
const CLEANUP_INTERVAL_MS = 60_000;

const MAX_MESSAGE_SIZE = 64 * 1024;
const MAX_NAME_LEN = 64;
const MAX_ROOM_LEN = 64;
const MAX_AVATAR_LEN = 1024;
const MAX_CHAT_LEN = 500;
const MIN_CHAT_INTERVAL_MS = 300;
const MIN_POS_INTERVAL_MS = 30;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server, maxPayload: MAX_MESSAGE_SIZE });

const clients = new Map();
const rooms = new Map();

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeString(v, fallback = '', maxLen = 256) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (s.length === 0) return fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function broadcastToRoom(room, payload, exceptId = null) {
  const set = rooms.get(room);
  if (!set) return;
  const str = JSON.stringify(payload);
  for (const id of Array.from(set)) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (!c) {
      set.delete(id);
      continue;
    }
    const ws = c.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      set.delete(id);
      clients.delete(id);
      continue;
    }
    try {
      ws.send(str);
    } catch (err) {
      console.warn('Failed to send to', id, err && err.message);
      try { ws.terminate(); } catch (e) {}
      set.delete(id);
      clients.delete(id);
    }
  }
}

function sendPlayersListTo(ws, room) {
  const set = rooms.get(room);
  const players = [];
  if (set) {
    for (const id of set) {
      const c = clients.get(id);
      if (!c) continue;
      players.push({
        id,
        name: c.name,
        avatar: c.avatar || null,
        x: typeof c.x === 'number' ? c.x : 0,
        y: typeof c.y === 'number' ? c.y : 0,
        size: c.size || 60,
        color: c.color || '#e74c3c'
      });
    }
  }
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'players', players }));
    }
  } catch (e) {
    console.warn('Failed to send players list', e && e.message);
  }
}

function safeParseJson(raw) {
  try { return JSON.parse(raw); } catch (e) { return null; }
}

wss.on('connection', (ws, req) => {
  const id = makeId();
  const now = Date.now();

  clients.set(id, {
    ws,
    name: null,
    avatar: null,
    room: null,
    x: 0,
    y: 0,
    size: 60,
    color: '#e74c3c',
    lastPong: now,
    lastUpdate: now,
    lastChatAt: 0,
    lastPosAt: 0
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    const c = clients.get(id);
    if (c) c.lastPong = Date.now();
    ws.isAlive = true;
  });

  try { ws.send(JSON.stringify({ type: 'id', id })); } catch (e) { console.warn('Failed to send id to client', id, e && e.message); }

  console.log('connected', id, req.socket && req.socket.remoteAddress);

  ws.on('message', (raw) => {
    try {
      if (!raw) return;
      let text = raw;
      if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
      if (typeof text !== 'string') return;
      if (text.length > MAX_MESSAGE_SIZE) {
        console.warn('Oversized message from', id);
        return;
      }

      const msg = safeParseJson(text);
      if (!msg || typeof msg.type !== 'string') return;

      const client = clients.get(id);
      if (!client) return;

      const now = Date.now();

      switch (msg.type) {
        case 'join': {
          client.name = safeString(msg.name, 'Player-' + id.slice(-4), MAX_NAME_LEN);
          client.avatar = safeString(msg.avatar, null, MAX_AVATAR_LEN);
          client.room = safeString(msg.room, 'lobby', MAX_ROOM_LEN);
          if (typeof msg.x === 'number') client.x = msg.x;
          if (typeof msg.y === 'number') client.y = msg.y;
          if (typeof msg.size === 'number') client.size = msg.size;
          if (typeof msg.color === 'string') client.color = safeString(msg.color, client.color, 32);
          client.lastUpdate = now;

          if (!rooms.has(client.room)) rooms.set(client.room, new Set());
          rooms.get(client.room).add(id);

          sendPlayersListTo(ws, client.room);

          broadcastToRoom(client.room, {
            type: 'playerJoined',
            player: {
              id,
              name: client.name,
              avatar: client.avatar || null,
              x: client.x,
              y: client.y,
              size: client.size,
              color: client.color
            }
          }, id);

          // IMPORTANT: send explicit joined ack so client knows server processed the join
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'joined', room: client.room }));
            }
          } catch (e) {
            console.warn('Failed to send joined ack to', id, e && e.message);
          }

          console.log('join', id, client.name, 'room=', client.room);
          break;
        }

        case 'pos': {
          if (now - (client.lastPosAt || 0) < MIN_POS_INTERVAL_MS) return;
          client.lastPosAt = now;

          if (typeof msg.x === 'number') client.x = msg.x;
          if (typeof msg.y === 'number') client.y = msg.y;
          if (typeof msg.size === 'number') client.size = msg.size;
          if (typeof msg.color === 'string') client.color = safeString(msg.color, client.color, 32);
          if (typeof msg.avatar === 'string' && msg.avatar.length > 0) client.avatar = safeString(msg.avatar, client.avatar, MAX_AVATAR_LEN);
          client.lastUpdate = now;

          if (client.room) {
            broadcastToRoom(client.room, {
              type: 'pos',
              id,
              x: client.x,
              y: client.y,
              size: client.size,
              color: client.color,
              avatar: client.avatar || null,
              name: client.name
            }, id);
          }
          break;
        }

        case 'chat': {
          if (now - (client.lastChatAt || 0) < MIN_CHAT_INTERVAL_MS) return;
          client.lastChatAt = now;

          const rawText = typeof msg.text === 'string' ? msg.text : '';
          const text = rawText.trim();
          if (!text) return;

          const safeText = text.length > MAX_CHAT_LEN ? text.slice(0, MAX_CHAT_LEN) : text;
          const name = safeString(msg.name || client.name, 'Player-' + id.slice(-4), MAX_NAME_LEN);

          const payload = { type: 'chat', id, name, text: safeText };

          if (client.room) {
            broadcastToRoom(client.room, payload);
          } else {
            try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); } catch (e) {}
          }

          console.log('chat', id, name, safeText);
          break;
        }

        case 'leave': {
          try { ws.close(); } catch (e) {}
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.warn('Error handling message from', id, err && err.message);
      try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Invalid message or server error' })); } catch (e) {}
    }
  });

  ws.on('close', () => {
    const client = clients.get(id);
    if (!client) return;
    const room = client.room;
    if (room && rooms.has(room)) {
      rooms.get(room).delete(id);
      broadcastToRoom(room, { type: 'playerLeft', id });
      if (rooms.get(room).size === 0) rooms.delete(room);
    }
    clients.delete(id);
    console.log('disconnect', id, client.name);
  });

  ws.on('error', (err) => {
    console.warn('ws error', id, err && err.message);
  });
});

const pingInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, c] of Array.from(clients.entries())) {
    const ws = c.ws;
    if (!ws) { clients.delete(id); continue; }
    if (now - (c.lastPong || 0) > STALE_CLIENT_MS) {
      console.log('terminating stale client', id);
      try { ws.terminate(); } catch (e) {}
      continue;
    }
    try { ws.isAlive = false; ws.ping(); } catch (e) { console.warn('ping failed for', id, e && e.message); }
  }
}, PING_INTERVAL_MS);

const cleanupInterval = setInterval(() => {
  for (const [room, set] of Array.from(rooms.entries())) {
    if (!set || set.size === 0) rooms.delete(room);
  }
}, CLEANUP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`✅ WebSocket relay running on ws://localhost:${PORT}`);
});

function shutdown() {
  clearInterval(pingInterval);
  clearInterval(cleanupInterval);
  try { wss.close(); } catch (e) {}
  try {
    server.close(() => {
      console.log('Server shut down');
      process.exit(0);
    });
  } catch (e) {
    console.log('Shutdown error', e && e.message);
    process.exit(1);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});
