import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";
import SolanaSlotSubscriber from "./solanaRPCSubscriber.js";
//import SolanaBlockSubscriber from "./solanaBlockSubscriber.js";

dotenv.config();

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SOLANA_WS_URL = process.env.SOLANA_WS_URL;
const SUI_GRAPHQL_URL =
  process.env.SUI_GRAPHQL_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = createClient({ url: REDIS_URL });
await redis.connect();

// Redis Stream 설정
const BLOCKS_STREAM_KEY = process.env.BLOCKS_STREAM_KEY || "blocks:stream";
const STREAM_MAXLEN = Number(process.env.BLOCKS_STREAM_MAXLEN || 10000);
const SOLANA_RECONCILE_INTERVAL = Number(
  process.env.SOLANA_RECONCILE_INTERVAL || 5000
);
const SOLANA_ENABLE_TOKEN_BLOCKSUB = String(process.env.SOLANA_ENABLE_TOKEN_BLOCKSUB || "false").toLowerCase() === "true";
//const SOLANA_USDT_MINT = process.env.SOLANA_USDT_MINT; // base58 mint address
//const SOLANA_USDT_STREAM_KEY = process.env.SOLANA_USDT_STREAM_KEY || "solana:usdt:transfers";
//const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT; // base58 mint address
//const SOLANA_USDC_STREAM_KEY = process.env.SOLANA_USDC_STREAM_KEY || "solana:usdc:transfers";
const SUI_EVENTS_STREAM_KEY = process.env.SUI_EVENTS_STREAM_KEY || "sui:events";
const SUI_EVENTS_PAGE_SIZE = Number(process.env.SUI_EVENTS_PAGE_SIZE || 50);
const SUI_EVENTS_MAX_PAGES_PER_TICK = Number(process.env.SUI_EVENTS_MAX_PAGES_PER_TICK || 5);
const SUI_EVENTS_START_FROM_LATEST =
  String(process.env.SUI_EVENTS_START_FROM_LATEST || "true").toLowerCase() === "true";
const SUI_EVENT_JSON_MAXLEN = Number(process.env.SUI_EVENT_JSON_MAXLEN || 2000);
const SOLANA_TOKEN_PROGRAM_ID =
  process.env.SOLANA_TOKEN_PROGRAM_ID || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_BLOCKSUB_MENTIONS =
  process.env.SOLANA_BLOCKSUB_MENTIONS || SOLANA_TOKEN_PROGRAM_ID; // program or account pubkey (base58)
const SOLANA_BLOCKSUB_COMMITMENT = process.env.SOLANA_BLOCKSUB_COMMITMENT || "finalized";

function asPubkeyString(k) {
  if (!k) return null;
  if (typeof k === "string") return k;
  if (typeof k?.pubkey === "string") return k.pubkey;
  return null;
}

function extractTokenTransfersFromTx(tx, { tokenProgramId, targetMint }) {
  const out = [];
  const meta = tx?.meta;
  const message = tx?.transaction?.message;
  const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];

  // token account -> mint mapping from pre/post balances
  const tokenBalances = [
    ...(Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : []),
    ...(Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : []),
  ];
  const tokenAccountToMint = new Map();
  for (const b of tokenBalances) {
    const idx = b?.accountIndex;
    const mint = b?.mint;
    if (typeof idx !== "number" || typeof mint !== "string") continue;
    const pk = asPubkeyString(accountKeys[idx]);
    if (!pk) continue;
    if (!tokenAccountToMint.has(pk)) tokenAccountToMint.set(pk, mint);
  }

  const collectFromInstructions = (instructions, isInner) => {
    if (!Array.isArray(instructions)) return;
    for (const ix of instructions) {
      // jsonParsed: { programId, parsed: { type, info } }
      const programId = ix?.programId || ix?.programIdIndex; // programIdIndex for non-parsed
      const parsed = ix?.parsed;
      const type = parsed?.type;
      const info = parsed?.info;

      // When encoding=jsonParsed, programId is usually base58 string
      if (typeof programId === "string" && programId !== tokenProgramId) continue;
      if (!parsed || typeof type !== "string" || !info) continue;

      if (type !== "transfer" && type !== "transferChecked") continue;

      const source = info?.source;
      const destination = info?.destination;
      const authority = info?.authority;
      const amountRaw = info?.amount; // string for transfer, or string for transferChecked (uiAmountString sometimes)
      const mint = info?.mint || tokenAccountToMint.get(source) || tokenAccountToMint.get(destination) || null;

      if (!source || !destination) continue;
      if (targetMint && mint !== targetMint) continue;

      out.push({
        signature: Array.isArray(tx?.transaction?.signatures) ? tx.transaction.signatures[0] : undefined,
        slot: meta?.slot,
        source,
        destination,
        authority,
        amount: amountRaw != null ? String(amountRaw) : null,
        mint,
        isInner: Boolean(isInner),
      });
    }
  };

  // top-level instructions
  collectFromInstructions(message?.instructions, false);

  // inner instructions (CPI)
  const inner = Array.isArray(meta?.innerInstructions) ? meta.innerInstructions : [];
  for (const ii of inner) {
    collectFromInstructions(ii?.instructions, true);
  }

  return out;
}

async function xaddUsdtTransferEvent(event) {
  // Store transfer events in a dedicated stream (separate from blocks:stream)
  await redis.sendCommand([
    "XADD",
    SOLANA_USDT_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Solana USDT Transfer",
    "slot",
    String(event.slot ?? ""),
    "signature",
    String(event.signature ?? ""),
    "source",
    String(event.source ?? ""),
    "destination",
    String(event.destination ?? ""),
    "authority",
    String(event.authority ?? ""),
    "mint",
    String(event.mint ?? ""),
    "amount",
    String(event.amount ?? ""),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}

async function xaddUsdcTransferEvent(event) {
  await redis.sendCommand([
    "XADD",
    SOLANA_USDC_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Solana USDC Transfer",
    "slot",
    String(event.slot ?? ""),
    "signature",
    String(event.signature ?? ""),
    "source",
    String(event.source ?? ""),
    "destination",
    String(event.destination ?? ""),
    "authority",
    String(event.authority ?? ""),
    "mint",
    String(event.mint ?? ""),
    "amount",
    String(event.amount ?? ""),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}


async function rpcHttpCall(rpcUrl, method, params = []) {
  if (!rpcUrl) throw new Error(`RPC url is not set for method=${method}`);

  const { data } = await axios.post(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  if (data?.error) {
    const msg = data.error?.message || JSON.stringify(data.error);
    throw new Error(`RPC error method=${method}: ${msg}`);
  }

  return data?.result;
}



async function xaddBlockEvent(event) {
  // XADD <stream> MAXLEN ~ <N> * field value ...
  // node-redis 버전별 옵션 차이를 피하려고 sendCommand 사용
  await redis.sendCommand([
    "XADD",//스트림 추가 명령어
    BLOCKS_STREAM_KEY,
    "MAXLEN",//최대길이
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    String(event.network),
    "blockNumber",
    String(event.blockNumber),
    "timestamp",
    String(event.timestamp ?? Date.now()),
  ]);
}

async function xaddSuiEvent(event) {
  // Store Sui Move events in a dedicated stream
  await redis.sendCommand([
    "XADD",
    SUI_EVENTS_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    "network",
    "Sui Testnet",
    "checkpoint",
    String(event.checkpoint ?? ""),
    "txDigest",
    String(event.txDigest ?? ""),
    "eventSeq",
    String(event.eventSeq ?? ""),
    "type",
    String(event.type ?? ""),
    "packageId",
    String(event.packageId ?? ""),
    "module",
    String(event.module ?? ""),
    "sender",
    String(event.sender ?? ""),
    "json",
    String(event.json ?? ""),
    "timestamp",
    String(event.timestamp ?? Date.now()),
    "uid",
    String(event.uid ?? ""),
  ]);
}

async function suiGraphql(query, variables) {
  if (!SUI_GRAPHQL_URL) throw new Error("SUI_GRAPHQL_URL is not set");
  const res = await axios.post(
    SUI_GRAPHQL_URL,
    { query, variables },
    { headers: { "Content-Type": "application/json" } }
  );
  if (res?.data?.errors?.length) {
    const msg = res.data.errors?.[0]?.message || JSON.stringify(res.data.errors);
    throw new Error(`Sui GraphQL error: ${msg}`);
  }
  return res?.data?.data;
}

function safeJsonStringify(v, maxLen) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (!s) return "";
    if (typeof maxLen === "number" && Number.isFinite(maxLen) && s.length > maxLen) {
      return s.slice(0, Math.max(0, maxLen)) + "...(truncated)";
    }
    return s;
  } catch {
    return "";
  }
}

// 네트워크별 폴링 간격 (밀리초)
const POLYGON_POLL_INTERVAL = Number(process.env.POLYGON_POLL_INTERVAL);
const SUI_POLL_INTERVAL = Number(process.env.SUI_POLL_INTERVAL); 

async function pollPolygonBlock() {
  try {
    // 1. 최신 블록 번호 가져오기
    const blockNumberHex = await rpcHttpCall(POLYGON_RPC_URL, "eth_blockNumber", []);
    if (!blockNumberHex) return;
    const blockNumber = parseInt(String(blockNumberHex), 16);

    // 중복 발행 방지 (폴링 주기 동안 같은 블록이면 스킵)
    const lastKey = "lastBlock:polygon";
    const last = await redis.get(lastKey);
    if (last && Number(last) === blockNumber) return;
    
    const blockInfo = await rpcHttpCall(POLYGON_RPC_URL, "eth_getBlockByNumber", [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);

    const blockTimestamp = parseInt(String(blockInfo?.timestamp), 16) * 1000; // 초 → 밀리초
    console.log("🔹 [Polygon] Latest block:", blockNumber, "timestamp:", blockTimestamp);

    await redis.set(lastKey, String(blockNumber));
    await xaddBlockEvent({
      network: "Polygon Amoy",
      blockNumber: blockNumber,
      timestamp: blockTimestamp,
    });
  } catch (error) {
    console.error("❌ [Polygon] Error:", error?.message || error);
  }
}

// Sui (GraphQL RPC) 체크포인트 폴링
async function pollSuiCheckpoint() {
  try {
    // 최신 체크포인트: query { checkpoint { sequenceNumber } }
    // ref: https://docs.sui.io/concepts/data-access/graphql-rpc
    const res = await axios.post(
      SUI_GRAPHQL_URL,
      {
        query: "query { checkpoint { sequenceNumber } }",
      },
      { headers: { "Content-Type": "application/json" } }
    );
    const seqStr = res?.data?.data?.checkpoint?.sequenceNumber;
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      throw new Error(`Invalid checkpoint sequenceNumber: ${seqStr}`);
    }

    const lastKey = "lastBlock:sui";
    const last = await redis.get(lastKey);
    if (last && Number(last) === seq) return;

    const ts = Date.now();
    console.log("🔹 [Sui] Latest checkpoint:", seq, "recvTimestamp:", ts);

    await redis.set(lastKey, String(seq));
    await xaddBlockEvent({
      network: "Sui Testnet",
      blockNumber: seq,
      timestamp: ts,
    });
  } catch (error) {
    console.error("❌ [Sui] Error:", error?.message || error);
  }
}

// Sui (GraphQL RPC) 이벤트 폴링 (cursor 기반)
async function pollSuiEvents() {
  try {
    const cursorKey = "sui:lastEventCursor";
    let cursor = await redis.get(cursorKey);

    // 최초 실행 시, 과거 전체 이벤트를 쓸어오지 않도록 "최신부터" 시작하게 할 수 있음
    if (!cursor && SUI_EVENTS_START_FROM_LATEST) {
      try {
        const data = await suiGraphql(
          "query { events(last: 1) { pageInfo { endCursor } } }",
          {}
        );
        const endCursor = data?.events?.pageInfo?.endCursor;
        if (typeof endCursor === "string" && endCursor.length > 0) {
          await redis.set(cursorKey, endCursor);
          return;
        }
      } catch (e) {
        // 스키마가 last를 지원하지 않으면, 그냥 처음부터(또는 after=null) 소량만 가져오도록 진행
        console.error("❌ [Sui][events] init-from-latest failed:", e?.message || e);
      }
    }

    const query = `
      query ($first: Int!, $after: String) {
        events(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            sequenceNumber
            timestamp
            sender { address }
            transaction { digest }
            transactionModule { name package { digest } }
            contents { type { repr } json }
          }
        }
      }
    `;

    const first = Number.isFinite(SUI_EVENTS_PAGE_SIZE) ? SUI_EVENTS_PAGE_SIZE : 50;
    const maxPages =
      Number.isFinite(SUI_EVENTS_MAX_PAGES_PER_TICK) ? SUI_EVENTS_MAX_PAGES_PER_TICK : 5;

    let pages = 0;
    while (pages < maxPages) {
      pages += 1;
      const data = await suiGraphql(query, {
        first,
        after: cursor || null,
      });

      const nodes = data?.events?.nodes || [];
      const pageInfo = data?.events?.pageInfo;
      const endCursor = pageInfo?.endCursor;
      const hasNextPage = Boolean(pageInfo?.hasNextPage);

      for (const n of nodes) {
        const txDigest = n?.transaction?.digest;
        const eventSeq = n?.sequenceNumber;
        const uid = txDigest && eventSeq != null ? `${txDigest}:${eventSeq}` : "";

        const checkpoint = undefined;
        const sender = n?.sender?.address;
        const moduleName = n?.transactionModule?.name;
        const packageId = n?.transactionModule?.package?.digest;

        const type = n?.contents?.type?.repr;
        const json = safeJsonStringify(n?.contents?.json, SUI_EVENT_JSON_MAXLEN);

        const tsNum = Number(n?.timestamp);
        const ts = Number.isFinite(tsNum) ? tsNum : Date.now();

        await xaddSuiEvent({
          checkpoint,
          txDigest,
          eventSeq,
          type,
          packageId,
          module: moduleName,
          sender,
          json,
          timestamp: ts,
          uid,
        });
      }

      if (typeof endCursor === "string" && endCursor.length > 0) {
        cursor = endCursor;
        await redis.set(cursorKey, cursor);
      }

      if (!hasNextPage) break;
      if (!nodes.length) break;
    }
  } catch (error) {
    console.error("❌ [Sui][events] Error:", error?.message || error);
  }
}

// Solana Devnet: WebSocket 구독으로 슬롯 이벤트 수신 (HTTP 폴링 제거)
const SOLANA_LAST_KEY = "lastBlock:solana";
let lastSolanaSlot = Number((await redis.get(SOLANA_LAST_KEY)) || 0);
//마지막으로 받은 Solana 슬롯 번호를 저장


function startSolanaSlotSubscription() {
  const subscriber = new SolanaSlotSubscriber({
    wsUrl: SOLANA_WS_URL,
    rpcUrl: SOLANA_RPC_URL,
    reconcileIntervalMs: SOLANA_RECONCILE_INTERVAL,
    rpcHttpCall,
    getLastSlot: () => lastSolanaSlot,
    setLastSlot: (slot) => {
      lastSolanaSlot = slot;
    },
    onSlot: async (slot, ts) => {
      // at-least-once 보장(중복 가능, 누락 방지)
      await xaddBlockEvent({
        network: "Solana Devnet",
        blockNumber: slot,
        timestamp: ts ?? Date.now(),
      });
      await redis.set(SOLANA_LAST_KEY, String(slot));
    },
  });

  subscriber.start();
}

// function startSolanaUsdtBlockSubscription() {
//   if (!SOLANA_ENABLE_TOKEN_BLOCKSUB) return;
//   if (!SOLANA_WS_URL) {
//     console.error("❌ [Solana][blockSubscribe] SOLANA_WS_URL is not set");
//     return;
//   }
//   if (!SOLANA_USDT_MINT) {
//     console.error("❌ [Solana][blockSubscribe] SOLANA_USDT_MINT is not set (base58 mint address)");
//     return;
//   }

//   const subscriber = new SolanaBlockSubscriber({
//     wsUrl: SOLANA_WS_URL,
//     subscriptions: [
//       {
//         name: "USDT",
//         mentionsAccountOrProgram: SOLANA_BLOCKSUB_MENTIONS,
//         onBlockNotification: async (msg) => {
//           const value = msg?.params?.result?.value;
//           const slot = value?.slot;
//           const block = value?.block;
//           const blockTime = block?.blockTime ? Number(block.blockTime) * 1000 : Date.now();
//           const txs = Array.isArray(block?.transactions) ? block.transactions : [];

//           let transferCount = 0;
//           for (const tx of txs) {
//             const transfers = extractTokenTransfersFromTx(tx, {
//               tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
//               targetMint: SOLANA_USDT_MINT,
//             });
//             for (const t of transfers) {
//               transferCount += 1;
//               await xaddUsdtTransferEvent({
//                 ...t,
//                 slot: typeof slot === "number" ? slot : undefined,
//                 timestamp: blockTime,
//               });
//             }
//           }

//           if (transferCount > 0) {
//             console.log(
//               `🧾 [Solana][USDT] transfers in slot=${slot}: ${transferCount} (stream=${SOLANA_USDT_STREAM_KEY})`
//             );
//           }
//         },
//       },
//       ...(SOLANA_USDC_MINT
//         ? [
//             {
//               name: "USDC",
//               mentionsAccountOrProgram: SOLANA_BLOCKSUB_MENTIONS,
//               onBlockNotification: async (msg) => {
//                 const value = msg?.params?.result?.value;
//                 const slot = value?.slot;
//                 const block = value?.block;
//                 const blockTime = block?.blockTime ? Number(block.blockTime) * 1000 : Date.now();
//                 const txs = Array.isArray(block?.transactions) ? block.transactions : [];

//                 let transferCount = 0;
//                 for (const tx of txs) {
//                   const transfers = extractTokenTransfersFromTx(tx, {
//                     tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
//                     targetMint: SOLANA_USDC_MINT,
//                   });
//                   for (const t of transfers) {
//                     transferCount += 1;
//                     await xaddUsdcTransferEvent({
//                       ...t,
//                       slot: typeof slot === "number" ? slot : undefined,
//                       timestamp: blockTime,
//                     });
//                   }
//                 }

//                 if (transferCount > 0) {
//                   console.log(
//                     `🧾 [Solana][USDC] transfers in slot=${slot}: ${transferCount} (stream=${SOLANA_USDC_STREAM_KEY})`
//                   );
//                 }
//               },
//             },
//           ]
//         : []),
//     ],
//     commitment: SOLANA_BLOCKSUB_COMMITMENT,
//     encoding: "jsonParsed",
//     transactionDetails: "full",
//     showRewards: false,
//     maxSupportedTransactionVersion: 0,
//   });

//   subscriber.start();
// }

// 각 네트워크를 독립적으로 폴링 (다른 간격으로)
// 즉시 한 번 실행
pollPolygonBlock();
pollSuiCheckpoint();
pollSuiEvents();
startSolanaSlotSubscription();
//startSolanaUsdtBlockSubscription();
 
setInterval(pollPolygonBlock, POLYGON_POLL_INTERVAL);

setInterval(pollSuiCheckpoint, SUI_POLL_INTERVAL);
setInterval(pollSuiEvents, SUI_POLL_INTERVAL);