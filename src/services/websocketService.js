import { WebSocketServer } from 'ws';

let wss = null;
const clients = new Set();

export const initializeWebSocket = (server) => {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected. Active clients: ${clients.size}`);

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected. Active clients: ${clients.size}`);
    });

    ws.on('error', (error) => {
      console.error('[WS] Connection error:', error);
      clients.delete(ws);
    });
  });

  console.log('[WS] WebSocket Server initialized.');
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