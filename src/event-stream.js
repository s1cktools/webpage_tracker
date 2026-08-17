const crypto = require("node:crypto");
const { Server } = require("socket.io");

let eventsNamespace = null;

function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function attachEventStream(httpServer, ServerClass = Server) {
  const expectedToken = process.env.EVENT_STREAM_TOKEN;
  if (!expectedToken) {
    console.log("[event-stream] disabled");
    return null;
  }

  const io = new ServerClass(httpServer);
  eventsNamespace = io.of("/events");
  eventsNamespace.use((socket, next) => {
    if (tokensMatch(socket.handshake.auth?.token, expectedToken)) return next();
    return next(new Error("Unauthorized"));
  });
  eventsNamespace.on("connection", (socket) => {
    console.log(`[event-stream] subscriber connected: ${socket.id}`);
    socket.on("disconnect", () => {
      console.log(`[event-stream] subscriber disconnected: ${socket.id}`);
    });
  });
  console.log("[event-stream] listening on /events");
  return io;
}

function emitTrackerEvent(event) {
  if (!eventsNamespace) return false;
  eventsNamespace.emit("tracker_event", event);
  return true;
}

module.exports = {
  attachEventStream,
  emitTrackerEvent,
  tokensMatch,
};
