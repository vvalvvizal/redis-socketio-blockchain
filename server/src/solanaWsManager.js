import WebSocket from "ws";

/**
 * Solana JSON-RPC WebSocket manager that multiplexes multiple subscriptions
 * on a SINGLE websocket connection.
 *
 * Supported:
 * - slotSubscribe (no params)
 * - logsSubscribe (mentions filter; 1 request per mention)
 *
 * Also includes:
 * - reconnect
 * - subscribe ACK timeout + retry
 * - reconcile/catch-up using HTTP getSlot (to reduce gaps)
 *
 * Notes:
 * - This does NOT fetch blocks/transactions. It only emits slot/log notifications.
 * - For full tx details, pair with HTTP `getTransaction(signature)` when needed.
 */
export default class SolanaWsManager {
  constructor({
    wsUrl,
    rpcUrl,
    reconcileIntervalMs,
    rpcHttpCall,
    getLastSlot,
    setLastSlot,
    onSlot,
    logsMentions = [],
    logsCommitment = "finalized",
    onLogs,
    debugRaw = false,
    WebSocketImpl = WebSocket,
  }) {
    this.wsUrl = wsUrl;
    this.rpcUrl = rpcUrl;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.rpcHttpCall = rpcHttpCall;
    this.getLastSlot = getLastSlot;
    this.setLastSlot = setLastSlot;
    this.onSlot = onSlot;

    this.logsMentions = Array.isArray(logsMentions)
      ? logsMentions.filter(Boolean)
      : [];
    this.logsCommitment = logsCommitment;
    this.onLogs = onLogs;
    this.debugRaw = debugRaw;

    this.WebSocketImpl = WebSocketImpl;

    this.ws = null;
    this.reconnectTimer = null;
    this.subscribed = false;
    this.subscribeAckTimer = null;
    this.subscribeAttempts = 0;
    this.reqId = 1;

    this.reconcileTimer = null;
    this.catchingUp = false;
    this.targetSlot = 0;
    this.epoch = 0;

    // request id -> { kind: 'slot' | 'logs', mention?: string }
    this.requestIdToMeta = new Map();
    // rpc subscription id -> { kind, mention? }
    this.subscriptionIdToMeta = new Map();
  }

  async #getCurrentSlot() {
    const slot = await this.rpcHttpCall(this.rpcUrl, "getSlot", []);
    const n = Number(slot);
    if (!Number.isFinite(n)) throw new Error(`Invalid getSlot result: ${slot}`);
    return n;
  }

  async #persistSlot(slot, ts) {
    await this.onSlot(slot, ts);
    this.setLastSlot(slot);
  }

  async #catchUp(reason, myEpoch) {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      while (myEpoch === this.epoch && this.getLastSlot() < this.targetSlot) {
        const next = this.getLastSlot() + 1;
        const ts = Date.now();
        await this.#persistSlot(next, ts);

        if (next % 1000 === 0) {
          console.log(
            `🔁 [Solana][ws-manager][catchup:${reason}] progressed to slot=${next} (target=${this.targetSlot})`
          );
        }
      }
    } catch (e) {
      console.error(`❌ [Solana][ws-manager][catchup:${reason}]`, e?.message || e);
    } finally {
      this.catchingUp = false;
    }
  }

  async #reconcile(reason, myEpoch) {
    try {
      const latest = await this.#getCurrentSlot();
      if (latest > this.targetSlot) this.targetSlot = latest;
      if (this.getLastSlot() < this.targetSlot) {
        void this.#catchUp(reason, myEpoch);
      }
    } catch (e) {
      console.error(`❌ [Solana][ws-manager][reconcile:${reason}]`, e?.message || e);
    }
  }

  #scheduleReconnect(reason) {
    if (this.reconnectTimer) return;
    if (this.subscribeAckTimer) {
      clearTimeout(this.subscribeAckTimer);
      this.subscribeAckTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    console.error("❌ [Solana][ws-manager] WS disconnected:", reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 1000);
  }

  start() {
    if (!this.wsUrl) throw new Error("wsUrl is required");
    if (!this.rpcUrl) throw new Error("rpcUrl is required");
    if (typeof this.rpcHttpCall !== "function") throw new Error("rpcHttpCall is required");
    if (typeof this.getLastSlot !== "function") throw new Error("getLastSlot is required");
    if (typeof this.setLastSlot !== "function") throw new Error("setLastSlot is required");
    if (typeof this.onSlot !== "function") throw new Error("onSlot is required");
    if (this.logsMentions.length && typeof this.onLogs !== "function") {
      throw new Error("onLogs is required when logsMentions is provided");
    }

    this.epoch += 1;
    const myEpoch = this.epoch;

    this.subscribeAttempts = 0;
    this.reqId = Math.floor(Date.now() % 1_000_000_000);
    this.ws = new this.WebSocketImpl(this.wsUrl);

    this.ws.on("open", () => {
      this.subscribed = false;
      console.log(
        `✅ [Solana][ws-manager] WS connected (logsMentions=${this.logsMentions.length})`
      );

      const sendSubscribe = () => {
        this.subscribeAttempts += 1;

        this.requestIdToMeta.clear();
        this.subscriptionIdToMeta.clear();

        if (this.subscribeAckTimer) clearTimeout(this.subscribeAckTimer);
        this.subscribeAckTimer = setTimeout(() => {
          if (this.subscribed) return;
          if (this.subscribeAttempts < 3) {
            console.error(
              `❌ [Solana][ws-manager] ACK timeout (attempt ${this.subscribeAttempts}). Retrying...`
            );
            sendSubscribe();
            return;
          }

          console.error("❌ [Solana][ws-manager] failed after retries. Reconnecting...");
          try {
            this.ws?.terminate?.();
          } catch {
            try {
              this.ws?.close?.();
            } catch {}
          }
        }, 15000);

        const send = (kind, method, params, mention) => {
          this.reqId += 1;
          const id = this.reqId;
          this.requestIdToMeta.set(id, { kind, mention });
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          console.log(`➡️  [Solana][ws-manager] ${method} sent (id=${id}${mention ? `, mention=${mention}` : ""})`);
        };

        // 1) slotSubscribe (single)
        send("slot", "slotSubscribe", []);

        // 2) logsSubscribe (one per mention)
        for (const m of this.logsMentions) {
          send(
            "logs",
            "logsSubscribe",
            [{ mentions: [m] }, { commitment: this.logsCommitment }],
            m
          );
        }
      };

      sendSubscribe();

      this.targetSlot = this.getLastSlot();
      void this.#reconcile("on-open", myEpoch);

      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      this.reconcileTimer = setInterval(() => {
        void this.#reconcile("interval", myEpoch);
      }, this.reconcileIntervalMs);
    });

    this.ws.on("message", async (raw) => {
      const s = raw?.toString?.() || "";
      if (this.debugRaw) {
        const preview = s.length > 2000 ? s.slice(0, 2000) + "...(truncated)" : s;
        console.log("🛰️  [Solana][ws-manager][raw]", preview);
      }

      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        return;
      }

      // subscribe ACK(s): { id, result: <subscriptionId> }
      if (typeof msg?.id === "number" && Object.prototype.hasOwnProperty.call(msg, "result")) {
        const meta = this.requestIdToMeta.get(msg.id);
        if (meta) {
          this.subscriptionIdToMeta.set(msg.result, meta);
          console.log(
            `✅ [Solana][ws-manager] ACK kind=${meta.kind}${meta.mention ? ` mention=${meta.mention}` : ""} subscriptionId=${msg.result}`
          );

          const expected = 1 + this.logsMentions.length;
          if (this.subscriptionIdToMeta.size >= expected) {
            this.subscribed = true;
            if (this.subscribeAckTimer) {
              clearTimeout(this.subscribeAckTimer);
              this.subscribeAckTimer = null;
            }
          }
          return;
        }
      }

      if (msg?.error) {
        console.error("❌ [Solana][ws-manager] WS error message:", msg.error);
      }

      // slot notification
      if (msg?.method === "slotNotification") {
        const slot = msg?.params?.result?.slot;
        if (typeof slot !== "number") return;
        if (slot <= this.getLastSlot()) return;

        if (slot > this.targetSlot) this.targetSlot = slot;

        if (this.catchingUp) return;
        if (this.getLastSlot() + 1 !== slot) {
          void this.#catchUp("ws-gap", myEpoch);
          return;
        }

        const ts = Date.now();
        try {
          await this.#persistSlot(slot, ts);
        } catch (e) {
          console.error("❌ [Solana][ws-manager] onSlot error:", e?.message || e);
        }
        return;
      }

      // logs notification
      if (msg?.method === "logsNotification") {
        if (!this.logsMentions.length) return;
        if (myEpoch !== this.epoch) return;

        const ctxSlot = msg?.params?.result?.context?.slot;
        const v = msg?.params?.result?.value;
        const signature = v?.signature;
        const err = v?.err;
        const logs = Array.isArray(v?.logs) ? v.logs : [];

        try {
          await this.onLogs({
            slot: typeof ctxSlot === "number" ? ctxSlot : null,
            signature: typeof signature === "string" ? signature : "",
            err: err ?? null,
            logs,
            recvTimestamp: Date.now(),
          });
        } catch (e) {
          console.error("❌ [Solana][ws-manager] onLogs error:", e?.message || e);
        }
      }
    });

    this.ws.on("unexpected-response", (_req, res) => {
      console.error(
        "❌ [Solana][ws-manager] WS unexpected response:",
        res?.statusCode,
        res?.statusMessage
      );
    });
    this.ws.on("error", (err) => this.#scheduleReconnect(err?.message || err));
    this.ws.on("close", (code, reason) =>
      this.#scheduleReconnect(`${code} ${reason?.toString?.() || ""}`.trim())
    );
  }
}

