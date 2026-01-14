# 실시간 블록 익스플로러

Socket.IO + Redis를 활용한 다중 네트워크 블록체인 실시간 모니터링

![polling](https://github.com/user-attachments/assets/e8709453-aaab-437c-ba23-074351b7885d)

## 🚀 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env` 파일 생성:

```bash
POLYGON_RPC_URL=https://rpc-amoy.polygon.technology
SOLANA_RPC_URL=https://api.devnet.solana.com
REDIS_URL=redis://localhost:6379
PORT=4000
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
│   └── block-polling.js  # 블록 폴링 (Redis publish)
└── public/
    └── index.html        # 웹 클라이언트
```

## 🏗️ 아키텍처

```
┌─────────────────────┐
│  Block Polling      │  ← Polygon RPC (5초) / Solana RPC (0.5초)
│  (polling.js)       │
└──────────┬──────────┘
           │ publish
           ↓
    ┌──────────────┐
    │    Redis     │  ← Pub/Sub 메시지 브로커
    │   Pub/Sub    │
    └──────┬───────┘
           │ subscribe
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

1. **block-polling.js**: Polygon & Solana RPC 호출 → Redis `new_block` 채널에 publish
2. **index.js**: Redis에서 subscribe → Socket.IO로 모든 클라이언트에 `newBlock` 이벤트 전송
3. **index.html**: Socket.IO 클라이언트로 `newBlock` 이벤트 수신 → UI 업데이트

### 역할 분리

- **block-polling.js**: 블록체인 RPC 폴링 및 Redis publish (독립 프로세스)
- **index.js**: Redis subscribe + Socket.IO 서버 (HTTP + WebSocket)
- **index.html**: 실시간 블록 정보 표시 (정적 파일)

## ⚙️ 네트워크 설정

### 지원 네트워크

| 네트워크 | RPC URL | 폴링 간격 | 블록/슬롯 생성 속도 | 타입 |
|---------|---------|----------|-------------------|------|
| **Polygon Amoy** | `https://rpc-amoy.polygon.technology` | 5초 | ~2초마다 블록 생성 | Testnet |
| **Solana Devnet** | `https://api.devnet.solana.com` | 0.5초 (500ms) | ~400ms마다 슬롯 생성 | Testnet |

### 폴링 전략

- **Polygon**: 블록 생성 속도가 상대적으로 느리므로 5초 간격으로 폴링
- **Solana**: 슬롯 생성 속도가 매우 빠르므로 0.5초 간격으로 폴링하여 최신 슬롯 추적

### 데이터 구조

각 블록/슬롯 정보는 다음 형식으로 Redis에 publish됩니다:

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

## 💻 핵심 코드

### Redis Pub/Sub

**block-polling.js** - 메시지 발행:
```javascript
// RPC에서 블록 정보 가져온 후 Redis에 publish
await redis.publish("new_block", JSON.stringify({
  network: "Polygon Amoy",
  blockNumber: blockNumber,
  timestamp: Date.now()
}));
```

**index.js** - 메시지 구독:
```javascript
// Redis에서 메시지 구독
subClient.subscribe("new_block", (message) => {
  const data = JSON.parse(message);
  // Socket.IO로 모든 클라이언트에 전송
  io.emit("newBlock", data);
});
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
   - 이전 블록 번호를 추적하지 않아 같은 블록이 여러 번 publish될 수 있음
   - 네트워크 지연 시 동일한 블록을 반복적으로 조회

2. **타임스탬프 지연**
   - 폴링 간격과 블록 생성 속도의 차이로 인해 타임스탬프와 실제 수신 시간에 차이 발생
   - 예: Polygon 5초 폴링 → 최대 5초 지연 가능

3. **RPC 호출 비효율**
   - 각 폴링마다 2번의 RPC 호출 (블록 번호 조회 + 블록 정보 조회)
   - Solana의 경우 `getBlockTime`이 `null`을 반환할 수 있으나 처리되지 않음

4. **에러 처리 부족**
   - RPC 호출 실패 시 단순 로그만 출력하고 계속 폴링
   - 재시도 로직이나 백오프(backoff) 전략 없음

5. **고정된 폴링 간격**
   - 네트워크 상태나 RPC 응답 속도에 관계없이 고정 간격으로 폴링
   - 네트워크가 느릴 때 불필요한 호출 발생


## 📚 참고 자료

- [Socket.IO](https://socket.io/docs/v4/)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)
- [Polygon RPC](https://docs.polygon.technology/docs/develop/network-details/network/)
- [Solana RPC](https://docs.solana.com/api/http)