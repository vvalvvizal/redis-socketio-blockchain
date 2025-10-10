# Socket.IO + Redis Adapter

Socket.IO와 Redis를 활용한 다중 서버 환경에서의 실시간 메시징 시스템

## 🔑 핵심 개념

### Redis Adapter의 역할

- **수평 확장(Scale-out) 가능**: 여러 서버 인스턴스를 실행해도 모든 클라이언트가 동일한 메시지를 받음
- **Pub/Sub 패턴**: Redis의 Publish/Subscribe 메커니즘을 활용
- **서버 간 메시지 동기화**: 한 서버에서 발생한 이벤트를 모든 서버에 전파

### 동작 흐름

```
클라이언트A → Server1(3000) → Redis Pub/Sub → Server2(3001) → 클라이언트B
                    ↓                              ↓
                클라이언트A                      클라이언트B
                (메시지 받음)                    (메시지 받음)
```

1. 클라이언트A가 Server1(포트 3000)에 연결하여 `'hello world'` 메시지 전송
2. Server1이 메시지를 받고 `io.emit()`으로 브로드캐스트
3. Redis Adapter가 메시지를 Redis에 **Publish**
4. Server2의 Redis Adapter가 메시지를 **Subscribe**하여 수신
5. Server1과 Server2에 연결된 **모든 클라이언트**가 메시지를 받음

## 🛠️ 설치 방법

### 1. 의존성 설치

```bash
npm install
```

설치되는 패키지:
- `socket.io`: Socket.IO 서버
- `socket.io-client`: Socket.IO 클라이언트
- `redis`: Redis 클라이언트
- `@socket.io/redis-adapter`: Socket.IO용 Redis 어댑터

### 2. Redis 서버 실행

```bash
# Redis 설치 (macOS)
brew install redis

# Redis 서버 시작
redis-server

# 또는 백그라운드 실행
brew services start redis

# Redis 연결 확인
redis-cli ping  # PONG 응답이 나와야 함
```

## 🚀 실행 방법

총 **3개의 터미널**이 필요합니다:

### 터미널 1: Server1 실행
```bash
node server1.js
```

출력 예시:
```
[Server 3000] Redis PubClient 연결 성공
[Server 3000] Redis SubClient 연결 성공
[Server 3000] Redis Adapter 설정 완료
Socket.IO server listening on port 3000
```

### 터미널 2: Server2 실행
```bash
node server2.js
```

출력 예시:
```
[Server 3001] Redis PubClient 연결 성공
[Server 3001] Redis SubClient 연결 성공
[Server 3001] Redis Adapter 설정 완료
Socket.IO server listening on port 3001
```

### 터미널 3: Client 실행
```bash
node client.js
```

출력 예시:
```
connected: [socket-id]
Received: From server 3000: hello world
```

## 🧪 테스트 방법

### 기본 테스트
1. Server1, Server2를 각각 실행
2. Client를 실행하여 메시지 전송 확인

### Redis 동작 확인
여러 클라이언트를 동시에 실행하여 테스트:

```bash
# 터미널 3
node client.js  # Server1(3000)에 연결

# 터미널 4에서 Server2로 연결하는 클라이언트 실행
# client.js를 복사하여 포트 3001로 변경 후 실행
```

두 클라이언트 모두 같은 메시지를 받으면 Redis Adapter가 정상 작동하는 것입니다.

## 📁 파일 구조

```
.
├── server1.js          # Socket.IO 서버 (포트 3000)
├── server2.js          # Socket.IO 서버 (포트 3001)
├── client.js           # Socket.IO 클라이언트
├── package.json        # 프로젝트 의존성
└── README.md           # 프로젝트 문서
```

## 🔍 코드 설명

### Server (server1.js, server2.js)

- **Redis 클라이언트 생성**: PubClient와 SubClient 두 개 필요
- **Redis Adapter 설정**: `io.adapter(createAdapter(pubClient, subClient))`
- **메시지 브로드캐스트**: `io.emit()`으로 모든 클라이언트에게 전송

### Client (client.js)

- **서버 연결**: `io('http://localhost:3000')`
- **메시지 전송**: `socket.emit('msg', 'hello world')`
- **메시지 수신**: `socket.on('msg', callback)`

## ⚠️ 문제 해결

### 포트 이미 사용 중 (EADDRINUSE)
```bash
# 포트 사용 중인 프로세스 확인
lsof -ti:3000
lsof -ti:3001

# 프로세스 종료
kill -9 <PID>

# 또는 한 번에
lsof -ti:3000,3001 | xargs kill -9
```

### Redis 연결 실패
```bash
# Redis 서버 상태 확인
redis-cli ping

# Redis 재시작
brew services restart redis
```

## 💡 활용 예시

이 패턴은 다음과 같은 경우에 유용합니다:

- **채팅 애플리케이션**: 여러 서버에 분산된 사용자들 간 실시간 메시징
- **실시간 알림 시스템**: 모든 서버에서 동일한 알림 전파
- **협업 도구**: 다중 서버 환경에서 실시간 동기화
- **로드 밸런싱**: 여러 서버로 부하 분산하면서도 메시지 동기화 유지

## 📚 참고 자료

- [Socket.IO 공식 문서](https://socket.io/docs/v4/)
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)

