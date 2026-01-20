import WebSocket from "ws";

export default class SolanaSlotSubscriber {
  constructor({
    wsUrl,
    rpcUrl,
    reconcileIntervalMs,
    rpcHttpCall,
    getLastSlot,
    setLastSlot,
    onSlot,
    WebSocketImpl = WebSocket,
  }) {
    this.wsUrl = wsUrl;
    this.rpcUrl = rpcUrl;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.rpcHttpCall = rpcHttpCall;
    this.getLastSlot = getLastSlot;
    this.setLastSlot = setLastSlot;
    this.onSlot = onSlot;
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
  }

  async #getCurrentSlot() { //현재 최신 슬롯 확인 
    const slot = await this.rpcHttpCall(this.rpcUrl, "getSlot", []);
    const n = Number(slot);
    if (!Number.isFinite(n)) throw new Error(`Invalid getSlot result: ${slot}`);
    return n;
  }

  async #persistSlot(slot, ts) { //슬롯 저장
    await this.onSlot(slot, ts);
    this.setLastSlot(slot);
  }

  async #catchUp(reason, myEpoch) { //캐치업 
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      while (myEpoch === this.epoch && this.getLastSlot() < this.targetSlot) {
        const next = this.getLastSlot() + 1;
        const ts = Date.now();
        await this.#persistSlot(next, ts);

        if (next % 1000 === 0) {
          console.log(
            `🔁 [Solana][catchup:${reason}] progressed to slot=${next} (target=${this.targetSlot})`
          );
        }
      }
    } catch (e) {
      console.error(`❌ [Solana][catchup:${reason}]`, e?.message || e);
    } finally {
      this.catchingUp = false;
    }
  }

  async #reconcile(reason, myEpoch) { //정합성 체크
    try {
      const latest = await this.#getCurrentSlot();
      if (latest > this.targetSlot) this.targetSlot = latest;
      if (this.getLastSlot() < this.targetSlot) {
        void this.#catchUp(reason, myEpoch);
      }
    } catch (e) {
      console.error(`❌ [Solana][reconcile:${reason}]`, e?.message || e);
    }
  }

  #scheduleReconnect(reason) { //재연결 스케줄링
    if (this.reconnectTimer) return;
    if (this.subscribeAckTimer) {
      clearTimeout(this.subscribeAckTimer);
      this.subscribeAckTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    console.error("❌ [Solana] WS disconnected:", reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 1000);
  }

  start() {
    this.epoch += 1;
    const myEpoch = this.epoch;

    this.subscribeAttempts = 0;
    this.reqId = Math.floor(Date.now() % 1_000_000_000);
    this.ws = new this.WebSocketImpl(this.wsUrl);

    this.ws.on("open", () => {
      this.subscribed = false;
      console.log("✅ [Solana] WS connected");

      const sendSubscribe = () => {
        this.subscribeAttempts += 1;
        this.reqId += 1;
        const currentReqId = this.reqId;

        if (this.subscribeAckTimer) clearTimeout(this.subscribeAckTimer);
        this.subscribeAckTimer = setTimeout(() => {
          if (this.subscribed) return;
          if (this.subscribeAttempts < 3) {
            console.error(
              `❌ [Solana] slotSubscribe ACK timeout (attempt ${this.subscribeAttempts}). Retrying...`
            );
            sendSubscribe();
            return;
          }

          console.error("❌ [Solana] slotSubscribe failed after retries. Reconnecting...");
          try {
            this.ws?.terminate?.();
          } catch {
            try {
              this.ws?.close?.();
            } catch {}
          }
        }, 15000);

        console.log(
          `➡️  [Solana] slotSubscribe request sent (id=${currentReqId}, attempt=${this.subscribeAttempts})`
        );
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: currentReqId,
            method: "slotSubscribe",
          })
        );
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
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // 구독 ACK
      if (
        typeof msg?.id === "number" &&
        Object.prototype.hasOwnProperty.call(msg, "result") &&
        !this.subscribed
      ) {
        this.subscribed = true;
        if (this.subscribeAckTimer) {
          clearTimeout(this.subscribeAckTimer);
          this.subscribeAckTimer = null;
        }
        console.log("✅ [Solana] slotSubscribe OK, subscription id:", msg.result);
        return;
      }

      if (msg?.error) {
        console.error("❌ [Solana] WS error message:", msg.error);
      }

      // 슬롯 알림
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
        console.log("🔹 [Solana] New slot:", slot, "recvTimestamp:", ts);

        try {
          await this.#persistSlot(slot, ts);
        } catch (e) {
          console.error("❌ [Solana] Redis Stream write error:", e?.message || e);
        }
      }
    });

    this.ws.on("unexpected-response", (_req, res) => {
      console.error(
        "❌ [Solana] WS unexpected response:",
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