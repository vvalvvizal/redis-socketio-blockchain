// import { Server } from "socket.io";
// import { createClient } from "redis";
// import http from "http";

// const httpServer = http.createServer();
// const io = new Server(httpServer, { cors: { origin: "*" } });

// const redis = createClient();
// await redis.connect();

// redis.subscribe("new_block", (message) => {
//   const { blockNumber } = JSON.parse(message);
//   console.log("📡 New block broadcast:", blockNumber);
//   io.emit("new_block", { blockNumber });
// });

// io.on("connection", (socket) => {
//   console.log("✅ Client connected:", socket.id);
// });

// httpServer.listen(4001, () => {
//   console.log("Socket.IO Subscriber running on 4001");
// });
