/**
 * Polygon: 블록 + 이벤트 수집 (HTTP 폴링 + WS newHeads/logs)
 * 블록 → blocks:stream, 로그 → polygon:events. env 없으면 no-op.
 */

import WebSocket from "ws";
import * as polygonEvents from "./polygonEvents.js";

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const POLYGON_WS_URL = process.env.POLYGON_WS_URL;
const POLYGON_POLL_INTERVAL = Number(process.env.POLYGON_POLL_INTERVAL);
const POLYGON_LOGS_ADDRESS = process.env.POLYGON_LOGS_ADDRESS || "";
const POLYGON_LOGS_TOPIC0 = process.env.POLYGON_LOGS_TOPIC0 || "";
const LAST_BLOCK_KEY = "lastBlock:polygon";

export function getNetworkLabel() {
  const u = String(POLYGON_WS_URL || POLYGON_RPC_URL || "");
  if (u.toLowerCase().includes("amoy")) return "Polygon Amoy";
  if (u.toLowerCase().includes("mainnet")) return "Polygon Mainnet";
  return "Polygon";
}

export async function handlePolygonNewBlock(blockNumber, timestampMs, source, redis, deps) {
  const last = await redis.get(LAST_BLOCK_KEY);
  if (last && Number(last) === blockNumber) return;

  await redis.set(LAST_BLOCK_KEY, String(blockNumber));
  await deps.xaddBlockEvent({
    network: getNetworkLabel(),
    blockNumber,
    timestamp: timestampMs ?? Date.now(),
  });
}

export async function pollPolygonBlock(redis, deps) {
  if (!POLYGON_RPC_URL) return;
  try {
    const blockNumberHex = await deps.rpcHttpCall(POLYGON_RPC_URL, "eth_blockNumber", []);
    if (!blockNumberHex) return;
    const blockNumber = parseInt(String(blockNumberHex), 16);

    const blockInfo = await deps.rpcHttpCall(POLYGON_RPC_URL, "eth_getBlockByNumber", [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);

    const blockTimestamp = parseInt(String(blockInfo?.timestamp), 16) * 1000;
    console.log("🔹 [Polygon] Latest block:", blockNumber, "timestamp:", blockTimestamp);

    await handlePolygonNewBlock(blockNumber, blockTimestamp, "poll", redis, deps);
  } catch (error) {
    console.error("❌ [Polygon] Error:", error?.message || error);
  }
}

function startBlocks(redis, deps) {
  pollPolygonBlock(redis, deps);
  if (Number.isFinite(POLYGON_POLL_INTERVAL) && POLYGON_POLL_INTERVAL > 0) {
    setInterval(() => pollPolygonBlock(redis, deps), POLYGON_POLL_INTERVAL);
  }
}

/** 체인 진입점: 블록(HTTP+WS) + 이벤트(WS logs). env 없으면 no-op */
export function start(redis, deps) {
  if (!POLYGON_RPC_URL) return;
  startBlocks(redis, deps);
  if (POLYGON_WS_URL) {
    startWs(redis, deps, {
      onBlock: async (blockNumber, blockTimestamp) => {
        await handlePolygonNewBlock(blockNumber, blockTimestamp, "ws", redis, deps);
        await polygonEvents.catchUpPolygonLogsTo(blockNumber, blockTimestamp, redis, deps);
      },
      onLog: (result) => polygonEvents.handlePolygonLog(result, redis, deps),
      shouldCollectLogs: () => polygonEvents.shouldCollectPolygonLogs(),
      wsState: polygonEvents.polygonWsState,
    });
  }
}

function startWs(redis, deps, callbacks) {
  if (!POLYGON_WS_URL) return;
  const { onBlock, onLog, shouldCollectLogs, wsState } = callbacks;
  const expectedAcks = 1 + (shouldCollectLogs() ? 1 : 0);

  let ws = null;
  let reconnectTimer = null;
  let subscribeAckTimer = null;
  let subscribed = false;
  let reqId = Math.floor(Date.now() % 1_000_000_000);
  let subscribeAttempts = 0;
  const reqIdToKind = new Map();
  let ackCount = 0;

  const scheduleReconnect = (reason) => {
    if (reconnectTimer) return;
    if (subscribeAckTimer) {
      clearTimeout(subscribeAckTimer);
      subscribeAckTimer = null;
    }
    wsState.connected = false;
    wsState.logsSubscribed = false;
    console.error("❌ [Polygon][ws] disconnected:", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  };

  const connect = () => {
    subscribed = false;
    subscribeAttempts = 0;
    reqId = Math.floor(Date.now() % 1_000_000_000);
    ackCount = 0;
    reqIdToKind.clear();
    ws = new WebSocket(POLYGON_WS_URL);

    ws.on("open", () => {
      wsState.connected = true;
      wsState.logsSubscribed = false;
      console.log("✅ [Polygon][ws] connected");

      const sendSubscribe = () => {
        subscribeAttempts += 1;
        ackCount = 0;
        reqIdToKind.clear();

        if (subscribeAckTimer) clearTimeout(subscribeAckTimer);
        subscribeAckTimer = setTimeout(() => {
          if (subscribed) return;
          if (subscribeAttempts < 3) {
            console.error(`❌ [Polygon][ws] subscribe ACK timeout (attempt ${subscribeAttempts}). Retrying...`);
            sendSubscribe();
            return;
          }
          console.error("❌ [Polygon][ws] failed after retries. Reconnecting...");
          try { ws?.terminate?.(); } catch { try { ws?.close?.(); } catch {} }
        }, 15000);

        reqId += 1;
        reqIdToKind.set(reqId, "heads");
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "eth_subscribe", params: ["newHeads"] }));

        wsState.logsSubscribed = false;
        if (shouldCollectLogs()) {
          const filter = {};
          if (String(POLYGON_LOGS_ADDRESS || "").trim()) filter.address = String(POLYGON_LOGS_ADDRESS).trim();
          if (String(POLYGON_LOGS_TOPIC0 || "").trim()) filter.topics = [String(POLYGON_LOGS_TOPIC0).trim()];
          reqId += 1;
          reqIdToKind.set(reqId, "logs");
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "eth_subscribe", params: ["logs", filter] }));
        }
      };

      sendSubscribe();
    });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (typeof msg?.id === "number" && Object.prototype.hasOwnProperty.call(msg, "result")) {
        ackCount += 1;
        const kind = reqIdToKind.get(msg.id) || "unknown";
        if (kind === "logs") wsState.logsSubscribed = true;
        if (ackCount >= expectedAcks) {
          subscribed = true;
          if (subscribeAckTimer) { clearTimeout(subscribeAckTimer); subscribeAckTimer = null; }
        }
        console.log(`✅ [Polygon][ws] subscribed (${kind}):`, msg.result);
        return;
      }

      if (msg?.error) {
        console.error("❌ [Polygon][ws] error message:", msg.error);
        return;
      }

      if (msg?.method === "eth_subscription") {
        const result = msg?.params?.result;

        if (result && typeof result === "object" && typeof result.number === "string") {
          const blockNumber = parseInt(result.number, 16);
          if (!Number.isFinite(blockNumber)) return;
          const blockTimestamp = typeof result.timestamp === "string" ? parseInt(result.timestamp, 16) * 1000 : Date.now();
          console.log("🔹 [Polygon][ws] New head:", blockNumber, "timestamp:", blockTimestamp);
          await onBlock(blockNumber, blockTimestamp);
          return;
        }

        if (result && typeof result === "object" && Array.isArray(result.topics)) {
          await onLog(result);
        }
      }
    });

    ws.on("unexpected-response", (_req, res) => scheduleReconnect(`${res?.statusCode} ${res?.statusMessage || ""}`.trim()));
    ws.on("error", (err) => scheduleReconnect(err?.message || err));
    ws.on("close", (code, reason) => scheduleReconnect(`${code} ${reason?.toString?.() || ""}`.trim()));
  };

  connect();
}
