import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
import { initializeDatabase } from './config/db.js';
import callRoutes from './routes/callRoutes.js';

import http from 'http';
import { initializeWebSocket } from './services/websocketService.js';

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routing
app.use('/api/call', callRoutes);

// Healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Twilio IVR Platform Backend is running.' });
});

// Run Server & Db Sync
const startServer = async () => {
  await initializeDatabase();
  initializeWebSocket(server);
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer();
