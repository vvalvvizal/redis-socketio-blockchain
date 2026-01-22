import WebSocket from "ws";

/**
 * Solana `logsSubscribe` wrapper with reconnect + subscribe ACK timeout.
 *
 * Why this helps (vs blockSubscribe):
 * - `logsSubscribe` can be filtered (`mentions`) so you don't ingest vote tx noise.
 * - Notifications include { signature, err, logs, context.slot } so you can map to slots.
 * - For full details (instructions/token balances), pair with HTTP `getTransaction(signature)`.
 */
export default class SolanaLogsSubscriber {
  constructor({
    wsUrl,
    mentions, // string pubkey (programId or account)
    commitment = "finalized",
    onLogNotification,
    WebSocketImpl = WebSocket,
  }) {
    this.wsUrl = wsUrl;
    this.mentions = mentions;
    this.commitment = commitment;
    this.onLogNotification = onLogNotification;
    this.WebSocketImpl = WebSocketImpl;

    this.ws = null;
    this.reconnectTimer = null;
    this.subscribed = false;
    this.subscribeAckTimer = null;
    this.subscribeAttempts = 0;
    this.reqId = 1;
    this.epoch = 0;
  }

  #scheduleReconnect(reason) {
    if (this.reconnectTimer) return;
    if (this.subscribeAckTimer) {
      clearTimeout(this.subscribeAckTimer);
      this.subscribeAckTimer = null;
    }
    console.error("❌ [Solana][logsSubscribe] WS disconnected:", reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 1000);
  }

  start() {
    if (!this.wsUrl) throw new Error("wsUrl is required");
    if (!this.mentions) throw new Error("mentions is required (programId/account pubkey)");
    if (typeof this.onLogNotification !== "function") {
      throw new Error("onLogNotification is required");
    }

    this.epoch += 1;
    const myEpoch = this.epoch;

    this.subscribed = false;
    this.subscribeAttempts = 0;
    this.reqId = Math.floor(Date.now() % 1_000_000_000);

    this.ws = new this.WebSocketImpl(this.wsUrl);

    this.ws.on("open", () => {
      console.log("✅ [Solana][logsSubscribe] WS connected");

      const sendSubscribe = () => {
        this.subscribeAttempts += 1;
        this.reqId += 1;
        const currentReqId = this.reqId;

        if (this.subscribeAckTimer) clearTimeout(this.subscribeAckTimer);
        this.subscribeAckTimer = setTimeout(() => {
          if (this.subscribed) return;
          if (this.subscribeAttempts < 3) {
            console.error(
              `❌ [Solana][logsSubscribe] ACK timeout (attempt ${this.subscribeAttempts}). Retrying...`
            );
            sendSubscribe();
            return;
          }

          console.error("❌ [Solana][logsSubscribe] failed after retries. Reconnecting...");
          try {
            this.ws?.terminate?.();
          } catch {
            try {
              this.ws?.close?.();
            } catch {}
          }
        }, 15000);

        console.log(
          `➡️  [Solana][logsSubscribe] request sent (id=${currentReqId}, attempt=${this.subscribeAttempts}, mentions=${this.mentions})`
        );
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: currentReqId,
            method: "logsSubscribe",
            params: [{ mentions: [this.mentions] }, { commitment: this.commitment }],
          })
        );
      };

      sendSubscribe();
    });

    this.ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // subscribe ACK
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
        console.log("✅ [Solana][logsSubscribe] OK, subscription id:", msg.result);
        return;
      }

      if (msg?.error) {
        console.error("❌ [Solana][logsSubscribe] WS error message:", msg.error);
      }

      // logs notification
      if (msg?.method === "logsNotification") {
        if (myEpoch !== this.epoch) return;
        try {
          await this.onLogNotification(msg);
        } catch (e) {
          console.error(
            "❌ [Solana][logsSubscribe] onLogNotification error:",
            e?.message || e
          );
        }
      }
    });

    this.ws.on("unexpected-response", (_req, res) => {
      console.error(
        "❌ [Solana][logsSubscribe] WS unexpected response:",
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

