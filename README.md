# 실시간 블록 익스플로러 with Socket.IO + Redis

Polygon Amoy 테스트넷의 최신 블록 정보를 실시간으로 브로드캐스팅하는 웹 애플리케이션
##

![Demo](./assets/Oct-13-2025%2018-14-55.gif)



## 🎯 프로젝트 개요

이 프로젝트는 **Redis Pub/Sub**과 **Socket.IO**를 활용하여 여러 서버 인스턴스 간 실시간 데이터 동기화를 구현한 예제입니다.


### 핵심 기능
- 📡 Polygon Amoy 블록체인의 최신 블록 정보를 5초마다 폴링
- 🔄 Redis Pub/Sub을 통한 메시지 브로드캐스팅
- 🌐 Socket.IO를 통한 실시간 웹 클라이언트 업데이트
- ⚡ 여러 Socket.IO 서버 인스턴스 간 데이터 동기화

## 🏗️ 아키텍처

```
┌─────────────────────┐
│  Block Polling      │  ← Polygon RPC 호출 (5초마다)
│  (polling.js)       │
└──────────┬──────────┘
           │ publish
           ↓
    ┌──────────────┐
    │    Redis     │  ← Pub/Sub 메시지 브로커
    └──────┬───────┘
           │ subscribe
           ↓
┌──────────────────────┐
│  Socket.IO Server    │  ← HTTP 서버 + Socket.IO (포트 4000)
│  (index.js)          │
└──────────┬───────────┘
           │ WebSocket
           ↓
    ┌──────────────┐
    │  Web Client  │  ← 브라우저 (index.html)
    └──────────────┘
```

### 역할 분리

1. **block-polling.js**: 블록체인 RPC를 호출하여 최신 블록 번호를 가져와 Redis에 **publish**
2. **index.js**: Redis에서 메시지를 **subscribe**하여 연결된 모든 클라이언트에게 Socket.IO로 전송
3. **index.html**: Socket.IO 클라이언트로 실시간 블록 정보를 화면에 표시

### Redis 사용 이유

- 🔗 **수평 확장**: 여러 Socket.IO 서버 인스턴스를 실행해도 모든 클라이언트가 동일한 데이터 수신
- ⚡ **효율성**: 블록 폴링은 한 곳에서만 수행하고 결과를 모든 서버가 공유
- 🌐 **로드 밸런싱**: 클라이언트를 여러 서버에 분산 가능

## 🛠️ 설치 및 실행

### 1. 의존성 설치

```bash
npm install
```

**설치되는 패키지:**
- `socket.io` - Socket.IO 서버
- `express` - HTTP 서버 및 정적 파일 서빙
- `redis` - Redis 클라이언트
- `@socket.io/redis-adapter` - Socket.IO용 Redis 어댑터
- `axios` - HTTP 클라이언트 (RPC 호출용)

### 2. Redis 서버 실행

```bash
# Redis 설치 (macOS)
brew install redis

# Redis 서버 시작
brew services start redis

# 또는 포그라운드 실행
redis-server

# 연결 확인
redis-cli ping  # PONG 응답 확인
```

### 3. 애플리케이션 실행

**방법 1: 통합 실행 (개발용)**

```bash
# 터미널 1: Socket.IO 서버 실행
npm start
# ✅ Socket.IO server running on http://localhost:4000

# 터미널 2: 블록 폴링 시작
node server/src/block-polling.js
# ✅ Block Polling started - publishing to Redis every 5 seconds
```

**방법 2: 여러 서버 인스턴스 실행 (프로덕션 시뮬레이션)**

```bash
# 터미널 1: 블록 폴링
node server/src/block-polling.js

# 터미널 2: Socket.IO 서버 #1
node server/src/index.js

# 터미널 3: Socket.IO 서버 #2 (포트만 변경)
PORT=4001 node server/src/index.js
```

### 4. 브라우저에서 접속

```
http://localhost:4000
```

실시간으로 블록 정보가 업데이트되는 것을 확인할 수 있습니다!

## 📁 프로젝트 구조

```
Socket.IO-Redis/
├── server/
│   ├── src/
│   │   ├── index.js           # Socket.IO 메인 서버
│   │   ├── block-polling.js   # 블록 폴링 + Redis publish
│   │   └── subscriber.js      # (참고용) 단독 subscriber 예제
│   └── public/
│       └── index.html         # 웹 클라이언트 UI
├── package.json
└── README.md
```

## 🔍 코드 상세 설명

### server/src/block-polling.js

```javascript
// Polygon RPC 호출 → Redis에 publish
async function pollLatestBlock() {
  const { data } = await axios.post("https://rpc-amoy.polygon.technology", {
    method: "eth_blockNumber",
  });
  const blockNumber = parseInt(data.result, 16);
  await redis.publish("new_block", JSON.stringify({ blockNumber }));
}
setInterval(pollLatestBlock, 5000);
```

- Polygon Amoy RPC에서 최신 블록 번호 조회
- 16진수를 10진수로 변환
- Redis `new_block` 채널에 publish

### server/src/index.js

```javascript
// Redis subscribe
subClient.subscribe("new_block", (message) => {
  const data = JSON.parse(message);
  io.emit("newBlock", {
    blockNumber: data.blockNumber,
    timestamp: Date.now()
  });
});
```

- Redis `new_block` 채널을 구독
- 메시지 수신 시 모든 연결된 클라이언트에게 Socket.IO로 전송
- Express로 정적 파일(index.html) 서빙

### server/public/index.html

```javascript
socket.on("newBlock", (data) => {
  // 블록 카드 UI 생성 및 화면에 추가
  blocksContainer.prepend(blockCard);
});
```

- Socket.IO 클라이언트로 서버 연결
- `newBlock` 이벤트 수신 시 UI 업데이트
- 최신 블록을 맨 위에 표시

## 🧪 Redis Pub/Sub 동작 확인

### 터미널에서 직접 확인

```bash
# 터미널 1: Redis subscribe 모니터링
redis-cli
> SUBSCRIBE new_block

# 터미널 2: 블록 폴링 실행
node server/src/block-polling.js

# 터미널 1에서 메시지 수신 확인
1) "message"
2) "new_block"
3) "{\"blockNumber\":27516385}"
```

## ⚠️ 문제 해결

### 포트 사용 중 오류

```bash
lsof -ti:4000 | xargs kill -9
```

### Redis 연결 실패

```bash
# Redis 상태 확인
redis-cli ping

# Redis 재시작
brew services restart redis
```

### 브라우저에서 연결 안됨

1. 브라우저 콘솔(F12) 확인
2. `http://localhost:4000` 주소 정확히 입력 (`http://` 포함)
3. 서버가 실행 중인지 확인
4. 강력 새로고침: `Cmd + Shift + R`

## 📚 참고 자료

- [Socket.IO 공식 문서](https://socket.io/docs/v4/)
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/)
- [Polygon RPC](https://docs.polygon.technology/docs/develop/network-details/network/)

## 📝 라이선스

MIT
