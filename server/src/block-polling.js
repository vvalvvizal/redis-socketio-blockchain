import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = createClient({ url: REDIS_URL });
await redis.connect();

// 네트워크별 폴링 간격 (밀리초)
const POLYGON_POLL_INTERVAL = 5000;  // 5초 (Polygon은 약 2초마다 블록 생성)
const SOLANA_POLL_INTERVAL = 500;     // 0.5초 (Solana는 약 400ms마다 슬롯 생성)

console.log("✅ Multi-Network Block Polling started");
console.log(`📍 Polygon RPC: ${POLYGON_RPC_URL} (${POLYGON_POLL_INTERVAL}ms 간격)`);
console.log(`📍 Solana RPC: ${SOLANA_RPC_URL} (${SOLANA_POLL_INTERVAL}ms 간격)`);

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
    
    // 2. 블록 정보 가져오기 (타임스탬프 포함)
    const blockInfoRes = await axios.post(POLYGON_RPC_URL, {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, false],
    });

    const blockTimestamp = parseInt(blockInfoRes.data.result.timestamp, 16) * 1000; // 초 → 밀리초
    console.log("🔹 [Polygon] Latest block:", blockNumber, "timestamp:", blockTimestamp);
    
    await redis.publish("new_block", JSON.stringify({
      network: "Polygon Amoy",
      blockNumber: blockNumber,
      timestamp: blockTimestamp
    }));
  } catch (error) {
    console.error("❌ [Polygon] Error:", error.message);
  }
}

// Solana Devnet 네트워크 폴링
async function pollSolanaSlot() {
  try {
    // 1. 최신 슬롯 번호 가져오기
    const slotRes = await axios.post(SOLANA_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot",
      params: [],
    });

    const slotNumber = slotRes.data.result;
    
    // 2. 슬롯의 타임스탬프 가져오기
    const blockTimeRes = await axios.post(SOLANA_RPC_URL, {
      jsonrpc: "2.0",
      id: 2,
      method: "getBlockTime",
      params: [slotNumber],
    });

    const slotTimestamp = blockTimeRes.data.result * 1000; // 초 → 밀리초
    console.log("🔹 [Solana] Latest slot:", slotNumber, "timestamp:", slotTimestamp);
    
    await redis.publish("new_block", JSON.stringify({
      network: "Solana Devnet",
      blockNumber: slotNumber, // Solana는 slot을 blockNumber로 표시
      timestamp: slotTimestamp
    }));
  } catch (error) {
    console.error("❌ [Solana] Error:", error.message);
  }
}

// 각 네트워크를 독립적으로 폴링 (다른 간격으로)
// 즉시 한 번 실행
pollPolygonBlock();
pollSolanaSlot();

// Polygon: 5초마다 폴링
setInterval(pollPolygonBlock, POLYGON_POLL_INTERVAL);

// Solana: 0.5초마다 폴링 (약 400ms마다 슬롯 생성되는 빠른 속도 반영)
setInterval(pollSolanaSlot, SOLANA_POLL_INTERVAL);
