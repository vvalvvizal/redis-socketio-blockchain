import { createClient } from "redis";
import axios from "axios";

const redis = createClient();
await redis.connect();

console.log("✅ Block Polling started - publishing to Redis every 5 seconds");

async function pollLatestBlock() {
  try {
    const { data } = await axios.post("https://rpc-amoy.polygon.technology", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });

    const blockNumber = parseInt(data.result, 16);
    console.log("🔹 [Polling] Latest block:", blockNumber);
    await redis.publish("new_block", JSON.stringify({ blockNumber }));
    console.log("📤 [Polling] Published to Redis");
  } catch (error) {
    console.error("❌ [Polling] Error:", error.message);
  }
}

// 즉시 한 번 실행
pollLatestBlock();

// 5초마다 실행
setInterval(pollLatestBlock, 5000);
