import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { createClient } from "redis";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// public 폴더의 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../public')));

// Redis 클라이언트 연결
const pubClient = createClient({ url: "redis://localhost:6379" });
const subClient = pubClient.duplicate();
await pubClient.connect();
await subClient.connect();

io.adapter(createAdapter(pubClient, subClient));

// Redis에서 new_block 구독 (block-polling.js에서 publish한 메시지 받기)
subClient.subscribe("new_block", (message) => {
  const data = JSON.parse(message);
  console.log("📡 [Server] Received from Redis, broadcasting to clients:", data.blockNumber);
  io.emit("newBlock", {
    blockNumber: data.blockNumber,
    timestamp: Date.now()
  });
});

io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);
});

httpServer.listen(4000, () => {
  console.log("✅ Socket.IO server running on http://localhost:4000");
});
