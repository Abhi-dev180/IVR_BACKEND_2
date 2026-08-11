const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { initializeDatabase } = require('./config/db');
const callRoutes = require('./routes/callRoutes');

const http = require('http');
const { initializeWebSocket } = require('./services/websocketService');

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
