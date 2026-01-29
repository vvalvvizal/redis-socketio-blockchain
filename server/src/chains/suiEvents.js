/**
 * Sui: 이벤트 수집 - GraphQL events(first, after) 폴링
 * sui:events 스트림에 적재.
 */

import axios from "axios";

const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL;
const SUI_EVENTS_STREAM_KEY = process.env.SUI_EVENTS_STREAM_KEY || "sui:events";
const SUI_EVENTS_PAGE_SIZE = Number(process.env.SUI_EVENTS_PAGE_SIZE || 50);
const SUI_EVENTS_MAX_PAGES_PER_TICK = Number(process.env.SUI_EVENTS_MAX_PAGES_PER_TICK || 5);
const SUI_EVENTS_START_FROM_LATEST =
  String(process.env.SUI_EVENTS_START_FROM_LATEST || "true").toLowerCase() === "true";
const SUI_EVENT_JSON_MAXLEN = Number(process.env.SUI_EVENT_JSON_MAXLEN || 2000);
const SUI_POLL_INTERVAL = Number(process.env.SUI_POLL_INTERVAL);
const CURSOR_KEY = "sui:lastEventCursor";

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

const eventsQuery = `
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

export async function pollSuiEvents(redis, deps) {
  if (!SUI_GRAPHQL_URL) return;
  try {
    let cursor = await redis.get(CURSOR_KEY);

    if (!cursor && SUI_EVENTS_START_FROM_LATEST) {
      try {
        const data = await suiGraphql(
          "query { events(last: 1) { pageInfo { endCursor } } }",
          {}
        );
        const endCursor = data?.events?.pageInfo?.endCursor;
        if (typeof endCursor === "string" && endCursor.length > 0) {
          await redis.set(CURSOR_KEY, endCursor);
          return;
        }
      } catch (e) {
        console.error("❌ [Sui][events] init-from-latest failed:", e?.message || e);
      }
    }

    const first = Number.isFinite(SUI_EVENTS_PAGE_SIZE) ? SUI_EVENTS_PAGE_SIZE : 50;
    const maxPages = Number.isFinite(SUI_EVENTS_MAX_PAGES_PER_TICK) ? SUI_EVENTS_MAX_PAGES_PER_TICK : 5;

    let pages = 0;
    while (pages < maxPages) {
      pages += 1;
      const data = await suiGraphql(eventsQuery, {
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

        const sender = n?.sender?.address;
        const moduleName = n?.transactionModule?.name;
        const packageId = n?.transactionModule?.package?.digest;
        const type = n?.contents?.type?.repr;
        const json = deps.safeJsonStringify(n?.contents?.json, SUI_EVENT_JSON_MAXLEN);
        const tsNum = Number(n?.timestamp);
        const ts = Number.isFinite(tsNum) ? tsNum : Date.now();

        await deps.xaddSuiEvent({
          checkpoint: undefined,
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
        await redis.set(CURSOR_KEY, cursor);
      }

      if (!hasNextPage) break;
      if (!nodes.length) break;
    }
  } catch (error) {
    console.error("❌ [Sui][events] Error:", error?.message || error);
  }
}

export function startSuiEvents(redis, deps) {
  pollSuiEvents(redis, deps);
  if (Number.isFinite(SUI_POLL_INTERVAL) && SUI_POLL_INTERVAL > 0) {
    setInterval(() => pollSuiEvents(redis, deps), SUI_POLL_INTERVAL);
  }
}
