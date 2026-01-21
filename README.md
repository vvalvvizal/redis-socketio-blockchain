# 실시간 블록 익스플로러

Socket.IO + Redis Streams 기반 멀티체인(Polygon / Solana / Sui) 실시간 모니터링.

## 빠른 시작

### 설치

```bash
npm install
```

### 환경변수 (.env)

```bash
# Redis
REDIS_URL=

# Server
PORT=

# Polygon (HTTP)
POLYGON_RPC_URL=
POLYGON_POLL_INTERVAL=

# Solana (WS + HTTP)
SOLANA_WS_URL=
SOLANA_RPC_URL=
SOLANA_RECONCILE_INTERVAL=

# Sui (GraphQL)
SUI_GRAPHQL_URL=
SUI_POLL_INTERVAL=
```

선택(기본값 있음):

```bash
# Streams
BLOCKS_STREAM_KEY=blocks:stream
BLOCKS_STREAM_MAXLEN=
BLOCKS_STREAM_GROUP=socketio
BLOCKS_STREAM_CONSUMER=

# Sui events stream
SUI_EVENTS_STREAM_KEY=sui:events
SUI_EVENTS_PAGE_SIZE=
SUI_EVENTS_MAX_PAGES_PER_TICK=
SUI_EVENTS_START_FROM_LATEST=
SUI_EVENT_JSON_MAXLEN=

# HTTP timeout
RPC_HTTP_TIMEOUT_MS=
```

### 실행

```bash
# 터미널 1: Socket.IO + API 서버
npm start

# 터미널 2: polling/subscribe 프로세스(Streams 적재)
npm run polling
```

브라우저: `http://localhost:4000`

## 아키텍처

```
┌──────────────────────────┐
│ block-polling.js          │
│ - Polygon: HTTP polling   │
│ - Solana: WS subscribe    │
│   + HTTP reconcile/catchup│
│ - Sui: GraphQL polling    │
└─────────────┬────────────┘
              │ XADD
              ▼
        ┌───────────┐
        │ Redis      │
        │ Streams    │  blocks:stream, sui:events ...
        └─────┬─────┘
              │ XREADGROUP / XACK
              ▼
┌──────────────────────────┐
│ index.js                  │
│ - Socket.IO + HTTP API     │
│ - stream consumer          │
└─────────────┬────────────┘
              │ WebSocket
              ▼
        ┌───────────┐
        │ Browser UI │  server/public/index.html
        └───────────┘
```

## 데이터 흐름(핵심)

- `server/src/block-polling.js`
  - Polygon: HTTP 폴링 → `blocks:stream`에 적재
  - Solana: WS(`slotSubscribe`)로 슬롯 수신 + HTTP(`getSlot`)로 정합성/캐치업 → `blocks:stream`에 적재
  - Sui: GraphQL `events` cursor 폴링 → `sui:events`에 적재

- `server/src/index.js`
  - Redis Streams(`blocks:stream`, `sui:events` 등)을 `XREADGROUP`으로 소비
  - Socket.IO로 브라우저에 실시간 push
  - Explorer용 API 제공(Sui/Solana 상세 조회)

## Redis Streams

- 블록/슬롯 스트림: `blocks:stream` (기본)
  - fields: `network`, `blockNumber`, `timestamp`

- Sui 이벤트 스트림: `sui:events` (기본)
  - fields 예: `txDigest`, `eventSeq`, `type`, `sender`, `json`, `timestamp` ...

## Explorer API

### Sui

- 체크포인트의 트랜잭션 목록:
  - `GET /api/sui/checkpoint/:seq`
- 트랜잭션 상세(effects/events/objectChanges 등):
  - `GET /api/sui/tx/:digest`

> Sui GraphQL은 엔드포인트/스키마 버전에 따라 필드가 달라질 수 있습니다. 특정 필드 오류가 나면 쿼리를 스키마에 맞게 조정해야 합니다.

### Solana

- 슬롯의 시그니처 목록(getBlock → signatures):
  - `GET /api/solana/slot/:slot?limit=30`
- 시그니처의 트랜잭션 상세(getTransaction → meta/logMessages 등):
  - `GET /api/solana/tx/:sig`
