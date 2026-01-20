# 실시간 블록 익스플로러

Socket.IO + Redis를 활용한 다중 네트워크 블록체인 실시간 모니터링

![polling](https://github.com/user-attachments/assets/2af97009-56d3-4c81-830b-a30d109fb06f)

## 🚀 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env` 파일 생성:

```bash
POLYGON_RPC_URL=
SOLANA_RPC_URL=
SOLANA_WS_URL=
SOLANA_RECONCILE_INTERVAL=
RPC_HTTP_TIMEOUT_MS=
SUI_GRAPHQL_URL=
SUI_POLL_INTERVAL=
REDIS_URL=
PORT=
```

### 3. Redis 실행

```bash
brew services start redis
# 또는
redis-server
```

### 4. 애플리케이션 실행

```bash
# 터미널 1: Socket.IO 서버
npm start

# 터미널 2: 블록 폴링
npm run polling
```

### 5. 브라우저 접속

```
http://localhost:4000
```

## 📁 프로젝트 구조

```
server/
├── src/
│   ├── index.js          # Socket.IO 서버
│   └── block-polling.js  # 블록 폴링 (Redis Stream 적재)
└── public/
    └── index.html        # 웹 클라이언트
```

## 🏗️ 아키텍처

```
┌─────────────────────┐
│  Block Polling      │  ← Polygon RPC (5초) / Solana WS (slotSubscribe) / Sui GraphQL (2초)
│  (polling.js)       │
└──────────┬──────────┘
           │ XADD (append)
           ↓
    ┌──────────────┐
    │    Redis     │  ← Streams: 이벤트 로그/재처리
    │   Streams    │
    └──────┬───────┘
           │ XREADGROUP (consumer group)
           ↓
┌──────────────────────┐
│  Socket.IO Server    │  ← HTTP 서버 + Socket.IO (포트 4000)
│  (index.js)          │
│  + Redis Adapter     │
└──────────┬───────────┘
           │ WebSocket
           ↓
    ┌──────────────┐
    │  Web Client  │  ← 브라우저 (index.html)
    └──────────────┘
```

### 데이터 흐름

1. **block-polling.js**: Polygon(HTTP 폴링) + Solana(WS 구독) + Sui(GraphQL 폴링) → Redis Stream(`blocks:stream`)에 `XADD`로 적재
2. **index.js**: Redis Stream을 Consumer Group(`socketio`)으로 `XREADGROUP` 소비 → Socket.IO로 모든 클라이언트에 `newBlock` 이벤트 전송
3. **index.html**: Socket.IO 클라이언트로 `newBlock` 이벤트 수신 → UI 업데이트

### 역할 분리

- **block-polling.js**: 블록체인 RPC 폴링 및 Redis Stream 적재 (독립 프로세스)
- **index.js**: Redis Stream 소비 + Socket.IO 서버 (HTTP + WebSocket)
- **index.html**: 실시간 블록 정보 표시 (정적 파일)

## ⚙️ 네트워크 설정

### 지원 네트워크

| 네트워크 | 엔드포인트 | 수집 방식 | 블록/슬롯 생성 속도 | 타입 |
|---------|---------|----------|-------------------|------|
| **Polygon Amoy** | `POLYGON_RPC_URL` | HTTP 폴링 (5초) | ~2초마다 블록 생성 | Testnet |
| **Solana Devnet** | `SOLANA_WS_URL` + `SOLANA_RPC_URL` | WS 구독(`slotSubscribe`) + HTTP 정합성(`getSlot`) | ~400ms마다 슬롯 생성 | Testnet |
| **Sui Testnet** | `SUI_GRAPHQL_URL` | GraphQL 폴링 (`checkpoint { sequenceNumber }`) | 네트워크 상황에 따라 변동 | Testnet |

### 폴링 전략

- **Polygon**: 블록 생성 속도가 상대적으로 느리므로 5초 간격으로 폴링
- **Solana**: 슬롯 생성 속도가 매우 빠르므로 WebSocket 구독(`slotSubscribe`)으로 슬롯 알림을 수신하고,
  누락 방지를 위해 HTTP RPC(`getSlot`)로 최신 슬롯을 주기적으로 확인하여 캐치업(catch-up)합니다.

### 데이터 구조

각 블록/슬롯 정보는 Redis Stream entry의 fields로 저장됩니다(문자열로 저장):

```json
{
  "network": "Polygon Amoy" | "Solana Devnet",
  "blockNumber": 27516385,
  "timestamp": 1697012345000
}
```

- `network`: 네트워크 이름
- `blockNumber`: 블록 번호 (Polygon) 또는 슬롯 번호 (Solana)
- `timestamp`: 블록/슬롯의 실제 생성 타임스탬프 (UTC, 밀리초)

추가로, 서버가 클라이언트로 emit 할 때는 Stream entry id를 `eventId`로 같이 내려줍니다.

## 💻 핵심 코드

### Redis Streams (권장: Stream-only)

**block-polling.js** - Stream 적재(`XADD`):
```javascript
// RPC에서 블록 정보 가져온 후 Redis Stream에 적재
await redis.sendCommand([
  "XADD",
  "blocks:stream",
  "MAXLEN",
  "~",
  "10000",
  "*",
  "network",
  "Polygon Amoy",
  "blockNumber",
  String(blockNumber),
  "timestamp",
  String(Date.now()),
]);
```

**index.js** - Consumer Group 소비(`XREADGROUP` + `XACK`):
```javascript
// XGROUP CREATE blocks:stream socketio $ MKSTREAM (최초 1회)
// XREADGROUP로 계속 읽어서 io.emit 한 뒤, 처리 완료 시 XACK
```

### Socket.IO

**서버 (index.js)**:
```javascript
// Redis Adapter 설정 (여러 서버 간 동기화)
io.adapter(createAdapter(pubClient, subClient));

// 모든 클라이언트에 브로드캐스트
io.emit("newBlock", { network, blockNumber, timestamp });
```

**클라이언트 (index.html)**:
```javascript
const socket = io("http://localhost:4000");

// 서버에서 보낸 메시지 수신
socket.on("newBlock", (data) => {
  // UI 업데이트
  displayBlock(data);
});
```

### Redis Adapter의 역할

Socket.IO Redis Adapter를 사용하면:
- 여러 Socket.IO 서버 인스턴스가 동일한 메시지를 모든 클라이언트에 전송
- 한 서버에서 `io.emit()` 호출 시 다른 서버의 클라이언트도 메시지 수신
- 로드 밸런서 뒤에서 여러 서버를 실행해도 동기화 유지

## ⚠️ 현재 폴링 로직의 문제점 및 개선 가능점

### 예상되는 문제점

1. **중복 블록 발행**
   - 이전 블록 번호를 추적하지 않으면 같은 블록이 여러 번 적재될 수 있음
   - 네트워크 지연 시 동일한 블록을 반복적으로 조회

2. **타임스탬프 지연**
   - 폴링 간격과 블록 생성 속도의 차이로 인해 타임스탬프와 실제 수신 시간에 차이 발생
   - 예: Polygon 5초 폴링 → 최대 5초 지연 가능

3. **RPC 호출 비효율**
   - 각 폴링마다 2번의 RPC 호출 (블록 번호 조회 + 블록 정보 조회)
   - Solana는 블록/슬롯 “이벤트 수신”은 WS 기반이지만, 누락 방지를 위해 HTTP `getSlot` 호출은 사용함
     (대신 WS 재연결/정합성 로직이 중요)

4. **에러 처리 부족**
   - RPC 호출 실패 시 단순 로그만 출력하고 계속 폴링
   - 재시도 로직이나 백오프(backoff) 전략 없음

5. **고정된 폴링 간격**
   - 네트워크 상태나 RPC 응답 속도에 관계없이 고정 간격으로 폴링
   - 네트워크가 느릴 때 불필요한 호출 발생


## 📚 참고 자료

- [Socket.IO](https://socket.io/docs/v4/)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Polygon RPC](https://docs.polygon.technology/docs/develop/network-details/network/)
- [Solana RPC](https://docs.solana.com/api/http)

## 🔧 Streams 설정 (환경변수)

아래는 선택 사항이며, 미설정 시 기본값이 사용됩니다:

- `BLOCKS_STREAM_KEY`: Stream key (기본값: `blocks:stream`)
- `BLOCKS_STREAM_GROUP`: Consumer group (기본값: `socketio`)
- `BLOCKS_STREAM_CONSUMER`: Consumer name (기본값: `socketio-<pid>`)
- `BLOCKS_STREAM_MAXLEN`: Stream 최대 길이 (기본값: `10000`, 근사 trim `MAXLEN ~`)

## 🔧 Sui 설정 (환경변수)

- `SUI_GRAPHQL_URL`: Sui GraphQL RPC 엔드포인트 (기본값: `https://graphql.testnet.sui.io/graphql`)
- `SUI_POLL_INTERVAL`: 체크포인트 폴링 간격(ms) (기본값: `2000`)

## 🔧 Solana 설정 (환경변수)

- `SOLANA_WS_URL`: Solana WebSocket 엔드포인트 (**반드시 `wss://...`**)  
  - 예: Devnet `wss://api.devnet.solana.com`, Mainnet `wss://api.mainnet-beta.solana.com`
- `SOLANA_RPC_URL`: Solana HTTP JSON-RPC 엔드포인트 (**반드시 JSON-RPC를 반환하는 RPC URL**)  
  - 예: Devnet `https://api.devnet.solana.com`, Mainnet `https://api.mainnet-beta.solana.com`
  - 주의: `https://www.quicknode.com/` 같은 “웹사이트 URL”을 넣으면 HTML이 내려와서 `getSlot`이 실패합니다.
- `SOLANA_RECONCILE_INTERVAL`: `getSlot` 기반 정합성 체크 주기(ms) (기본값: `5000`)
- `RPC_HTTP_TIMEOUT_MS`: HTTP RPC 요청 타임아웃(ms) (기본값: `15000`)

### 트러블슈팅

- `❌ [Solana] WS unexpected response: 200 OK`
  - `SOLANA_WS_URL`이 `wss://` WebSocket 엔드포인트가 아니라, `https://` 웹페이지/HTTP URL로 설정된 경우가 많습니다.
- `Invalid RPC response type ... body: <!DOCTYPE html>`
  - `SOLANA_RPC_URL`이 JSON-RPC 엔드포인트가 아니라 웹페이지(HTML)를 반환하는 URL로 설정된 상태입니다.
- 클러스터(Devnet/Mainnet)를 바꿨는데 슬롯이 안 올라오는 경우
  - Redis의 `lastBlock:solana`가 더 큰 값으로 남아 있으면 `slot <= last` 필터에 걸려 이벤트가 전부 스킵될 수 있습니다.
    이 경우 `lastBlock:solana`를 0으로 초기화하고 다시 시작하세요.