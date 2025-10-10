import { createClient } from "redis";
import axios from "axios";

const redis = createClient();
await redis.connect();

async function pollLatestBlock() {
  const { data } = await axios.post("https://rpc-amoy.polygon.technology", {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_blockNumber",
    params: [],
  });

  const blockNumber = parseInt(data.result, 16);
  console.log("🔹 Latest block:", blockNumber);
  await redis.publish("new_block", JSON.stringify({ blockNumber }));
}

setInterval(pollLatestBlock, 5000);
