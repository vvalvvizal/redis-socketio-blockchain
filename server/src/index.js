import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { createClient } from "redis";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const BLOCKS_STREAM_KEY = process.env.BLOCKS_STREAM_KEY || "blocks:stream";
const BLOCKS_STREAM_GROUP = process.env.BLOCKS_STREAM_GROUP || "socketio";
const BLOCKS_STREAM_CONSUMER =
  process.env.BLOCKS_STREAM_CONSUMER ||
  `socketio-${process.pid}`;

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// public 폴더의 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../public')));

// Redis 클라이언트 연결
const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();
const streamClient = pubClient.duplicate();
await pubClient.connect();
await subClient.connect();
await streamClient.connect();

io.adapter(createAdapter(pubClient, subClient));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fieldsArrayToObject(fields) {
  // fields: [k1, v1, k2, v2, ...]
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[String(fields[i])] = fields[i + 1];
  }
  return obj;
}

async function ensureConsumerGroup() {
  try {
    // XGROUP CREATE <stream> <group> $ MKSTREAM
    await streamClient.sendCommand([
      "XGROUP",
      "CREATE",
      BLOCKS_STREAM_KEY,
      BLOCKS_STREAM_GROUP,
      "$",
      "MKSTREAM",
    ]);
    console.log(
      `✅ Redis Stream group created: ${BLOCKS_STREAM_KEY} / ${BLOCKS_STREAM_GROUP}`
    );
  } catch (err) {
    // 이미 존재하면 BUSYGROUP 에러
    const msg = String(err?.message || err);
    if (!msg.includes("BUSYGROUP")) throw err;
  }
}

async function ackIds(ids) {
  if (!ids.length) return;
  await streamClient.sendCommand([
    "XACK",
    BLOCKS_STREAM_KEY,
    BLOCKS_STREAM_GROUP,
    ...ids,
  ]);
}

async function consumeStreamForever() {
  await ensureConsumerGroup();
  console.log(
    `📥 Stream consumer started: ${BLOCKS_STREAM_KEY} group=${BLOCKS_STREAM_GROUP} consumer=${BLOCKS_STREAM_CONSUMER}`
  );

  while (true) {
    try {
      // 1) 오래된 pending 메시지 reclaim (Redis 6.2+)
      // XAUTOCLAIM <key> <group> <consumer> <min-idle-ms> <start> COUNT <n>
      try {
        const claimRes = await streamClient.sendCommand([
          "XAUTOCLAIM",
          BLOCKS_STREAM_KEY,
          BLOCKS_STREAM_GROUP,
          BLOCKS_STREAM_CONSUMER,
          "60000",
          "0-0",
          "COUNT",
          "100",
        ]);

        const claimed = claimRes?.[1] || [];
        const ackList = [];
        for (const entry of claimed) {
          const [id, fields] = entry;
          const data = fieldsArrayToObject(fields);
          const event = {
            network: data.network,
            blockNumber: Number(data.blockNumber),
            timestamp: Number(data.timestamp) || Date.now(),
            eventId: id,
          };
          console.log(`📡 [Server][reclaim] ${event.network} - ${event.blockNumber}`);
          io.emit("newBlock", event);
          ackList.push(id);
        }
        await ackIds(ackList);
      } catch (e) {
        // Redis 버전이 낮아 XAUTOCLAIM이 없을 수 있으니 무시하고 계속 진행
        const msg = String(e?.message || e);
        if (!msg.toLowerCase().includes("unknown command")) throw e;
      }

      // 2) 새 메시지 블로킹 읽기
      // XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK <ms> STREAMS <key> >
      const res = await streamClient.sendCommand([
        "XREADGROUP",
        "GROUP",
        BLOCKS_STREAM_GROUP,
        BLOCKS_STREAM_CONSUMER,
        "COUNT",
        "100",
        "BLOCK",
        "5000",
        "STREAMS",
        BLOCKS_STREAM_KEY,
        ">",
      ]);

      if (!res) continue; // timeout

      const ackList = [];
      for (const stream of res) {
        const entries = stream?.[1] || [];
        for (const entry of entries) {
          const [id, fields] = entry;
          const data = fieldsArrayToObject(fields);
          const event = {
            network: data.network,
            blockNumber: Number(data.blockNumber),
            timestamp: Number(data.timestamp) || Date.now(),
            eventId: id,
          };
          console.log(`📡 [Server] ${event.network} - Block/Slot: ${event.blockNumber}`);
          io.emit("newBlock", event);
          ackList.push(id);
        }
      }
      await ackIds(ackList);
    } catch (err) {
      console.error("❌ Stream consume error:", err?.message || err);
      await sleep(1000);
    }
  }
}

// 백그라운드로 Stream 소비 시작
consumeStreamForever();

io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id, `(Total: ${io.sockets.sockets.size})`);
  
  socket.on("disconnect", () => {
    console.log("🔌 client disconnected:", socket.id, `(Total: ${io.sockets.sockets.size})`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ Socket.IO server running on http://localhost:${PORT}`);
});
