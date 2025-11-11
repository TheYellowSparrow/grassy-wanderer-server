// server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

const clients = new Map(); // id -> { ws, name, room }
const rooms = new Map();   // room -> Set of ids

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function broadcastToRoom(room, payload, exceptId = null) {
  const set = rooms.get(room);
  if (!set) return;
  const str = JSON.stringify(payload);
  for (const id of set) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(str);
    }
  }
}

wss.on('connection', (ws) => {
  const id = makeId();
  clients.set(id, { ws, name: null, room: null });
  ws.send(JSON.stringify({ type: 'id', id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) {
      console.log('Invalid JSON from', id);
      return;
    }

    // Handle join: { type: 'join', name: 'Alice', room: 'lobby' }
    if (msg.type === 'join') {
      const name = msg.name || id;
      const room = msg.room || 'lobby';
      const client = clients.get(id);
      client.name = name;
      client.room = room;

      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(id);

      // Send current players in room to the new client
      const players = Array.from(rooms.get(room)).map(i => {
        const c = clients.get(i);
        return { id: i, name: c.name };
      });
      ws.send(JSON.stringify({ type: 'players', players }));

      // Notify others in the room
      broadcastToRoom(room, { type: 'playerJoined', player: { id, name } }, id);
      console.log(`${name} joined ${room} (${id})`);
      return;
    }

    // Example: state update to room { type: 'state', state: {...} }
    if (msg.type === 'state') {
      const client = clients.get(id);
      if (!client || !client.room) return;
      broadcastToRoom(client.room, { type: 'state', id, state: msg.state }, id);
      return;
    }

    // Example: chat message { type: 'chat', text: 'hi' }
    if (msg.type === 'chat') {
      const client = clients.get(id);
      if (!client || !client.room) return;
      broadcastToRoom(client.room, { type: 'chat', id, name: client.name, text: msg.text }, id);
      return;
    }

    // Fallback: ignore unknown types
  });

  ws.on('close', () => {
    const client = clients.get(id);
    if (!client) return;
    const room = client.room;
    const name = client.name;
    if (room && rooms.has(room)) {
      rooms.get(room).delete(id);
      broadcastToRoom(room, { type: 'playerLeft', id });
      if (rooms.get(room).size === 0) rooms.delete(room);
    }
    clients.delete(id);
    console.log(`Disconnected ${name || id}`);
  });
});

server.listen(PORT, () => {
  console.log(`✅ WebSocket relay running on ws://localhost:${PORT}`);
});
