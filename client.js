const { io } = require('socket.io-client');

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('connected:', socket.id);
  socket.emit('msg', 'hello world');
});

socket.on('msg', (data) => {
  console.log('Received:', data);
});
