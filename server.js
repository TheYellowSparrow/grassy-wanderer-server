// server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('WebSocket server is running');
});
const wss = new WebSocket.Server({ server });

const clients = new Map(); // id -> { ws, name, room, x, y, size, color, lastPong }
const rooms = new Map();   // room -> Set of ids

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function broadcastToRoom(room, payload, exceptId = null) {
  const set = rooms.get(room);
  if (!set) return;
  const str = JSON.stringify(payload);
  for (const id of Array.from(set)) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (!c) { set.delete(id); continue; }
    if (c.ws.readyState === WebSocket.OPEN) {
      try { c.ws.send(str); } catch (e) { console.warn('send error', id, e); }
    } else {
      set.delete(id);
      clients.delete(id);
    }
  }
}

wss.on('connection', (ws) => {
  const id = makeId();
  clients.set(id, { ws, name: null, room: null, x: 0, y: 0, size: 60, color: '#e74c3c', lastPong: Date.now() });

  ws.isAlive = true;
  ws.on('pong', () => {
    const c = clients.get(id);
    if (c) c.lastPong = Date.now();
    ws.isAlive = true;
  });

  // Tell client its server-assigned id
  ws.send(JSON.stringify({ type: 'id', id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { console.warn('invalid json', raw); return; }

    if (msg.type === 'join') {
      // Ignore client-sent id; use server id
      const client = clients.get(id);
      client.name = msg.name || ('P-' + id.slice(-4));
      client.room = msg.room || 'lobby';
      if (typeof msg.x === 'number') client.x = msg.x;
      if (typeof msg.y === 'number') client.y = msg.y;
      if (msg.size) client.size = msg.size;
      if (msg.color) client.color = msg.color;

      if (!rooms.has(client.room)) rooms.set(client.room, new Set());
      rooms.get(client.room).add(id);

      // Send full players list (with positions) to the new client
      const players = Array.from(rooms.get(client.room)).map(i => {
        const c = clients.get(i);
        return { id: i, name: c.name, x: c.x, y: c.y, size: c.size, color: c.color };
      });
      ws.send(JSON.stringify({ type: 'players', players }));

      // Notify others in the room
      broadcastToRoom(client.room, { type: 'playerJoined', player: { id, name: client.name, x: client.x, y: client.y, size: client.size, color: client.color } }, id);

      console.log('join', id, client.name, client.room);
      return;
    }

    if (msg.type === 'pos') {
      const client = clients.get(id);
      if (!client) return;
      client.x = (typeof msg.x === 'number') ? msg.x : client.x;
      client.y = (typeof msg.y === 'number') ? msg.y : client.y;
      client.size = msg.size || client.size;
      client.color = msg.color || client.color;
      client.last = Date.now();

      if (client.room) {
        broadcastToRoom(client.room, { type: 'pos', id, x: client.x, y: client.y, size: client.size, color: client.color }, id);
      }
      return;
    }

    if (msg.type === 'leave') {
      ws.close();
      return;
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
    console.log('disconnect', id);
  });
});

// Ping/pong keepalive
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 30000);

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
