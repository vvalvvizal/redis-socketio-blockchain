/**
 * Sui: 체크포인트 + 이벤트 수집 (GraphQL 폴링)
 * 체크포인트 → blocks:stream, 이벤트 → sui:events. env 없으면 no-op.
 */

import * as suiCheckpoints from "./suiCheckpoints.js";
import * as suiEvents from "./suiEvents.js";

const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL;

/** 체인 진입점: 체크포인트 폴링 + 이벤트 폴링 */
export function start(redis, deps) {
  if (!String(SUI_GRAPHQL_URL || "").trim()) return;
  suiCheckpoints.startSuiCheckpoints(redis, deps);
  suiEvents.startSuiEvents(redis, deps);
}
