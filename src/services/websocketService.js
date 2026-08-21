import { WebSocketServer } from 'ws';

let wss = null;
const clients = new Set();

export const initializeWebSocket = (server) => {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected. Active clients: ${clients.size}`);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        }
      } catch (err) {
        // Ignore non-JSON messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected. Active clients: ${clients.size}`);
    });

    ws.on('error', (error) => {
      console.error('[WS] Connection error:', error);
      clients.delete(ws);
    });
  });

  // Server-side heartbeat every 10 seconds to keep all proxy/Render connections alive
  setInterval(() => {
    if (!wss) return;
    const pingMsg = JSON.stringify({ type: 'ping' });
    clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(pingMsg);
      }
    });
  }, 10000);

  console.log('[WS] WebSocket Server initialized with 10s heartbeat keepalive.');
};

export const broadcast = (type, payload) => {
  if (!wss) return;
  const message = JSON.stringify({ type, payload });
  clients.forEach((client) => {
    if (client.readyState === 1) { 
      client.send(message);
    }
  });
};