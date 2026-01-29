/**
 * Sui: checkpoint 데이터 수집 (Sui에는 block 개념 없음, checkpoint만 사용)
 * GraphQL 폴링 → blocks:stream에 sequenceNumber 적재.
 */

import axios from "axios";

const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL;
const SUI_POLL_INTERVAL = Number(process.env.SUI_POLL_INTERVAL);
const LAST_CHECKPOINT_KEY = "lastCheckpoint:sui";

export async function pollSuiCheckpoint(redis, deps) {
  if (!SUI_GRAPHQL_URL) return;
  try {
    const res = await axios.post(
      SUI_GRAPHQL_URL,
      { query: "query { checkpoint { sequenceNumber } }" },
      { headers: { "Content-Type": "application/json" } }
    );
    const seqStr = res?.data?.data?.checkpoint?.sequenceNumber;
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      throw new Error(`Invalid checkpoint sequenceNumber: ${seqStr}`);
    }

    const last = await redis.get(LAST_CHECKPOINT_KEY);
    if (last && Number(last) === seq) return;

    const ts = Date.now();
    console.log("🔹 [Sui] Latest checkpoint:", seq, "recvTimestamp:", ts);

    await redis.set(LAST_CHECKPOINT_KEY, String(seq));
    await deps.xaddBlockEvent({
      network: "Sui Testnet",
      blockNumber: seq,
      timestamp: ts,
    });
  } catch (error) {
    console.error("❌ [Sui] Error:", error?.message || error);
  }
}

export function startSuiCheckpoints(redis, deps) {
  pollSuiCheckpoint(redis, deps);
  if (Number.isFinite(SUI_POLL_INTERVAL) && SUI_POLL_INTERVAL > 0) {
    setInterval(() => pollSuiCheckpoint(redis, deps), SUI_POLL_INTERVAL);
  }
}
