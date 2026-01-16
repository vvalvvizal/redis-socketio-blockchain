import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
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

// 네트워크별 폴링 간격 (밀리초)
const POLYGON_POLL_INTERVAL = Number(process.env.POLYGON_POLL_INTERVAL);
const SUI_POLL_INTERVAL = Number(process.env.SUI_POLL_INTERVAL); 

console.log("✅ Multi-Network Block Polling started");
console.log(`📍 Polygon RPC: ${POLYGON_RPC_URL} (${POLYGON_POLL_INTERVAL}ms 간격)`);
console.log(`📍 Solana WS: ${SOLANA_WS_URL} (slotSubscribe)`);
console.log(`📍 Sui GraphQL: ${SUI_GRAPHQL_URL} (${SUI_POLL_INTERVAL}ms 간격)`);
console.log(`🧾 Redis Stream: ${BLOCKS_STREAM_KEY} (MAXLEN ~ ${STREAM_MAXLEN})`);

// Polygon Amoy 네트워크 폴링
async function pollPolygonBlock() {
  try {
    // 1. 최신 블록 번호 가져오기
    const blockNumberRes = await axios.post(POLYGON_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });

    const blockNumber = parseInt(blockNumberRes.data.result, 16);

    // 중복 발행 방지 (폴링 주기 동안 같은 블록이면 스킵)
    const lastKey = "lastBlock:polygon";
    const last = await redis.get(lastKey);
    if (last && Number(last) === blockNumber) return;
    
    // 2. 블록 정보 가져오기 (타임스탬프 포함)
    const blockInfoRes = await axios.post(POLYGON_RPC_URL, {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, false],
    });

    const blockTimestamp = parseInt(blockInfoRes.data.result.timestamp, 16) * 1000; // 초 → 밀리초
    console.log("🔹 [Polygon] Latest block:", blockNumber, "timestamp:", blockTimestamp);

    await redis.set(lastKey, String(blockNumber));
    await xaddBlockEvent({
      network: "Polygon Amoy",
      blockNumber: blockNumber,
      timestamp: blockTimestamp,
    });
  } catch (error) {
    console.error("❌ [Polygon] Error:", error.message);
  }
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

// Solana Devnet: WebSocket 구독으로 슬롯 이벤트 수신 (HTTP 폴링 제거)
const SOLANA_LAST_KEY = "lastBlock:solana";
let lastSolanaSlot = Number((await redis.get(SOLANA_LAST_KEY)) || 0);

function startSolanaSlotSubscription() {
  let ws;
  let reconnectTimer = null;
  let subscribed = false;
  let subscribeAckTimer = null;
  let subscribeAttempts = 0;
  let reqId = 1;

  const connect = () => {
    subscribeAttempts = 0;
    reqId = Math.floor(Date.now() % 1_000_000_000);
    ws = new WebSocket(SOLANA_WS_URL);

    ws.on("open", () => {
      subscribed = false;
      console.log("✅ [Solana] WS connected");

      const sendSubscribe = () => {
        subscribeAttempts += 1;
        reqId += 1;
        const currentReqId = reqId;

        if (subscribeAckTimer) clearTimeout(subscribeAckTimer);
        subscribeAckTimer = setTimeout(() => {
          if (subscribed) return;
          if (subscribeAttempts < 3) {
            console.error(
              `❌ [Solana] slotSubscribe ACK timeout (attempt ${subscribeAttempts}). Retrying...`
            );
            sendSubscribe();
            return;
          }

          console.error("❌ [Solana] slotSubscribe failed after retries. Reconnecting...");
          try {
            ws.terminate?.();
          } catch {
            try {
              ws.close?.();
            } catch {}
          }
        }, 15000);

        console.log(
          `➡️  [Solana] slotSubscribe request sent (id=${currentReqId}, attempt=${subscribeAttempts})`
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: currentReqId,
            method: "slotSubscribe",
          })
        );
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

      // 구독 응답
      if (
        typeof msg?.id === "number" &&
        Object.prototype.hasOwnProperty.call(msg, "result") &&
        !subscribed
      ) {
        subscribed = true;
        if (subscribeAckTimer) {
          clearTimeout(subscribeAckTimer);
          subscribeAckTimer = null;
        }
        console.log("✅ [Solana] slotSubscribe OK, subscription id:", msg.result);
        return;
      }

      // 에러 응답 로깅(구독 실패 등)
      if (msg?.error) {
        console.error("❌ [Solana] WS error message:", msg.error);
      }

      // 슬롯 알림
      if (msg?.method === "slotNotification") {
        const slot = msg?.params?.result?.slot;
        if (typeof slot !== "number") return;
        if (slot <= lastSolanaSlot) return;

        lastSolanaSlot = slot;
        const slotTimestamp = Date.now(); // WS 수신 시각(HTTP getBlockTime 요청 제거)
        console.log("🔹 [Solana] New slot:", slot, "recvTimestamp:", slotTimestamp);

        try {
          await redis.set(SOLANA_LAST_KEY, String(slot));
          await xaddBlockEvent({
            network: "Solana Devnet",
            blockNumber: slot,
            timestamp: slotTimestamp,
          });
        } catch (e) {
          console.error("❌ [Solana] Redis Stream write error:", e?.message || e);
        }
      }
    });

    const scheduleReconnect = (reason) => {
      if (reconnectTimer) return;
      if (subscribeAckTimer) {
        clearTimeout(subscribeAckTimer);
        subscribeAckTimer = null;
      }
      console.error("❌ [Solana] WS disconnected:", reason);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1000);
    };

    ws.on("unexpected-response", (_req, res) => {
      console.error("❌ [Solana] WS unexpected response:", res?.statusCode, res?.statusMessage);
    });
    ws.on("error", (err) => scheduleReconnect(err?.message || err));
    ws.on("close", (code, reason) =>
      scheduleReconnect(`${code} ${reason?.toString?.() || ""}`.trim())
    );
  };

  connect();
}

// 각 네트워크를 독립적으로 폴링 (다른 간격으로)
// 즉시 한 번 실행
pollPolygonBlock();
pollSuiCheckpoint();
startSolanaSlotSubscription();
 
setInterval(pollPolygonBlock, POLYGON_POLL_INTERVAL);

setInterval(pollSuiCheckpoint, SUI_POLL_INTERVAL);
