const { io } = require('socket.io-client');

// Server1 (포트 3000)에 연결
const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('[Client A] connected to Server 3000:', socket.id);
  socket.emit('msg', 'hello world');
});

socket.on('msg', (data) => {
  console.log('[Client A] Received:', data);
});

socket.on('disconnect', () => {
  console.log('[Client A] disconnected');
});
