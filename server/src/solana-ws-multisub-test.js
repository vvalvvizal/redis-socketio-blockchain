import WebSocket from "ws";

function bool(v) {
  return String(v || "false").toLowerCase() === "true";
}

function previewJson(v, max = 2000) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[k] = next;
      i += 1;
    } else {
      out[k] = true;
    }
  }
  return out;
}

/**
 * Solana JSON-RPC WS 한 연결에서 여러 구독 동시 테스트.
 *
 * 실행 예:
 *   SOLANA_WS_URL=wss://api.devnet.solana.com npm run solana:ws:test
 *
 * 옵션:
 *   --seconds 15
 *   --mentions Vote111111111111111111111111111111111111111
 *   --sig <txSignature>   (있으면 signatureSubscribe도 추가)
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wsUrl =
    process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com";
  // NOTE: 테스트 환경에서 TLS 체인 문제로 연결이 막힐 때만 사용하세요.
  // 로컬에서 기본은 false 권장.
  if (bool(process.env.WS_INSECURE_TLS)) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.log("⚠️  [Solana][ws-multisub] WS_INSECURE_TLS=true (TLS 검증 비활성화)");
  }
  const seconds = Number(args.seconds || process.env.WS_TEST_SECONDS || 15);
  const mentions =
    args.mentions ||
    process.env.SOLANA_LOGS_MENTIONS ||
    "Vote111111111111111111111111111111111111111";
  const sig = args.sig || process.env.SOLANA_SIG || "";

  const commitment = process.env.SOLANA_WS_COMMITMENT || "processed";
  const debugRaw = bool(process.env.SOLANA_DEBUG_WS_RAW);

  let reqId = Math.floor(Date.now() % 1_000_000_000);
  const reqIdToName = new Map();
  const subs = new Map(); // name -> subscriptionId

  console.log("🧪 [Solana][ws-multisub] connecting:", wsUrl);
  const ws = new WebSocket(wsUrl);

  const send = (name, method, params = []) => {
    reqId += 1;
    const id = reqId;
    reqIdToName.set(id, name);
    const payload = { jsonrpc: "2.0", id, method, params };
    ws.send(JSON.stringify(payload));
    console.log(`➡️  [Solana][ws:req] ${name} method=${method} id=${id}`);
  };

  const closeWith = (code, reason) => {
    try {
      ws.close(code, reason);
    } catch {}
  };

  ws.on("open", () => {
    console.log("✅ [Solana][ws-multisub] connected");

    // 1) slotSubscribe
    // NOTE: 일부 RPC 노드는 slotSubscribe에 params를 허용하지 않습니다.
    send("slot", "slotSubscribe", []);

    // 2) logsSubscribe (mentions 기반 필터)
    // Solana WS: logsSubscribe(filter, config)
    send("logs", "logsSubscribe", [{ mentions: [mentions] }, { commitment }]);

    // 3) (옵션) signatureSubscribe
    if (sig) {
      send("sig", "signatureSubscribe", [sig, { commitment }]);
    }

    console.log(
      `⏱️  [Solana][ws-multisub] will run for ${seconds}s (commitment=${commitment}, mentions=${mentions}${sig ? ", signature=on" : ""})`
    );
    setTimeout(() => {
      console.log("🧪 [Solana][ws-multisub] done. closing...");
      closeWith(1000, "done");
    }, Math.max(1, seconds) * 1000);
  });

  ws.on("message", (raw) => {
    const s = raw?.toString?.() || "";
    if (debugRaw) console.log("🛰️  [Solana][ws:raw]", s.length > 2000 ? s.slice(0, 2000) + "...(truncated)" : s);

    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      console.log("❌ [Solana][ws-multisub] invalid json:", s.slice(0, 300));
      return;
    }

    // ACK: { id, result: <subscriptionId> }
    if (typeof msg?.id === "number" && Object.prototype.hasOwnProperty.call(msg, "result")) {
      //
      const name = reqIdToName.get(msg.id) || "unknown";
      subs.set(name, msg.result);
      console.log(`✅ [Solana][ws:ack] ${name} subscriptionId=${msg.result}`);
      return;
    }

    if (msg?.error) {
      console.error("❌ [Solana][ws:error]", previewJson(msg.error, 1200));
      return;
    }

    // Notifications
    if (msg?.method === "slotNotification") {
      const slot = msg?.params?.result?.slot;
      console.log("🔹 [Solana][slotNotification]", slot);
      return;
    }
    if (msg?.method === "logsNotification") {
      const v = msg?.params?.result?.value;
      const sig2 = v?.signature;
      const err = v?.err;
      const logs = Array.isArray(v?.logs) ? v.logs.length : 0;
      console.log(`🪵 [Solana][logsNotification] sig=${sig2} err=${err ? "yes" : "no"} logs=${logs}`);
      if (logs > 0) console.log("   - firstLog:", String(v.logs[0]).slice(0, 200));
      return;
    }
    if (msg?.method === "signatureNotification") {
      const v = msg?.params?.result;
      const err = v?.err;
      console.log(`🧾 [Solana][signatureNotification] err=${err ? "yes" : "no"} result=${previewJson(v, 800)}`);
      return;
    }

    // 기타 메시지
    console.log("📩 [Solana][ws:msg]", previewJson(msg, 1200));
  });

  ws.on("unexpected-response", (_req, res) => {
    console.error("❌ [Solana][ws-multisub] unexpected response:", res?.statusCode, res?.statusMessage);
  });
  ws.on("error", (e) => console.error("❌ [Solana][ws-multisub] error:", e?.message || e));
  ws.on("close", (code, reason) => {
    console.log("👋 [Solana][ws-multisub] closed:", code, reason?.toString?.() || "");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("❌ [Solana][ws-multisub] fatal:", e?.message || e);
  process.exit(1);
});

