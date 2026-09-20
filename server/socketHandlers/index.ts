import type { GameIO } from "../types.js";
import { setupRoomHandlers } from "./roomHandlers.js";
import { setupGameHandlers } from "./gameHandlers.js";
import { setupDisconnectHandler } from "./disconnectHandler.js";

export function registerHandlers(io: GameIO) {
  io.on("connection", (socket) => {
    setupRoomHandlers(io, socket);
    setupGameHandlers(io, socket);
    setupDisconnectHandler(io, socket);
  });
}
