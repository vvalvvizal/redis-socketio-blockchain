# 실시간 블록 익스플로러

Socket.IO + Redis Streams 기반 멀티체인(Polygon / Solana / Sui) 실시간 모니터링.

## 빠른 시작

### 설치

```bash
npm install
```

### 환경변수 (.env)

| 구분 | 변수 | 설명 |
|------|------|------|
| **공통** | `REDIS_URL` | Redis 연결 URL |
| **서버** | `PORT` | HTTP 서버 포트 (기본 4000) |
| **Polygon** | `POLYGON_RPC_URL` | Polygon RPC (HTTP) |
| | `POLYGON_WS_URL` | Polygon WebSocket (선택, newHeads + logs) |
| | `POLYGON_POLL_INTERVAL` | HTTP 블록 폴링 간격(ms) |
| | `POLYGON_LOGS_ADDRESS` | 로그 필터 주소 (선택) |
| | `POLYGON_LOGS_TOPIC0` | 로그 필터 topic0 (선택) |
| **Solana** | `SOLANA_WS_URL` | Solana WebSocket |
| | `SOLANA_RPC_URL` | Solana RPC (HTTP, reconcile용) |
| | `SOLANA_RECONCILE_INTERVAL` | getSlot reconcile 간격(ms) |
| **Sui** | `SUI_GRAPHQL_URL` | Sui GraphQL 엔드포인트 |
| | `SUI_POLL_INTERVAL` | 체크포인트/이벤트 폴링 간격(ms) |
| **Redis Stream** | `BLOCKS_STREAM_KEY` | 블록/슬롯 스트림 키 |
| | `BLOCKS_STREAM_MAXLEN` | 스트림 최대 길이(~) |
| | `SUI_EVENTS_STREAM_KEY` | Sui 이벤트 스트림 키 |
| | `POLYGON_EVENTS_STREAM_KEY` | Polygon 이벤트 스트림 키 |
| **소비** | `BLOCKS_STREAM_GROUP` | Consumer group 이름 |
| | `BLOCKS_STREAM_CONSUMER` | Consumer 이름 |

설정하지 않은 체인은 해당 체인 수집이 생략된다(no-op).

### 실행

```bash
# 터미널 1: Socket.IO + API 서버
npm start

# 터미널 2: 수집 프로세스 (Redis Stream 적재)
npm run polling
```

브라우저: `http://localhost:4000`

---

## 아키텍처

```
┌─────────────────────────────────────┐
│ block-polling.js                     │
│   chains = [polygon, sui, solana]    │
│   chains.forEach(c => c.start(...))   │
│   └─ chains/polygon.js   (블록+로그) │
│   └─ chains/sui.js       (체크포인트+이벤트) │
│   └─ chains/solana.js    (slot)      │
└─────────────────┬───────────────────┘
                  │ XADD
                  ▼
            ┌───────────┐
            │ Redis     │  blocks:stream, sui:events, polygon:events
            │ Streams   │
            └─────┬─────┘
                  │ XREADGROUP / XACK
                  ▼
┌─────────────────────────────────────┐
│ index.js                            │
│   Socket.IO + HTTP API + stream 소비 │
└─────────────────┬───────────────────┘
                  │ WebSocket
                  ▼
            ┌───────────┐
            │ Browser    │  public/index.html
            └───────────┘
```

---

## 데이터 소스

| 체인 | Block/Checkpoint | Event |
|------|------------------|--------|
| **Polygon** | HTTP `eth_blockNumber` 폴링 + WS `eth_subscribe("newHeads")` | WS `eth_subscribe("logs")` + `eth_getLogs` 백필 (POLYGON_LOGS_ADDRESS, POLYGON_LOGS_TOPIC0) |
| **Solana** | WS `slotSubscribe` + HTTP `getSlot` reconcile | — |
| **Sui** | GraphQL `checkpoint { sequenceNumber }` 폴링 | GraphQL `events(first, after)` 폴링 |

---

## 데이터 흐름

- **block-polling.js**
  - 체인당 `chains/<체인명>.js`의 `start(redis, deps)` 호출. env가 없으면 해당 체인은 no-op.
  - Polygon: 블록 → `blocks:stream`, 로그 → `polygon:events`
  - Solana: 슬롯 → `blocks:stream`
  - Sui: 체크포인트 → `blocks:stream`, 이벤트 → `sui:events`

- **index.js**
  - `blocks:stream`, `sui:events`, `polygon:events`를 `XREADGROUP`으로 소비 후 Socket.IO로 브라우저에 push.
  - Explorer용 REST API 제공.

---

## Redis Streams

| 스트림 | 용도 | 주요 필드 |
|--------|------|-----------|
| `blocks:stream` | 블록/슬롯/체크포인트 | `network`, `blockNumber`, `timestamp` |
| `sui:events` | Sui Move 이벤트 | `txDigest`, `eventSeq`, `type`, `sender`, `json`, `timestamp` |
| `polygon:events` | Polygon 로그 | `network`, `blockNumber`, `txHash`, `logIndex`, `address`, `topics`, `data`, `timestamp` |

**소비:** 세 스트림을 한 번의 `XREADGROUP GROUP <group> <consumer> COUNT 100 BLOCK 5000 STREAMS <key1> <key2> <key3> > > >`로 읽고, 메시지별로 `XACK` 처리.

---

## Explorer API

| 체인 | API |
|------|-----|
| **Polygon** | `GET /api/polygon/block/:n` — 블록의 tx 해시 목록 |
| | `GET /api/polygon/tx/:hash` — 트랜잭션 + receipt |
| **Solana** | `GET /api/solana/slot/:slot` — 슬롯의 시그니처 목록 |
| | `GET /api/solana/tx/:sig` — 트랜잭션 상세 |
| **Sui** | `GET /api/sui/checkpoint/:seq` — 체크포인트의 tx digest 목록 |
| | `GET /api/sui/tx/:digest` — 트랜잭션 상세(effects, events 등) |

---

## 트러블슈팅

- **Solana**  
  - `Block not available for slot` → skipped slot이거나 노드 미보관. `/api/solana/slot/:slot` 응답의 `nearestAvailableSlots` 참고.
- **Redis**  
  - `XLEN <stream>`, `XINFO GROUPS <stream>`로 스트림/그룹 상태 확인.
- **Sui GraphQL**  
  - 엔드포인트/스키마 버전에 따라 필드명이 다를 수 있음. 오류 시 쿼리를 스키마에 맞게 수정.
