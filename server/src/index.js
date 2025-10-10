import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { createClient } from "redis";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

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

// Redis에서 new_block 구독
subClient.subscribe("new_block", (message) => {
  const data = JSON.parse(message);
  console.log("📡 Broadcasting block:", data.blockNumber);
  io.emit("newBlock", {
    blockNumber: data.blockNumber,
    timestamp: Date.now()
  });
});

// 블록 폴링 (5초마다)
async function pollLatestBlock() {
  try {
    const { data } = await axios.post("https://rpc-amoy.polygon.technology", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });
    
    const blockNumber = parseInt(data.result, 16);
    console.log("🔹 Latest block:", blockNumber);
    await pubClient.publish("new_block", JSON.stringify({ blockNumber }));
  } catch (error) {
    console.error("❌ Error polling block:", error.message);
  }
}

setInterval(pollLatestBlock, 5000);
pollLatestBlock(); // 즉시 한 번 실행

io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);
});

httpServer.listen(4000, () => {
  console.log("✅ Socket.IO server running on http://localhost:4000");
});
