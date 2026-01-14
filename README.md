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

## 📚 참고 자료

- [Socket.IO](https://socket.io/docs/v4/)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)
