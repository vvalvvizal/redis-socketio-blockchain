const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

async function start(port) {
  const pubClient = createClient({ url: 'redis://localhost:6379' });
  const subClient = pubClient.duplicate();
  
  // Redis 연결 이벤트 리스너
  pubClient.on('connect', () => {
    console.log(`[Server ${port}] Redis PubClient 연결 성공`);
  });
  
  subClient.on('connect', () => {
    console.log(`[Server ${port}] Redis SubClient 연결 성공`);
  });
  
  pubClient.on('error', (err) => {
    console.error(`[Server ${port}] Redis PubClient 에러:`, err);
  });
  
  subClient.on('error', (err) => {
    console.error(`[Server ${port}] Redis SubClient 에러:`, err);
  });

  await pubClient.connect();
  await subClient.connect();

  const httpServer = createServer();
  const io = new Server(httpServer);

  io.adapter(createAdapter(pubClient, subClient));
  console.log(`[Server ${port}] Redis Adapter 설정 완료`);

  io.on('connection', (socket) => {
    console.log(`[Server ${port}] client connected:`, socket.id);
    socket.on('msg', (data) => {
      console.log(`[Server ${port}] received msg:`, data);
      console.log(`[Server ${port}] broadcasting via Redis...`);
      io.emit('msg', `From server ${port}: ${data}`);
    });
  });

  httpServer.listen(port, () => {
    console.log(`Socket.IO server listening on port ${port}`);
  });
}

start(3000);
