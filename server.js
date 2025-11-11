const http = require('http');
const WebSocket = require('ws');

// Use environment port if hosted, or default to 3000
const PORT = process.env.PORT || 3000;

// Create HTTP server for health check
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('WebSocket server is running');
});

// Attach WebSocket server to HTTP server
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on('connection', (ws) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  clients.set(id, ws);

  // Send ID to the client
  ws.send(JSON.stringify({ type: 'id', id }));

  ws.on('message', (msg) => {
    // Broadcast to all other clients
    for (const [otherId, client] of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  });

  ws.on('close', () => {
    clients.delete(id);
  });
});

// Start listening
server.listen(PORT, () => {
  console.log(`✅ WebSocket relay running on ws://localhost:${PORT}`);
});
