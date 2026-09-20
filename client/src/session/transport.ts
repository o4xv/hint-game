import type { ClientToServerEvents, ServerToClientEvents } from "@hint/contracts";
import type { Socket } from "socket.io-client";
import type { SessionTransport } from "./controller";

export function createSocketTransport(
  socket: Socket<ServerToClientEvents, ClientToServerEvents>,
): SessionTransport {
  // Socket.IO combines reserved and application event conditional types. This adapter
  // exposes only the same application map, keeping each event/payload pair typed.
  const on = socket.on.bind(socket) as SessionTransport["on"];
  const off = socket.off.bind(socket) as SessionTransport["off"];
  const emit = socket.emit.bind(socket) as SessionTransport["emit"];
  return {
    get connected() {
      return socket.connected;
    },
    get active() {
      return socket.active;
    },
    on,
    off,
    emit,
    connect() {
      socket.connect();
    },
    onConnection(callback) {
      const connected = () => {
        callback(true);
      };
      const disconnected = () => {
        callback(false);
      };
      socket.on("connect", connected);
      socket.on("disconnect", disconnected);
      return () => {
        socket.off("connect", connected);
        socket.off("disconnect", disconnected);
      };
    },
  };
}
