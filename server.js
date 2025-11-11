// server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PING_INTERVAL_MS = 30000; // 30s
const STALE_CLIENT_MS = 120000; // 2 minutes

// Simple HTTP server for health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });

// In-memory state
const clients = new Map(); // id -> { ws, name, avatar, room, x, y, size, color, lastPong, lastUpdate, lastChatAt }
const rooms = new Map();   // room -> Set of ids

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeString(v, fallback = '') {
  return (typeof v === 'string' && v.length > 0) ? v : fallback;
}

function broadcastToRoom(room, payload, exceptId = null) {
  const set = rooms.get(room);
  if (!set) return;
  const str = JSON.stringify(payload);
  // iterate over a snapshot to avoid mutation issues
  for (const id of Array.from(set)) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (!c) {
      set.delete(id);
      continue;
    }
    if (c.ws && c.ws.readyState === WebSocket.OPEN) {
      try {
        c.ws.send(str);
      } catch (err) {
        console.warn('Failed to send to', id, err);
      }
    } else {
      // cleanup dead socket
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
    ws.send(JSON.stringify({ type: 'players', players }));
  } catch (e) {
    console.warn('Failed to send players list', e);
  }
}

wss.on('connection', (ws, req) => {
  const id = makeId();
  // default client record
  clients.set(id, {
    ws,
    name: null,
    avatar: null,
    room: null,
    x: 0,
    y: 0,
    size: 60,
    color: '#e74c3c',
    lastPong: Date.now(),
    lastUpdate: Date.now(),
    lastChatAt: 0
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    const c = clients.get(id);
    if (c) c.lastPong = Date.now();
    ws.isAlive = true;
  });

  // send server-assigned id immediately
  try {
    ws.send(JSON.stringify({ type: 'id', id }));
  } catch (e) {
    console.warn('Failed to send id to client', id, e);
  }

  console.log('connected', id, req.socket.remoteAddress);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn('Invalid JSON from', id, raw);
      return;
    }

    const client = clients.get(id);
    if (!client) return;

    // JOIN: client announces name/avatar/room/initial pos
    if (msg.type === 'join') {
      // Use server id; ignore client-sent id to avoid collisions
      client.name = safeString(msg.name, 'Player-' + id.slice(-4));
      client.avatar = safeString(msg.avatar, null);
      client.room = safeString(msg.room, 'lobby');
      if (typeof msg.x === 'number') client.x = msg.x;
      if (typeof msg.y === 'number') client.y = msg.y;
      if (typeof msg.size === 'number') client.size = msg.size;
      if (typeof msg.color === 'string') client.color = msg.color;
      client.lastUpdate = Date.now();

      if (!rooms.has(client.room)) rooms.set(client.room, new Set());
      rooms.get(client.room).add(id);

      // send full players list to the new client (with positions & avatars)
      sendPlayersListTo(ws, client.room);

      // notify others in the room about the new player (include avatar & pos)
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

      console.log('join', id, client.name, 'room=', client.room);
      return;
    }

    // POS: position update
    if (msg.type === 'pos') {
      // update server-side state (do not trust client id)
      if (typeof msg.x === 'number') client.x = msg.x;
      if (typeof msg.y === 'number') client.y = msg.y;
      if (typeof msg.size === 'number') client.size = msg.size;
      if (typeof msg.color === 'string') client.color = msg.color;
      // allow clients to update avatar (optional)
      if (typeof msg.avatar === 'string' && msg.avatar.length > 0) client.avatar = msg.avatar;
      client.lastUpdate = Date.now();

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
      return;
    }

    // CHAT: broadcast chat messages to the room
    if (msg.type === 'chat') {
      const now = Date.now();
      // basic rate limiting: one message per 300ms per client
      const MIN_CHAT_INTERVAL = 300;
      if (now - (client.lastChatAt || 0) < MIN_CHAT_INTERVAL) {
        // ignore too-frequent messages
        return;
      }
      client.lastChatAt = now;

      const text = (typeof msg.text === 'string') ? msg.text.trim() : '';
      if (!text) return;
      // limit length
      const MAX_CHAT_LEN = 500;
      const safeText = text.length > MAX_CHAT_LEN ? text.slice(0, MAX_CHAT_LEN) : text;
      const name = safeString(msg.name || client.name, 'Player-' + id.slice(-4));

      const payload = {
        type: 'chat',
        id,
        name,
        text: safeText
      };

      if (client.room) {
        broadcastToRoom(client.room, payload);
      } else {
        // if not in a room yet, echo back to sender only
        try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
      }

      console.log('chat', id, name, safeText);
      return;
    }

    // LEAVE: client requests to leave
    if (msg.type === 'leave') {
      try { ws.close(); } catch (e) { /* ignore */ }
      return;
    }

    // Additional message types (ping, etc.) can be handled here
  });

  ws.on('close', () => {
    const client = clients.get(id);
    if (!client) return;
    const room = client.room;
    if (room && rooms.has(room)) {
      rooms.get(room).delete(id);
      // notify remaining players
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

// Ping/pong keepalive and stale cleanup
const pingInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, c] of Array.from(clients.entries())) {
    const ws = c.ws;
    if (!ws) {
      clients.delete(id);
      continue;
    }
    // if last pong is too old, terminate
    if (now - (c.lastPong || 0) > STALE_CLIENT_MS) {
      console.log('terminating stale client', id);
      try { ws.terminate(); } catch (e) { /* ignore */ }
      // cleanup will happen in 'close' handler
      continue;
    }
    // send ping
    try {
      ws.isAlive = false;
      ws.ping();
    } catch (e) {
      console.warn('ping failed for', id, e);
    }
  }
}, PING_INTERVAL_MS);

// Optional periodic cleanup of empty rooms (defensive)
const cleanupInterval = setInterval(() => {
  for (const [room, set] of Array.from(rooms.entries())) {
    if (!set || set.size === 0) rooms.delete(room);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`✅ WebSocket relay running on ws://localhost:${PORT}`);
});

// graceful shutdown
function shutdown() {
  clearInterval(pingInterval);
  clearInterval(cleanupInterval);
  wss.close(() => {
    server.close(() => {
      console.log('Server shut down');
      process.exit(0);
    });
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
