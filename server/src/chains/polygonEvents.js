/**
 * Polygon: 이벤트(로그) 수집 - eth_getLogs 백필, WS logs 메시지 처리
 * xaddPolygonLogEvent로 polygon:events 스트림에 적재.
 */

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const POLYGON_LOGS_ADDRESS = process.env.POLYGON_LOGS_ADDRESS || "";
const POLYGON_LOGS_TOPIC0 = process.env.POLYGON_LOGS_TOPIC0 || "";
const POLYGON_DEBUG_WS = String(process.env.POLYGON_DEBUG_WS || "false").toLowerCase() === "true";

const POLYGON_LOGS_STREAM_KEY = "polygon:events";
const POLYGON_LAST_LOG_BLOCK_KEY = "polygon:lastLogBlock";

export const polygonWsState = {
  connected: false,
  logsSubscribed: false,
};

export function shouldCollectPolygonLogs() {
  return Boolean(String(POLYGON_LOGS_ADDRESS || "").trim()) || Boolean(String(POLYGON_LOGS_TOPIC0 || "").trim());
}

async function xaddPolygonLogEvent(event, redis, deps) {
  await redis.sendCommand([
    "XADD",
    POLYGON_LOGS_STREAM_KEY,
    "MAXLEN",
    "~",
    String(deps.streamMaxlen ?? 10000),
    "*",
    "network",
    deps.getNetworkLabel(),
    "blockNumber",
    String(event.blockNumber ?? ""),
    "txHash",
    String(event.txHash ?? ""),
    "logIndex",
    String(event.logIndex ?? ""),
    "address",
    String(event.address ?? ""),
    "topics",
    deps.safeJsonStringify(event.topics ?? [], 2000),
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

async function fetchPolygonLogsForBlock(blockNumber, deps) {
  const fromBlock = `0x${Number(blockNumber).toString(16)}`;
  const toBlock = fromBlock;
  const filter = { fromBlock, toBlock };
  if (String(POLYGON_LOGS_ADDRESS || "").trim()) filter.address = String(POLYGON_LOGS_ADDRESS).trim();
  if (String(POLYGON_LOGS_TOPIC0 || "").trim()) filter.topics = [String(POLYGON_LOGS_TOPIC0).trim()];

  const logs = await deps.rpcHttpCall(POLYGON_RPC_URL, "eth_getLogs", [filter]);
  return Array.isArray(logs) ? logs : [];
}

/**
 * 블록 N까지 로그 백필 (HTTP eth_getLogs). WS 로그 미수신 시 호출.
 */
export async function catchUpPolygonLogsTo(targetBlockNumber, timestampMs, redis, deps) {
  if (!shouldCollectPolygonLogs()) return;
  if (!Number.isFinite(targetBlockNumber) || targetBlockNumber <= 0) return;

  const latest = Number(targetBlockNumber);
  const lastStr = await redis.get(POLYGON_LAST_LOG_BLOCK_KEY);

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
      logs = await fetchPolygonLogsForBlock(b, deps);
    } catch (e) {
      console.error("❌ [Polygon][logs] eth_getLogs error:", e?.message || e);
      break;
    }

    for (const l of logs) {
      const bn = typeof l?.blockNumber === "string" ? parseInt(l.blockNumber, 16) : b;
      const li = typeof l?.logIndex === "string" ? parseInt(l.logIndex, 16) : null;
      const txHash = l?.transactionHash || "";
      const uid = `${bn}:${txHash}:${li ?? ""}`;

      await xaddPolygonLogEvent(
        {
          blockNumber: bn,
          txHash,
          logIndex: li,
          address: l?.address || "",
          topics: Array.isArray(l?.topics) ? l.topics : [],
          data: l?.data || "",
          removed: Boolean(l?.removed),
          timestamp: b === latest ? timestampMs : Date.now(),
          uid,
        },
        redis,
        deps
      );
    }

    await redis.set(POLYGON_LAST_LOG_BLOCK_KEY, String(b));
  }
}

/**
 * WS eth_subscription 로그 메시지 처리 (result 객체 한 건)
 */
export async function handlePolygonLog(result, redis, deps) {
  if (!result || typeof result !== "object" || !Array.isArray(result.topics)) return;

  const bn = typeof result.blockNumber === "string" ? parseInt(result.blockNumber, 16) : null;
  const li = typeof result.logIndex === "string" ? parseInt(result.logIndex, 16) : null;
  const txHash = result.transactionHash || "";
  const uid = `${bn ?? ""}:${txHash}:${li ?? ""}`;

  await xaddPolygonLogEvent(
    {
      blockNumber: bn,
      txHash,
      logIndex: li,
      address: result.address || "",
      topics: result.topics,
      data: result.data || "",
      removed: Boolean(result.removed),
      timestamp: Date.now(),
      uid,
    },
    redis,
    deps
  );

  if (POLYGON_DEBUG_WS) {
    const t0 = result.topics?.length ? result.topics[0] : "";
    console.log(
      "🪵 [Polygon][ws][log]",
      `block=${bn ?? "?"}`,
      `tx=${String(txHash).slice(0, 12)}...`,
      `addr=${String(result.address || "").slice(0, 12)}...`,
      `topic0=${String(t0).slice(0, 12)}...`
    );
  }

  if (Number.isFinite(bn)) {
    const lastStr = await redis.get(POLYGON_LAST_LOG_BLOCK_KEY);
    const last = Number(lastStr);
    if (!lastStr || (Number.isFinite(last) && bn > last)) {
      await redis.set(POLYGON_LAST_LOG_BLOCK_KEY, String(bn));
    }
  }
}
