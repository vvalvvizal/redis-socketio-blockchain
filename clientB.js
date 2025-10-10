const { io } = require('socket.io-client');

// Server2 (포트 3001)에 연결
const socket = io('http://localhost:3001');

socket.on('connect', () => {
  console.log('[Client B] connected to Server 3001:', socket.id);
  // Client B는 메시지를 보내지 않고 수신만 함
});

socket.on('msg', (data) => {
  console.log('[Client B] Received:', data);
});

socket.on('disconnect', () => {
  console.log('[Client B] disconnected');
});

