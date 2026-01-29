/**
 * Solana: 블록(slot) 수집 — WS slotSubscribe + HTTP reconcile
 * blocks:stream에 적재. env 없으면 no-op.
 */

import WebSocket from "ws";

const SOLANA_WS_URL = process.env.SOLANA_WS_URL;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SOLANA_RECONCILE_INTERVAL = Number(process.env.SOLANA_RECONCILE_INTERVAL);
const LAST_BLOCK_KEY = "lastBlock:solana";

function createOnSlot(redis, deps) {
  return async (slot, ts) => {
    await deps.xaddBlockEvent({
      network: "Solana Devnet",
      blockNumber: slot,
      timestamp: ts ?? Date.now(),
    });
    await redis.set(LAST_BLOCK_KEY, String(slot));
  };
}

/** 체인 진입점. SOLANA_WS_URL, SOLANA_RPC_URL 없으면 no-op */
export function start(redis, deps) {
  if (!String(SOLANA_WS_URL || "").trim() || !String(SOLANA_RPC_URL || "").trim()) return;
  startSlotSubscribe(redis, deps);
}

function startSlotSubscribe(redis, deps) {
  let lastSlot = 0;
  let ws = null;
  let reconnectTimer = null;

  redis.get(LAST_BLOCK_KEY).then((v) => {
    if (v) lastSlot = Number(v) || 0;
  });

  const onSlot = createOnSlot(redis, deps);

  const scheduleReconnect = (reason) => {
    if (reconnectTimer) return;
    console.error("❌ [Solana][ws] disconnected:", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  };

  const connect = () => {
    ws = new WebSocket(SOLANA_WS_URL);

    ws.on("open", () => {
      console.log("✅ [Solana][ws] connected");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg?.method === "slotNotification" && msg?.params?.result) {
        const slot = Number(msg.params.result.slot);
        if (!Number.isFinite(slot)) return;
        console.log("🔹 [Solana][ws] slot:", slot);
        lastSlot = slot;
        onSlot(slot, Date.now()).catch((e) =>
          console.error("❌ [Solana][ws] onSlot error:", e?.message || e)
        );
        return;
      }

      if (typeof msg?.id === "number" && Object.prototype.hasOwnProperty.call(msg, "result")) {
        console.log("✅ [Solana][ws] slotSubscribe ack:", msg.result);
        return;
      }

      if (msg?.error) console.error("❌ [Solana][ws] error:", msg.error);
    });

    ws.on("error", (err) => scheduleReconnect(err?.message || err));
    ws.on("close", (code, reason) =>
      scheduleReconnect(`${code} ${reason?.toString?.() || ""}`.trim())
    );
  };

  const reconcile = async () => {
    try {
      const slot = await deps.rpcHttpCall(SOLANA_RPC_URL, "getSlot", []);
      const current = Number(slot);
      if (!Number.isFinite(current) || current <= lastSlot) return;
      console.log("🔹 [Solana][reconcile] slot:", current);
      lastSlot = current;
      await onSlot(current, Date.now());
    } catch (e) {
      console.error("❌ [Solana][reconcile] error:", e?.message || e);
    }
  };

  connect();

  if (Number.isFinite(SOLANA_RECONCILE_INTERVAL) && SOLANA_RECONCILE_INTERVAL > 0) {
    setInterval(reconcile, SOLANA_RECONCILE_INTERVAL);
  }
}

export function getSolanaLastSlotKey() {
  return LAST_BLOCK_KEY;
}
