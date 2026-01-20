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
const SOLANA_USDT_STREAM_KEY =
  process.env.SOLANA_USDT_STREAM_KEY || "solana:usdt:transfers";
const SOLANA_USDC_STREAM_KEY =
  process.env.SOLANA_USDC_STREAM_KEY || "solana:usdc:transfers";

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
  const keys = [BLOCKS_STREAM_KEY, SOLANA_USDT_STREAM_KEY, SOLANA_USDC_STREAM_KEY];
  for (const key of keys) {
    try {
      // XGROUP CREATE <stream> <group> $ MKSTREAM
      await streamClient.sendCommand([
        "XGROUP",
        "CREATE",
        key,
        BLOCKS_STREAM_GROUP,
        "$",
        "MKSTREAM",
      ]);
      console.log(`✅ Redis Stream group created: ${key} / ${BLOCKS_STREAM_GROUP}`);
    } catch (err) {
      // 이미 존재하면 BUSYGROUP 에러
      const msg = String(err?.message || err);
      if (!msg.includes("BUSYGROUP")) throw err;
    }
  }
}

async function ackIds(streamKey, ids) {
  if (!ids.length) return;
  await streamClient.sendCommand([
    "XACK",
    streamKey,
    BLOCKS_STREAM_GROUP,
    ...ids,
  ]);
}

async function consumeStreamForever() {
  await ensureConsumerGroup();
  console.log(
    `📥 Stream consumer started: group=${BLOCKS_STREAM_GROUP} consumer=${BLOCKS_STREAM_CONSUMER}`
  );

  while (true) {
    try {
      // 새 메시지 블로킹 읽기 (3개 stream 동시 소비)
      // XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK <ms> STREAMS <k1> <k2> <k3> > > >
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
        SOLANA_USDT_STREAM_KEY,
        SOLANA_USDC_STREAM_KEY,
        ">",
        ">",
        ">",
      ]);

      if (!res) continue; // timeout

      const ackByStream = new Map();
      for (const streamRes of res) {
        const streamKey = streamRes?.[0];
        const entries = streamRes?.[1] || [];
        for (const entry of entries) {
          const [id, fields] = entry;
          const data = fieldsArrayToObject(fields);

          if (streamKey === BLOCKS_STREAM_KEY) {
            const event = {
              network: data.network,
              blockNumber: Number(data.blockNumber),
              timestamp: Number(data.timestamp) || Date.now(),
              eventId: id,
            };
            console.log(`📡 [Server] ${event.network} - Block/Slot: ${event.blockNumber}`);
            io.emit("newBlock", event);
          } else {
            const token = String(data.network || "")
              .toUpperCase()
              .includes("USDC")
              ? "USDC"
              : "USDT";
            const event = {
              token,
              slot: Number(data.slot),
              signature: data.signature,
              source: data.source,
              destination: data.destination,
              authority: data.authority,
              mint: data.mint,
              amount: data.amount,
              timestamp: Number(data.timestamp) || Date.now(),
              eventId: id,
            };
            io.emit("newTransfer", event);
          }

          const arr = ackByStream.get(streamKey) || [];
          arr.push(id);
          ackByStream.set(streamKey, arr);
        }
      }
      for (const [streamKey, ids] of ackByStream.entries()) {
        await ackIds(streamKey, ids);
      }
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
