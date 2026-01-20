// import WebSocket from "ws";

// /**
//  * Solana `blockSubscribe` wrapper with reconnect + subscribe ACK timeout.
//  *
//  * Notes:
//  * - `blockSubscribe` support depends on the RPC provider / validator configuration.
//  * - This class does NOT guarantee "no-miss" by itself. For no-miss, pair with HTTP backfill.
//  */
// export default class SolanaBlockSubscriber {
//   constructor({
//     wsUrl,
//     // single subscription fields (backward compatible)
//     mentionsAccountOrProgram,
//     commitment = "finalized",
//     encoding = "jsonParsed",
//     transactionDetails = "full",
//     showRewards = false,
//     maxSupportedTransactionVersion = 0,
//     onBlockNotification,
//     // multi-subscription (preferred)
//     subscriptions,
//     WebSocketImpl = WebSocket,
//   }) {
//     this.wsUrl = wsUrl;
//     this.commitment = commitment;
//     this.encoding = encoding;
//     this.transactionDetails = transactionDetails;
//     this.showRewards = showRewards;
//     this.maxSupportedTransactionVersion = maxSupportedTransactionVersion;
//     this.WebSocketImpl = WebSocketImpl;

//     this.subscriptions = Array.isArray(subscriptions) && subscriptions.length
//       ? subscriptions
//       : [
//           {
//             name: "default",
//             mentionsAccountOrProgram,
//             onBlockNotification,
//           },
//         ];

//     this.ws = null;
//     this.reconnectTimer = null;
//     this.subscribed = false;
//     this.subscribeAckTimer = null;
//     this.subscribeAttempts = 0;
//     this.reqId = 1;
//     this.epoch = 0;

//     // requestId -> subscription index (during subscribe ACK phase)
//     this.requestIdToIndex = new Map();
//     // rpc subscription id -> subscription index (for routing notifications)
//     this.subscriptionIdToIndex = new Map();
//   }

//   #scheduleReconnect(reason) {
//     if (this.reconnectTimer) return;
//     if (this.subscribeAckTimer) {
//       clearTimeout(this.subscribeAckTimer);
//       this.subscribeAckTimer = null;
//     }
//     console.error("❌ [Solana][blockSubscribe] WS disconnected:", reason);
//     this.reconnectTimer = setTimeout(() => {
//       this.reconnectTimer = null;
//       this.start();
//     }, 1000);
//   }

//   start() {
//     this.epoch += 1;
//     const myEpoch = this.epoch;

//     this.subscribeAttempts = 0;
//     this.reqId = Math.floor(Date.now() % 1_000_000_000);
//     this.ws = new this.WebSocketImpl(this.wsUrl);

//     this.ws.on("open", () => {
//       this.subscribed = false;
//       console.log("✅ [Solana][blockSubscribe] WS connected");

//       const sendSubscribe = () => {
//         this.subscribeAttempts += 1;
//         // (re)initialize maps on each subscribe attempt
//         this.requestIdToIndex.clear();
//         this.subscriptionIdToIndex.clear();

//         if (this.subscribeAckTimer) clearTimeout(this.subscribeAckTimer);
//         this.subscribeAckTimer = setTimeout(() => {
//           if (this.subscribed) return;
//           if (this.subscribeAttempts < 3) {
//             console.error(
//               `❌ [Solana][blockSubscribe] ACK timeout (attempt ${this.subscribeAttempts}). Retrying...`
//             );
//             sendSubscribe();
//             return;
//           }

//           console.error("❌ [Solana][blockSubscribe] failed after retries. Reconnecting...");
//           try {
//             this.ws?.terminate?.();
//           } catch {
//             try {
//               this.ws?.close?.();
//             } catch {}
//           }
//         }, 15000);

//         // send one blockSubscribe request per subscription (same WS)
//         for (let i = 0; i < this.subscriptions.length; i += 1) {
//           const sub = this.subscriptions[i] || {};
//           this.reqId += 1;
//           const currentReqId = this.reqId;

//           this.requestIdToIndex.set(currentReqId, i);

//           console.log(
//             `➡️  [Solana][blockSubscribe] request sent (id=${currentReqId}, attempt=${this.subscribeAttempts}, name=${sub.name || i})`
//           );

//           const filter = sub.mentionsAccountOrProgram
//             ? { mentionsAccountOrProgram: sub.mentionsAccountOrProgram }
//             : {};

//           this.ws.send(
//             JSON.stringify({
//               jsonrpc: "2.0",
//               id: currentReqId,
//               method: "blockSubscribe",
//               params: [
//                 filter,
//                 {
//                   commitment: this.commitment,
//                   encoding: this.encoding,
//                   transactionDetails: this.transactionDetails,
//                   showRewards: this.showRewards,
//                   maxSupportedTransactionVersion: this.maxSupportedTransactionVersion,
//                 },
//               ],
//             })
//           );
//         }
//       };

//       sendSubscribe();
//     });

//     this.ws.on("message", async (raw) => {
//       let msg;
//       try {
//         msg = JSON.parse(raw.toString());
//       } catch {
//         return;
//       }

//       // subscribe ACK(s) - one per request id
//       if (typeof msg?.id === "number" && Object.prototype.hasOwnProperty.call(msg, "result")) {
//         const idx = this.requestIdToIndex.get(msg.id);
//         if (typeof idx === "number") {
//           const rpcSubId = msg.result;
//           this.subscriptionIdToIndex.set(rpcSubId, idx);

//           console.log(
//             "✅ [Solana][blockSubscribe] OK:",
//             `name=${this.subscriptions[idx]?.name || idx}`,
//             "subscriptionId=",
//             rpcSubId
//           );

//           // Consider subscribed once we received all ACKs
//           if (this.subscriptionIdToIndex.size >= this.subscriptions.length) {
//             this.subscribed = true;
//             if (this.subscribeAckTimer) {
//               clearTimeout(this.subscribeAckTimer);
//               this.subscribeAckTimer = null;
//             }
//           }
//           return;
//         }
//       }

//       if (msg?.error) {
//         console.error("❌ [Solana][blockSubscribe] WS error message:", msg.error);
//       }

//       // block notification
//       if (msg?.method === "blockNotification") {
//         if (myEpoch !== this.epoch) return;
//         const rpcSubId = msg?.params?.subscription;
//         const idx = this.subscriptionIdToIndex.get(rpcSubId);

//         // If routing fails (provider format difference), fall back:
//         const handlers =
//           typeof idx === "number"
//             ? [this.subscriptions[idx]?.onBlockNotification]
//             : this.subscriptions.map((s) => s?.onBlockNotification);

//         for (const h of handlers) {
//           if (typeof h !== "function") continue;
//           try {
//             await h(msg);
//           } catch (e) {
//             console.error(
//               "❌ [Solana][blockSubscribe] onBlockNotification error:",
//               e?.message || e
//             );
//           }
//         }
//       }
//     });

//     this.ws.on("unexpected-response", (_req, res) => {
//       console.error(
//         "❌ [Solana][blockSubscribe] WS unexpected response:",
//         res?.statusCode,
//         res?.statusMessage
//       );
//     });
//     this.ws.on("error", (err) => this.#scheduleReconnect(err?.message || err));
//     this.ws.on("close", (code, reason) =>
//       this.#scheduleReconnect(`${code} ${reason?.toString?.() || ""}`.trim())
//     );
//   }
// }

