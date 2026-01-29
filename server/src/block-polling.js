/**
 * 체인별 데이터 소스 정리
 *
 * Polygon
 *   Block (전체): eth_subscribe newHeads
 *   Event:        eth_subscribe logs — USDT Transfer 구독 (POLYGON_LOGS_ADDRESS + POLYGON_LOGS_TOPIC0)
 *
 * Solana
 *   Block (전체): WS slotSubscribe
 *   Event:        WS logsSubscribe — USDT Transfer (SOLANA_BLOCKSUB_MENTIONS = Token program / USDT mint)
 *
 * Sui
 *   Checkpoint:   GraphQL (checkpoint { sequenceNumber })
 *   Event:        GraphQL (events first/after)
 */

import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";
import * as polygon from "./chains/polygon.js";
import * as sui from "./chains/sui.js";
import * as solana from "./chains/solana.js";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = createClient({ url: REDIS_URL });
await redis.connect();

// Redis Stream 설정
const BLOCKS_STREAM_KEY = process.env.BLOCKS_STREAM_KEY || "blocks:stream";
const STREAM_MAXLEN = Number(process.env.BLOCKS_STREAM_MAXLEN || 10000);
const SUI_EVENTS_STREAM_KEY = process.env.SUI_EVENTS_STREAM_KEY || "sui:events";

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

const deps = {
  rpcHttpCall,
  xaddBlockEvent,
  xaddSuiEvent,
  safeJsonStringify,
  streamMaxlen: STREAM_MAXLEN,
  getNetworkLabel: () => polygon.getNetworkLabel(),
}; 

// 체인별 수집기 기동 — 체인당 start(redis, deps), env 없으면 no-op
const chains = [polygon, sui, solana];
chains.forEach((chain) => chain.start(redis, deps));