import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { createClient } from "redis";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";

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
const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SOLANA_USDT_STREAM_KEY =
  process.env.SOLANA_USDT_STREAM_KEY || "solana:usdt:transfers";
const SOLANA_USDC_STREAM_KEY =
  process.env.SOLANA_USDC_STREAM_KEY || "solana:usdc:transfers";
const SUI_EVENTS_STREAM_KEY =
  process.env.SUI_EVENTS_STREAM_KEY || "sui:events";

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// public 폴더의 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../public')));

async function suiGraphql(query, variables) {
  if (!SUI_GRAPHQL_URL) throw new Error("SUI_GRAPHQL_URL is not set");
  const res = await axios.post(
    SUI_GRAPHQL_URL,
    { query, variables },
    { headers: { "Content-Type": "application/json" } }
  );
  if (res?.data?.errors?.length) {
    const msg = res.data.errors?.[0]?.message || JSON.stringify(res.data.errors);
    throw new Error(msg);
  }
  return res?.data?.data;
}

async function solanaRpc(method, params = []) {
  if (!SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is not set");
  const timeoutMs = Number(process.env.RPC_HTTP_TIMEOUT_MS || 15000);
  const payload = { jsonrpc: "2.0", id: 1, method, params };

  const res = await axios.post(
    SOLANA_RPC_URL,
    payload,
    {
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : 15000,
      validateStatus: () => true,
      headers: { "Content-Type": "application/json" },
    }
  );
  

  if (res.status < 200 || res.status >= 300) {
    const bodyPreview =
      typeof res.data === "string"
        ? res.data.slice(0, 300)
        : JSON.stringify(res.data)?.slice(0, 300);
    throw new Error(`HTTP ${res.status} from Solana RPC method=${method} (body: ${bodyPreview})`);
  }
  const data = res?.data;
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid Solana RPC response type for method=${method}: ${typeof data}`);
  }
  if (data?.error) {
    const msg = data.error?.message || JSON.stringify(data.error);
    throw new Error(`Solana RPC error method=${method}: ${msg}`);
  }

  try {
    const s = JSON.stringify(data?.result);
    console.log(
      `🛰️  [Solana][rpc:res:${method}]`,
      s.length > 2000 ? s.slice(0, 2000) + "...(truncated)" : s
    );
  } catch {
    console.log(`🛰️  [Solana][rpc:res:${method}]`, data?.result);
  }
  return data?.result;
}

async function evmRpc(rpcUrl, method, params = []) {
  if (!rpcUrl) throw new Error(`${method}: RPC URL is not set`);
  const timeoutMs = Number(process.env.RPC_HTTP_TIMEOUT_MS || 15000);
  const payload = { jsonrpc: "2.0", id: 1, method, params };
  const res = await axios.post(
    rpcUrl,
    payload,
    {
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : 15000,
      validateStatus: () => true,
      headers: { "Content-Type": "application/json" },
    }
  );
  if (res.status < 200 || res.status >= 300) {
    const bodyPreview =
      typeof res.data === "string"
        ? res.data.slice(0, 300)
        : JSON.stringify(res.data)?.slice(0, 300);
    throw new Error(`HTTP ${res.status} from EVM RPC method=${method} (body: ${bodyPreview})`);
  }
  const data = res?.data;
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid EVM RPC response type for method=${method}: ${typeof data}`);
  }
  if (data?.error) {
    const msg = data.error?.message || JSON.stringify(data.error);
    throw new Error(`EVM RPC error method=${method}: ${msg}`);
  }
  return data?.result;
}

// Polygon block -> tx hashes (block explorer style)
app.get("/api/polygon/block/:n", async (req, res) => {
  try {
    if (!POLYGON_RPC_URL) throw new Error("POLYGON_RPC_URL is not set");
    const nStr = String(req.params.n || "").trim();
    const n = Number(nStr);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ ok: false, error: "invalid block number" });
    }
    const limit = Math.min(Number(req.query.limit || 200) || 200, 2000);

    const block = await evmRpc(POLYGON_RPC_URL, "eth_getBlockByNumber", [
      `0x${n.toString(16)}`,
      false,
    ]);
    const txs = Array.isArray(block?.transactions) ? block.transactions : [];
    const timestampMs =
      typeof block?.timestamp === "string"
        ? parseInt(block.timestamp, 16) * 1000
        : null;

    return res.json({
      ok: true,
      blockNumber: n,
      timestamp: timestampMs,
      transactions: txs.slice(0, limit),
      truncated: txs.length > limit,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e?.message || String(e) });
  }
});

// Polygon tx hash -> receipt (logs/events)
app.get("/api/polygon/tx/:hash", async (req, res) => {
  try {
    if (!POLYGON_RPC_URL) throw new Error("POLYGON_RPC_URL is not set");
    const hash = String(req.params.hash || "").trim();
    if (!hash || !hash.startsWith("0x")) {
      return res.status(400).json({ ok: false, error: "invalid tx hash" });
    }

    const [tx, receipt] = await Promise.all([
      evmRpc(POLYGON_RPC_URL, "eth_getTransactionByHash", [hash]),
      evmRpc(POLYGON_RPC_URL, "eth_getTransactionReceipt", [hash]),
    ]);

    return res.json({ ok: true, hash, tx, receipt });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e?.message || String(e) });
  }
});

// Solana slot -> transaction signatures (block explorer style UI)
app.get("/api/solana/slot/:slot", async (req, res) => {
  try {
    const slotStr = String(req.params.slot || "").trim();
    const slot = Number(slotStr);
    if (!Number.isFinite(slot) || slot < 0) {
      return res.status(400).json({ ok: false, error: "invalid slot" });
    }
    const limit = Math.min(Number(req.query.limit || 30) || 30, 200);

    let block;
    try {
      block = await solanaRpc("getBlock", [
        slot,
        {
          encoding: "jsonParsed",
          transactionDetails: "signatures",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
    } catch (e) {
      const msg = String(e?.message || e);
      // Solana에는 skipped slot이 존재하고, RPC 노드가 해당 블록을 보관하지 않는 경우도 있어
      // getBlock이 "Block not available for slot"로 실패할 수 있음. UI에서는 에러 대신 상태로 반환.
      if (msg.includes("Block not available for slot")) {
        // 근처에 실제 블록이 있는 슬롯을 같이 추천(작은 범위만 스캔)
        let nearest = [];
        try {
          const from = Math.max(0, slot - 50);
          const to = slot;
          const blocks = await solanaRpc("getBlocks", [from, to]);
          if (Array.isArray(blocks)) nearest = blocks.slice(-10);
        } catch {}

        return res.json({
          ok: true,
          slot,
          skippedOrUnavailable: true,
          message: msg,
          signatures: [],
          nearestAvailableSlots: nearest,
        });
      }
      throw e;
    }

    const signatures = Array.isArray(block?.signatures) ? block.signatures.slice(0, limit) : [];
    return res.json({
      ok: true,
      slot,
      blockTime: block?.blockTime,
      blockHeight: block?.blockHeight,
      parentSlot: block?.parentSlot,
      signatures,
      truncated: Array.isArray(block?.signatures) ? block.signatures.length > limit : false,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e?.message || String(e) });
  }
});

// Solana tx signature -> transaction detail (logs/instructions/token balances)
app.get("/api/solana/tx/:sig", async (req, res) => {
  try {
    const sig = String(req.params.sig || "").trim();
    if (!sig) return res.status(400).json({ ok: false, error: "missing signature" });

    const tx = await solanaRpc("getTransaction", [
      sig,
      {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      },
    ]);

    return res.json({ ok: true, signature: sig, data: tx });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e?.message || String(e) });
  }
});

function parseTxDigestsFromNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    const d = n?.digest || n?.transactionDigest || n?.txDigest;
    if (typeof d === "string" && d.length) out.push(d);
  }
  return out;
}

// Sui checkpoint -> transaction digests (for block explorer style UI)
app.get("/api/sui/checkpoint/:seq", async (req, res) => {
  try {
    const seqStr = String(req.params.seq || "").trim();
    const seq = Number(seqStr);
    if (!Number.isFinite(seq) || seq < 0) {
      return res.status(400).json({ ok: false, error: "invalid sequenceNumber" });
    }

    const first = Math.min(Number(req.query.first || 30) || 30, 100);
    const after = typeof req.query.after === "string" ? req.query.after : null;

    // 스키마 버전에 따라 checkpoint 아래 트랜잭션 연결 필드가 다를 수 있어 fallback 시도
    const variants = [
      {
        name: "checkpoint.transactions",
        q: `
          query ($seq: UInt53!, $first: Int!, $after: String) {
            checkpoint(sequenceNumber: $seq) {
              sequenceNumber
              transactions(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { digest }
              }
            }
          }
        `,
        pick: (data) => data?.checkpoint?.transactions,
      },
      {
        name: "checkpoint.transactionBlocks",
        q: `
          query ($seq: UInt53!, $first: Int!, $after: String) {
            checkpoint(sequenceNumber: $seq) {
              sequenceNumber
              transactionBlocks(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { digest }
              }
            }
          }
        `,
        pick: (data) => data?.checkpoint?.transactionBlocks,
      },
      {
        name: "checkpoint.query.transactions",
        q: `
          query ($seq: UInt53!, $first: Int!, $after: String) {
            checkpoint(sequenceNumber: $seq) {
              sequenceNumber
              query {
                transactions(first: $first, after: $after) {
                  pageInfo { hasNextPage endCursor }
                  nodes { digest }
                }
              }
            }
          }
        `,
        pick: (data) => data?.checkpoint?.query?.transactions,
      },
    ];

    let lastErr = null;
    for (const v of variants) {
      try {
        const data = await suiGraphql(v.q, { seq, first, after });
        const conn = v.pick(data);
        const digests = parseTxDigestsFromNodes(conn?.nodes);
        const pageInfo = conn?.pageInfo || {};
        return res.json({
          ok: true,
          via: v.name,
          sequenceNumber: seq,
          digests,
          pageInfo: {
            hasNextPage: Boolean(pageInfo?.hasNextPage),
            endCursor: pageInfo?.endCursor || null,
          },
        });
      } catch (e) {
        lastErr = e;
      }
    }

    return res.status(502).json({ ok: false, error: lastErr?.message || String(lastErr) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Sui txDigest -> transaction detail (effects/objectChanges/events)
app.get("/api/sui/tx/:digest", async (req, res) => {
  try {
    const digest = String(req.params.digest || "").trim();
    if (!digest) return res.status(400).json({ ok: false, error: "missing digest" });

    // 여러 스키마 버전에 대응: transaction(...) 우선, 실패 시 transactions(...) 연결 조회 fallback
    const queries = [
      {
        name: "transaction",
        q: `
          query ($digest: String!) {
            transaction(digest: $digest) {
              digest
              sender { address }
              effects {
                status
                timestamp
                checkpoint { sequenceNumber }
                events {
                  nodes {
                    timestamp
                    sender { address }
                    contents { type { repr } json }
                  }
                }
                objectChanges {
                  nodes {
                    address
                  }
                }
                balanceChanges {
                  nodes {
                    amount
                    owner { address }
                    coinType { repr }
                  }
                }
              }
            }
          }
        `,
        pick: (data) => data?.transaction,
      },
    ];

    let lastErr = null;
    for (const item of queries) {
      try {
        const data = await suiGraphql(item.q, { digest });
        const out = item.pick(data);
        if (!out) {
          lastErr = new Error(`No data for digest via ${item.name}`);
          continue;
        }
        return res.json({ ok: true, via: item.name, data: out });
      } catch (e) {
        lastErr = e;
      }
    }

    return res.status(502).json({ ok: false, error: lastErr?.message || String(lastErr) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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
  const keys = [
    BLOCKS_STREAM_KEY,
    SOLANA_USDT_STREAM_KEY,
    SOLANA_USDC_STREAM_KEY,
    SUI_EVENTS_STREAM_KEY,
  ];
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
        SUI_EVENTS_STREAM_KEY,
        ">",
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
          } else if (streamKey === SUI_EVENTS_STREAM_KEY) {
            const event = {
              checkpoint: Number(data.checkpoint),
              txDigest: data.txDigest,
              eventSeq: Number(data.eventSeq),
              type: data.type,
              packageId: data.packageId,
              module: data.module,
              sender: data.sender,
              json: data.json,
              timestamp: Number(data.timestamp) || Date.now(),
              uid: data.uid,
              eventId: id,
            };
            io.emit("newSuiEvent", event);
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
