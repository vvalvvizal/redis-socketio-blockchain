import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";
import WebSocket from "ws";
import SolanaSlotSubscriber from "./solanaRPCSubscriber.js";
import SolanaWsManager from "./solanaWsManager.js";
//import SolanaBlockSubscriber from "./solanaBlockSubscriber.js";

dotenv.config();

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const POLYGON_WS_URL = process.env.POLYGON_WS_URL;
// Polygon logs/events collection (optional; keep config minimal)
// If neither is set, we won't collect polygon logs.
const POLYGON_LOGS_ADDRESS = process.env.POLYGON_LOGS_ADDRESS || "";
const POLYGON_LOGS_TOPIC0 = process.env.POLYGON_LOGS_TOPIC0 || "";
const POLYGON_DEBUG_WS =
  String(process.env.POLYGON_DEBUG_WS || "false").toLowerCase() === "true";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SOLANA_WS_URL = process.env.SOLANA_WS_URL;
const SUI_GRAPHQL_URL =
  process.env.SUI_GRAPHQL_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = createClient({ url: REDIS_URL });
await redis.connect();

// Redis Stream 설정
const BLOCKS_STREAM_KEY = process.env.BLOCKS_STREAM_KEY || "blocks:stream";
const STREAM_MAXLEN = Number(process.env.BLOCKS_STREAM_MAXLEN || 10000);
const SOLANA_RECONCILE_INTERVAL = Number(
  process.env.SOLANA_RECONCILE_INTERVAL || 5000
);

// Keep env surface minimal:
// - SOLANA_WS_SINGLE_CONN=true  -> single WS connection for slot+logs
// - SOLANA_BLOCKSUB_MENTIONS=... (optional) -> reused as logsSubscribe mentions filter (comma-separated allowed)
const SOLANA_WS_SINGLE_CONN =
  String(process.env.SOLANA_WS_SINGLE_CONN || "false").toLowerCase() === "true";
const SOLANA_ENABLE_TOKEN_BLOCKSUB = String(process.env.SOLANA_ENABLE_TOKEN_BLOCKSUB || "false").toLowerCase() === "true";
//const SOLANA_USDT_MINT = process.env.SOLANA_USDT_MINT; // base58 mint address
//const SOLANA_USDT_STREAM_KEY = process.env.SOLANA_USDT_STREAM_KEY || "solana:usdt:transfers";
//const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT; // base58 mint address
//const SOLANA_USDC_STREAM_KEY = process.env.SOLANA_USDC_STREAM_KEY || "solana:usdc:transfers";
const SUI_EVENTS_STREAM_KEY = process.env.SUI_EVENTS_STREAM_KEY || "sui:events";
const SUI_EVENTS_PAGE_SIZE = Number(process.env.SUI_EVENTS_PAGE_SIZE || 50);
const SUI_EVENTS_MAX_PAGES_PER_TICK = Number(process.env.SUI_EVENTS_MAX_PAGES_PER_TICK || 5);
const SUI_EVENTS_START_FROM_LATEST =
  String(process.env.SUI_EVENTS_START_FROM_LATEST || "true").toLowerCase() === "true";
const SUI_EVENT_JSON_MAXLEN = Number(process.env.SUI_EVENT_JSON_MAXLEN || 2000);
const SOLANA_TOKEN_PROGRAM_ID =
  process.env.SOLANA_TOKEN_PROGRAM_ID || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_BLOCKSUB_MENTIONS =
  process.env.SOLANA_BLOCKSUB_MENTIONS || SOLANA_TOKEN_PROGRAM_ID; // program or account pubkey (base58)
const SOLANA_BLOCKSUB_COMMITMENT = process.env.SOLANA_BLOCKSUB_COMMITMENT || "finalized";

function asPubkeyString(k) {
  if (!k) return null;
  if (typeof k === "string") return k;
  if (typeof k?.pubkey === "string") return k.pubkey;
  return null;
}

function extractTokenTransfersFromTx(tx, { tokenProgramId, targetMint }) {
  const out = [];
  const meta = tx?.meta;
  const message = tx?.transaction?.message;
  const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];

  // token account -> mint mapping from pre/post balances
  const tokenBalances = [
    ...(Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : []),
    ...(Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : []),
  ];
  const tokenAccountToMint = new Map();
  for (const b of tokenBalances) {
    const idx = b?.accountIndex;
    const mint = b?.mint;
    if (typeof idx !== "number" || typeof mint !== "string") continue;
    const pk = asPubkeyString(accountKeys[idx]);
    if (!pk) continue;
    if (!tokenAccountToMint.has(pk)) tokenAccountToMint.set(pk, mint);
  }

  const collectFromInstructions = (instructions, isInner) => {
    if (!Array.isArray(instructions)) return;
    for (const ix of instructions) {
      // jsonParsed: { programId, parsed: { type, info } }
      const programId = ix?.programId || ix?.programIdIndex; // programIdIndex for non-parsed
      const parsed = ix?.parsed;
      const type = parsed?.type;
      const info = parsed?.info;

      // When encoding=jsonParsed, programId is usually base58 string
      if (typeof programId === "string" && programId !== tokenProgramId) continue;
      if (!parsed || typeof type !== "string" || !info) continue;

      if (type !== "transfer" && type !== "transferChecked") continue;

      const source = info?.source;
      const destination = info?.destination;
      const authority = info?.authority;
      const amountRaw = info?.amount; // string for transfer, or string for transferChecked (uiAmountString sometimes)
      const mint = info?.mint || tokenAccountToMint.get(source) || tokenAccountToMint.get(destination) || null;

      if (!source || !destination) continue;
      if (targetMint && mint !== targetMint) continue;

      out.push({
        signature: Array.isArray(tx?.transaction?.signatures) ? tx.transaction.signatures[0] : undefined,
        slot: meta?.slot,
        source,
        destination,
        authority,
        amount: amountRaw != null ? String(amountRaw) : null,
        mint,
        isInner: Boolean(isInner),
      });
    }
  };

  // top-level instructions
  collectFromInstructions(message?.instructions, false);

  // inner instructions (CPI)
  const inner = Array.isArray(meta?.innerInstructions) ? meta.innerInstructions : [];
  for (const ii of inner) {
    collectFromInstructions(ii?.instructions, true);
  }

  return out;
}

async function xaddUsdtTransferEvent(event) {
  // Store transfer events in a dedicated stream (separate from blocks:stream)
  await redis.sendCommand([
    "XADD",
    SOLANA_USDT_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Solana USDT Transfer",
    "slot",
    String(event.slot ?? ""),
    "signature",
    String(event.signature ?? ""),
    "source",
    String(event.source ?? ""),
    "destination",
    String(event.destination ?? ""),
    "authority",
    String(event.authority ?? ""),
    "mint",
    String(event.mint ?? ""),
    "amount",
    String(event.amount ?? ""),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}

async function xaddUsdcTransferEvent(event) {
  await redis.sendCommand([
    "XADD",
    SOLANA_USDC_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Solana USDC Transfer",
    "slot",
    String(event.slot ?? ""),
    "signature",
    String(event.signature ?? ""),
    "source",
    String(event.source ?? ""),
    "destination",
    String(event.destination ?? ""),
    "authority",
    String(event.authority ?? ""),
    "mint",
    String(event.mint ?? ""),
    "amount",
    String(event.amount ?? ""),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}


async function rpcHttpCall(rpcUrl, method, params = []) {
  if (!rpcUrl) throw new Error(`RPC url is not set for method=${method}`);

  const { data } = await axios.post(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  if (data?.error) {
    const msg = data.error?.message || JSON.stringify(data.error);
    throw new Error(`RPC error method=${method}: ${msg}`);
  }

  return data?.result;
}



async function xaddBlockEvent(event) {
  // XADD <stream> MAXLEN ~ <N> * field value ...
  // node-redis 버전별 옵션 차이를 피하려고 sendCommand 사용
  await redis.sendCommand([
    "XADD",//스트림 추가 명령어
    BLOCKS_STREAM_KEY,
    "MAXLEN",//최대길이
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    String(event.network),
    "blockNumber",
    String(event.blockNumber),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}

async function xaddSuiEvent(event) {
  // Store Sui Move events in a dedicated stream
  await redis.sendCommand([
    "XADD",
    SUI_EVENTS_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Sui Testnet",
    "checkpoint",
    String(event.checkpoint ?? ""),
    "txDigest",
    String(event.txDigest ?? ""),
    "eventSeq",
    String(event.eventSeq ?? ""),
    "type",
    String(event.type ?? ""),
    "packageId",
    String(event.packageId ?? ""),
    "module",
    String(event.module ?? ""),
    "sender",
    String(event.sender ?? ""),
    "json",
    String(event.json ?? ""),
    "timestamp",
    String(event.timestamp ?? Date.now()),
    "uid",
    String(event.uid ?? ""),
  ]);
}

function parseCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function xaddSolanaLogEvent(event) {
  // Store Solana log notifications in a dedicated stream
  // NOTE: intentionally avoiding env vars here to keep config simple.
  const SOLANA_LOGS_STREAM_KEY = "solana:logs";
  const MAX_LOGS_PER_EVENT = 50;
  const logsArr = Array.isArray(event.logs) ? event.logs : [];
  const logsTrimmed = logsArr.slice(0, MAX_LOGS_PER_EVENT);

  await redis.sendCommand([
    "XADD",
    SOLANA_LOGS_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Solana Devnet",
    "slot",
    String(event.slot ?? ""),
    "signature",
    String(event.signature ?? ""),
    "err",
    safeJsonStringify(event.err, 500),
    "logs",
    safeJsonStringify(logsTrimmed, 4000),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}

async function suiGraphql(query, variables) {
  if (!SUI_GRAPHQL_URL) throw new Error("SUI_GRAPHQL_URL is not set");
  const res = await axios.post(
    SUI_GRAPHQL_URL,
    { query, variables },
    { headers: { "Content-Type": "application/json" } }
  );
  if (res?.data?.errors?.length) {
    const msg = res.data.errors?.[0]?.message || JSON.stringify(res.data.errors);
    throw new Error(`Sui GraphQL error: ${msg}`);
  }
  return res?.data?.data;
}

function safeJsonStringify(v, maxLen) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (!s) return "";
    if (typeof maxLen === "number" && Number.isFinite(maxLen) && s.length > maxLen) {
      return s.slice(0, Math.max(0, maxLen)) + "...(truncated)";
    }
    return s;
  } catch {
    return "";
  }
}

// 네트워크별 폴링 간격 (밀리초)
const POLYGON_POLL_INTERVAL = Number(process.env.POLYGON_POLL_INTERVAL);
const SUI_POLL_INTERVAL = Number(process.env.SUI_POLL_INTERVAL); 

const POLYGON_LOGS_STREAM_KEY = "polygon:events";
const POLYGON_LAST_LOG_BLOCK_KEY = "polygon:lastLogBlock";

function shouldCollectPolygonLogs() {
  return Boolean(String(POLYGON_LOGS_ADDRESS || "").trim()) || Boolean(String(POLYGON_LOGS_TOPIC0 || "").trim());
}

// Polygon WS runtime state (used to decide whether to backfill logs via HTTP)
const polygonWsState = {
  connected: false,
  logsSubscribed: false,
};

async function xaddPolygonLogEvent(event) {
  await redis.sendCommand([
    "XADD",
    POLYGON_LOGS_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    polygonNetworkLabel(),
    "blockNumber",
    String(event.blockNumber ?? ""),
    "txHash",
    String(event.txHash ?? ""),
    "logIndex",
    String(event.logIndex ?? ""),
    "address",
    String(event.address ?? ""),
    "topics",
    safeJsonStringify(event.topics ?? [], 2000),
    "data",
    String(event.data ?? ""),
    "removed",
    String(event.removed ? "true" : "false"),
    "timestamp",
    String(event.timestamp ?? Date.now()),
    "uid",
    String(event.uid ?? ""),
  ]);
}

async function fetchPolygonLogsForBlock(blockNumber) {
  // eth_getLogs expects hex block numbers
  const fromBlock = `0x${Number(blockNumber).toString(16)}`;
  const toBlock = fromBlock;
  const filter = { fromBlock, toBlock };
  if (String(POLYGON_LOGS_ADDRESS || "").trim()) filter.address = String(POLYGON_LOGS_ADDRESS).trim();
  if (String(POLYGON_LOGS_TOPIC0 || "").trim()) filter.topics = [String(POLYGON_LOGS_TOPIC0).trim()];

  const logs = await rpcHttpCall(POLYGON_RPC_URL, "eth_getLogs", [filter]);
  return Array.isArray(logs) ? logs : [];
}

async function catchUpPolygonLogsTo(targetBlockNumber, timestampMs) {
  if (!shouldCollectPolygonLogs()) return;
  if (!Number.isFinite(targetBlockNumber) || targetBlockNumber <= 0) return;

  const latest = Number(targetBlockNumber);
  const lastStr = await redis.get(POLYGON_LAST_LOG_BLOCK_KEY);

  // First run: start from latest (avoid massive backfill by default)
  if (!lastStr) {
    await redis.set(POLYGON_LAST_LOG_BLOCK_KEY, String(latest));
    return;
  }

  let last = Number(lastStr);
  if (!Number.isFinite(last) || last < 0) last = latest;
  if (last >= latest) return;

  for (let b = last + 1; b <= latest; b += 1) {
    let logs = [];
    try {
      logs = await fetchPolygonLogsForBlock(b);
    } catch (e) {
      console.error("❌ [Polygon][logs] eth_getLogs error:", e?.message || e);
      break;
    }

    for (const l of logs) {
      const bn = typeof l?.blockNumber === "string" ? parseInt(l.blockNumber, 16) : b;
      const li = typeof l?.logIndex === "string" ? parseInt(l.logIndex, 16) : null;
      const txHash = l?.transactionHash || "";
      const uid = `${bn}:${txHash}:${li ?? ""}`;

      await xaddPolygonLogEvent({
        blockNumber: bn,
        txHash,
        logIndex: li,
        address: l?.address || "",
        topics: Array.isArray(l?.topics) ? l.topics : [],
        data: l?.data || "",
        removed: Boolean(l?.removed),
        // Only the head block has an accurate timestamp readily available; others use recv time.
        timestamp: b === latest ? timestampMs : Date.now(),
        uid,
      });
    }

    await redis.set(POLYGON_LAST_LOG_BLOCK_KEY, String(b));
  }
}

async function handlePolygonNewBlock(blockNumber, timestampMs, source) {
  const lastKey = "lastBlock:polygon";
  const last = await redis.get(lastKey);
  if (last && Number(last) === blockNumber) return;

  await redis.set(lastKey, String(blockNumber));
  await xaddBlockEvent({
    network: polygonNetworkLabel(),
    blockNumber,
    timestamp: timestampMs ?? Date.now(),
  });
  await catchUpPolygonLogsTo(blockNumber, timestampMs ?? Date.now());
  if (source) {
    // lightweight trace
    // console.log(`🧩 [Polygon][${source}] handled block=${blockNumber}`);
  }
}

async function pollPolygonBlock() {
  try {
    // 1. 최신 블록 번호 가져오기
    const blockNumberHex = await rpcHttpCall(POLYGON_RPC_URL, "eth_blockNumber", []);
    if (!blockNumberHex) return;
    const blockNumber = parseInt(String(blockNumberHex), 16);

    const blockInfo = await rpcHttpCall(POLYGON_RPC_URL, "eth_getBlockByNumber", [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);

    const blockTimestamp = parseInt(String(blockInfo?.timestamp), 16) * 1000; // 초 → 밀리초
    console.log("🔹 [Polygon] Latest block:", blockNumber, "timestamp:", blockTimestamp);

    await handlePolygonNewBlock(blockNumber, blockTimestamp, "poll");
  } catch (error) {
    console.error("❌ [Polygon] Error:", error?.message || error);
  }
}

function polygonNetworkLabel() {
  const u = String(POLYGON_WS_URL || POLYGON_RPC_URL || "");
  if (u.toLowerCase().includes("amoy")) return "Polygon Amoy";
  if (u.toLowerCase().includes("mainnet")) return "Polygon Mainnet";
  return "Polygon";
}

function startPolygonWsSubscription() {
  if (!POLYGON_WS_URL) throw new Error("POLYGON_WS_URL is not set");

  let ws = null;
  let reconnectTimer = null;
  let subscribeAckTimer = null;
  let subscribed = false;
  let reqId = Math.floor(Date.now() % 1_000_000_000);
  let subscribeAttempts = 0;
  const reqIdToKind = new Map(); // id -> 'heads' | 'logs'
  let ackCount = 0;
  let expectedAcks = 1;

  const scheduleReconnect = (reason) => {
    if (reconnectTimer) return;
    if (subscribeAckTimer) {
      clearTimeout(subscribeAckTimer);
      subscribeAckTimer = null;
    }
    polygonWsState.connected = false;
    polygonWsState.logsSubscribed = false;
    console.error("❌ [Polygon][ws] disconnected:", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      start();
    }, 1000);
  };

  const start = () => {
    subscribed = false;
    subscribeAttempts = 0;
    reqId = Math.floor(Date.now() % 1_000_000_000);
    ackCount = 0;
    reqIdToKind.clear();
    expectedAcks = 1 + (shouldCollectPolygonLogs() ? 1 : 0);
    ws = new WebSocket(POLYGON_WS_URL);

    ws.on("open", () => {
      polygonWsState.connected = true;
      polygonWsState.logsSubscribed = false;
      console.log("✅ [Polygon][ws] connected");

      const sendSubscribe = () => {
        subscribeAttempts += 1;
        ackCount = 0;
        reqIdToKind.clear();

        if (subscribeAckTimer) clearTimeout(subscribeAckTimer);
        subscribeAckTimer = setTimeout(() => {
          if (subscribed) return;
          if (subscribeAttempts < 3) {
            console.error(
              `❌ [Polygon][ws] subscribe ACK timeout (attempt ${subscribeAttempts}). Retrying...`
            );
            sendSubscribe();
            return;
          }
          console.error("❌ [Polygon][ws] failed after retries. Reconnecting...");
          try {
            ws?.terminate?.();
          } catch {
            try {
              ws?.close?.();
            } catch {}
          }
        }, 15000);

        // newHeads subscribe
        reqId += 1;
        const headsId = reqId;
        reqIdToKind.set(headsId, "heads");
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: headsId,
            method: "eth_subscribe",
            params: ["newHeads"],
          })
        );

        // logs subscribe (optional) - same WS connection
        polygonWsState.logsSubscribed = false;
        if (shouldCollectPolygonLogs()) {
          const filter = {};
          if (String(POLYGON_LOGS_ADDRESS || "").trim()) filter.address = String(POLYGON_LOGS_ADDRESS).trim();
          if (String(POLYGON_LOGS_TOPIC0 || "").trim()) filter.topics = [String(POLYGON_LOGS_TOPIC0).trim()];

          reqId += 1;
          const logsId = reqId;
          reqIdToKind.set(logsId, "logs");
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: logsId,
              method: "eth_subscribe",
              params: ["logs", filter],
            })
          );
        }
      };

      sendSubscribe();
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // subscribe ACK: { id, result: <subscriptionId> }
      if (typeof msg?.id === "number" && Object.prototype.hasOwnProperty.call(msg, "result")) {
        ackCount += 1;
        const kind = reqIdToKind.get(msg.id) || "unknown";
        if (kind === "logs") polygonWsState.logsSubscribed = true;

        if (ackCount >= expectedAcks) {
          subscribed = true;
          if (subscribeAckTimer) {
            clearTimeout(subscribeAckTimer);
            subscribeAckTimer = null;
          }
        }
        console.log(`✅ [Polygon][ws] subscribed (${kind}):`, msg.result);
        return;
      }

      if (msg?.error) {
        console.error("❌ [Polygon][ws] error message:", msg.error);
        return;
      }

      // Notification: { method: "eth_subscription", params: { result: ... } }
      if (msg?.method === "eth_subscription") {
        const result = msg?.params?.result;

        // 1) newHeads notification
        if (result && typeof result === "object" && typeof result.number === "string") {
          const numHex = result.number;
          const tsHex = result.timestamp;
          const blockNumber = parseInt(numHex, 16);
          if (!Number.isFinite(blockNumber)) return;

          const blockTimestamp =
            typeof tsHex === "string" ? parseInt(tsHex, 16) * 1000 : Date.now();

          console.log("🔹 [Polygon][ws] New head:", blockNumber, "timestamp:", blockTimestamp);
          await handlePolygonNewBlock(blockNumber, blockTimestamp, "ws");
          return;
        }

        // 2) logs notification
        if (result && typeof result === "object" && Array.isArray(result.topics)) {
          const bn =
            typeof result.blockNumber === "string"
              ? parseInt(result.blockNumber, 16)
              : null;
          const li =
            typeof result.logIndex === "string"
              ? parseInt(result.logIndex, 16)
              : null;
          const txHash = result.transactionHash || "";
          const uid = `${bn ?? ""}:${txHash}:${li ?? ""}`;

          await xaddPolygonLogEvent({
            blockNumber: bn,
            txHash,
            logIndex: li,
            address: result.address || "",
            topics: result.topics,
            data: result.data || "",
            removed: Boolean(result.removed),
            timestamp: Date.now(),
            uid,
          });

          if (POLYGON_DEBUG_WS) {
            const t0 = Array.isArray(result.topics) && result.topics.length ? result.topics[0] : "";
            console.log(
              "🪵 [Polygon][ws][log]",
              `block=${bn ?? "?"}`,
              `tx=${String(txHash).slice(0, 12)}...`,
              `idx=${li ?? "?"}`,
              `addr=${String(result.address || "").slice(0, 12)}...`,
              `topic0=${String(t0).slice(0, 12)}...`,
              `removed=${Boolean(result.removed)}`
            );
          }

          // Advance lastLogBlock cursor as we receive logs (best-effort).
          if (Number.isFinite(bn)) {
            const lastStr = await redis.get(POLYGON_LAST_LOG_BLOCK_KEY);
            const last = Number(lastStr);
            if (!lastStr || (Number.isFinite(last) && bn > last)) {
              await redis.set(POLYGON_LAST_LOG_BLOCK_KEY, String(bn));
            }
          }
        }
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      scheduleReconnect(`${res?.statusCode} ${res?.statusMessage || ""}`.trim());
    });
    ws.on("error", (err) => scheduleReconnect(err?.message || err));
    ws.on("close", (code, reason) =>
      scheduleReconnect(`${code} ${reason?.toString?.() || ""}`.trim())
    );
  };

  start();
}

// Sui (GraphQL RPC) 체크포인트 폴링
async function pollSuiCheckpoint() {
  try {
    // 최신 체크포인트: query { checkpoint { sequenceNumber } }
    // ref: https://docs.sui.io/concepts/data-access/graphql-rpc
    const res = await axios.post(
      SUI_GRAPHQL_URL,
      {
        query: "query { checkpoint { sequenceNumber } }",
      },
      { headers: { "Content-Type": "application/json" } }
    );
    const seqStr = res?.data?.data?.checkpoint?.sequenceNumber;
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      throw new Error(`Invalid checkpoint sequenceNumber: ${seqStr}`);
    }

    const lastKey = "lastBlock:sui";
    const last = await redis.get(lastKey);
    if (last && Number(last) === seq) return;

    const ts = Date.now();
    console.log("🔹 [Sui] Latest checkpoint:", seq, "recvTimestamp:", ts);

    await redis.set(lastKey, String(seq));
    await xaddBlockEvent({
      network: "Sui Testnet",
      blockNumber: seq,
      timestamp: ts,
    });
  } catch (error) {
    console.error("❌ [Sui] Error:", error?.message || error);
  }
}

// Sui (GraphQL RPC) 이벤트 폴링 (cursor 기반)
async function pollSuiEvents() {
  try {
    const cursorKey = "sui:lastEventCursor";
    let cursor = await redis.get(cursorKey);

    // 최초 실행 시, 과거 전체 이벤트를 쓸어오지 않도록 "최신부터" 시작하게 할 수 있음
    if (!cursor && SUI_EVENTS_START_FROM_LATEST) {
      try {
        const data = await suiGraphql(
          "query { events(last: 1) { pageInfo { endCursor } } }",
          {}
        );
        const endCursor = data?.events?.pageInfo?.endCursor;
        if (typeof endCursor === "string" && endCursor.length > 0) {
          await redis.set(cursorKey, endCursor);
          return;
        }
      } catch (e) {
        // 스키마가 last를 지원하지 않으면, 그냥 처음부터(또는 after=null) 소량만 가져오도록 진행
        console.error("❌ [Sui][events] init-from-latest failed:", e?.message || e);
      }
    }

    const query = `
      query ($first: Int!, $after: String) {
        events(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            sequenceNumber
            timestamp
            sender { address }
            transaction { digest }
            transactionModule { name package { digest } }
            contents { type { repr } json }
          }
        }
      }
    `;

    const first = Number.isFinite(SUI_EVENTS_PAGE_SIZE) ? SUI_EVENTS_PAGE_SIZE : 50;
    const maxPages =
      Number.isFinite(SUI_EVENTS_MAX_PAGES_PER_TICK) ? SUI_EVENTS_MAX_PAGES_PER_TICK : 5;

    let pages = 0;
    while (pages < maxPages) {
      pages += 1;
      const data = await suiGraphql(query, {
        first,
        after: cursor || null,
      });

      const nodes = data?.events?.nodes || [];
      const pageInfo = data?.events?.pageInfo;
      const endCursor = pageInfo?.endCursor;
      const hasNextPage = Boolean(pageInfo?.hasNextPage);

      for (const n of nodes) {
        const txDigest = n?.transaction?.digest;
        const eventSeq = n?.sequenceNumber;
        const uid = txDigest && eventSeq != null ? `${txDigest}:${eventSeq}` : "";

        const checkpoint = undefined;
        const sender = n?.sender?.address;
        const moduleName = n?.transactionModule?.name;
        const packageId = n?.transactionModule?.package?.digest;

        const type = n?.contents?.type?.repr;
        const json = safeJsonStringify(n?.contents?.json, SUI_EVENT_JSON_MAXLEN);

        const tsNum = Number(n?.timestamp);
        const ts = Number.isFinite(tsNum) ? tsNum : Date.now();

        await xaddSuiEvent({
          checkpoint,
          txDigest,
          eventSeq,
          type,
          packageId,
          module: moduleName,
          sender,
          json,
          timestamp: ts,
          uid,
        });
      }

      if (typeof endCursor === "string" && endCursor.length > 0) {
        cursor = endCursor;
        await redis.set(cursorKey, cursor);
      }

      if (!hasNextPage) break;
      if (!nodes.length) break;
    }
  } catch (error) {
    console.error("❌ [Sui][events] Error:", error?.message || error);
  }
}

// Solana Devnet: WebSocket 구독으로 슬롯 이벤트 수신 (HTTP 폴링 제거)
const SOLANA_LAST_KEY = "lastBlock:solana";
let lastSolanaSlot = Number((await redis.get(SOLANA_LAST_KEY)) || 0);
//마지막으로 받은 Solana 슬롯 번호를 저장


function startSolanaSlotSubscription() {
  const subscriber = new SolanaSlotSubscriber({
    wsUrl: SOLANA_WS_URL,
    rpcUrl: SOLANA_RPC_URL,
    reconcileIntervalMs: SOLANA_RECONCILE_INTERVAL,
    rpcHttpCall,
    getLastSlot: () => lastSolanaSlot,
    setLastSlot: (slot) => {
      lastSolanaSlot = slot;
    },
    onSlot: async (slot, ts) => {
      // at-least-once 보장(중복 가능, 누락 방지)
      await xaddBlockEvent({
        network: "Solana Devnet",
        blockNumber: slot,
        timestamp: ts ?? Date.now(),
      });
      await redis.set(SOLANA_LAST_KEY, String(slot));
    },
  });

  subscriber.start();
}

function startSolanaSingleWsSubscriptions() {
  const mentions = parseCsv(SOLANA_BLOCKSUB_MENTIONS);
  const mgr = new SolanaWsManager({
    wsUrl: SOLANA_WS_URL,
    rpcUrl: SOLANA_RPC_URL,
    reconcileIntervalMs: SOLANA_RECONCILE_INTERVAL,
    rpcHttpCall,
    getLastSlot: () => lastSolanaSlot,
    setLastSlot: (slot) => {
      lastSolanaSlot = slot;
    },
    onSlot: async (slot, ts) => {
      await xaddBlockEvent({
        network: "Solana Devnet",
        blockNumber: slot,
        timestamp: ts ?? Date.now(),
      });
      await redis.set(SOLANA_LAST_KEY, String(slot));
    },
    logsMentions: mentions,
    logsCommitment: SOLANA_BLOCKSUB_COMMITMENT,
    debugRaw: false,
    onLogs: async ({ slot, signature, err, logs, recvTimestamp }) => {
      await xaddSolanaLogEvent({
        slot: slot ?? "",
        signature,
        err,
        logs,
        timestamp: recvTimestamp,
      });
    },
  });

  mgr.start();
}

// function startSolanaUsdtBlockSubscription() {
//   if (!SOLANA_ENABLE_TOKEN_BLOCKSUB) return;
//   if (!SOLANA_WS_URL) {
//     console.error("❌ [Solana][blockSubscribe] SOLANA_WS_URL is not set");
//     return;
//   }
//   if (!SOLANA_USDT_MINT) {
//     console.error("❌ [Solana][blockSubscribe] SOLANA_USDT_MINT is not set (base58 mint address)");
//     return;
//   }

//   const subscriber = new SolanaBlockSubscriber({
//     wsUrl: SOLANA_WS_URL,
//     subscriptions: [
//       {
//         name: "USDT",
//         mentionsAccountOrProgram: SOLANA_BLOCKSUB_MENTIONS,
//         onBlockNotification: async (msg) => {
//           const value = msg?.params?.result?.value;
//           const slot = value?.slot;
//           const block = value?.block;
//           const blockTime = block?.blockTime ? Number(block.blockTime) * 1000 : Date.now();
//           const txs = Array.isArray(block?.transactions) ? block.transactions : [];

//           let transferCount = 0;
//           for (const tx of txs) {
//             const transfers = extractTokenTransfersFromTx(tx, {
//               tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
//               targetMint: SOLANA_USDT_MINT,
//             });
//             for (const t of transfers) {
//               transferCount += 1;
//               await xaddUsdtTransferEvent({
//                 ...t,
//                 slot: typeof slot === "number" ? slot : undefined,
//                 timestamp: blockTime,
//               });
//             }
//           }

//           if (transferCount > 0) {
//             console.log(
//               `🧾 [Solana][USDT] transfers in slot=${slot}: ${transferCount} (stream=${SOLANA_USDT_STREAM_KEY})`
//             );
//           }
//         },
//       },
//       ...(SOLANA_USDC_MINT
//         ? [
//             {
//               name: "USDC",
//               mentionsAccountOrProgram: SOLANA_BLOCKSUB_MENTIONS,
//               onBlockNotification: async (msg) => {
//                 const value = msg?.params?.result?.value;
//                 const slot = value?.slot;
//                 const block = value?.block;
//                 const blockTime = block?.blockTime ? Number(block.blockTime) * 1000 : Date.now();
//                 const txs = Array.isArray(block?.transactions) ? block.transactions : [];

//                 let transferCount = 0;
//                 for (const tx of txs) {
//                   const transfers = extractTokenTransfersFromTx(tx, {
//                     tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
//                     targetMint: SOLANA_USDC_MINT,
//                   });
//                   for (const t of transfers) {
//                     transferCount += 1;
//                     await xaddUsdcTransferEvent({
//                       ...t,
//                       slot: typeof slot === "number" ? slot : undefined,
//                       timestamp: blockTime,
//                     });
//                   }
//                 }

//                 if (transferCount > 0) {
//                   console.log(
//                     `🧾 [Solana][USDC] transfers in slot=${slot}: ${transferCount} (stream=${SOLANA_USDC_STREAM_KEY})`
//                   );
//                 }
//               },
//             },
//           ]
//         : []),
//     ],
//     commitment: SOLANA_BLOCKSUB_COMMITMENT,
//     encoding: "jsonParsed",
//     transactionDetails: "full",
//     showRewards: false,
//     maxSupportedTransactionVersion: 0,
//   });

//   subscriber.start();
// }

// 각 네트워크를 독립적으로 폴링 (다른 간격으로)
// 즉시 한 번 실행 (Polygon은 polling 유지 + WS는 옵션으로 추가)
pollPolygonBlock();
if (POLYGON_WS_URL) startPolygonWsSubscription();
pollSuiCheckpoint();
pollSuiEvents();
if (SOLANA_WS_SINGLE_CONN) {
  startSolanaSingleWsSubscriptions();
} else {
  startSolanaSlotSubscription();
}
//startSolanaUsdtBlockSubscription();
 
setInterval(pollPolygonBlock, POLYGON_POLL_INTERVAL);

setInterval(pollSuiCheckpoint, SUI_POLL_INTERVAL);
setInterval(pollSuiEvents, SUI_POLL_INTERVAL);