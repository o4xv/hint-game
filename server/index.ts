import type { GameIO } from "./types.js";
import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { PORT, ALLOWED_ORIGINS, DEPLOYMENT_ID } from "./config.js";
import { registerHandlers } from "./socketHandlers/index.js";
import {
  getAllRooms,
  roomExists,
  startTTLCleanup,
  restoreRooms,
  setPersistenceAdapter,
} from "./roomManager.js";
import { publicCards, publicPacks } from "./data/cards.js";
import {
  expressErrorHandler,
  setupSocketErrorHandler,
  setupProcessHandlers,
} from "./middleware/errorHandler.js";
import {
  closePersistence,
  getStorageHealth,
  initializePersistence,
  persistenceAdapter,
} from "./persistence.js";
import { getTelemetryHealth, initializeTelemetry } from "./telemetry.js";

export function createGameServer({ startCleanup = true } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io: GameIO = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST"],
    },
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(origin && ALLOWED_ORIGINS.includes(origin) ? 204 : 403);
      return;
    }
    next();
  });

  app.get("/health", (_, res) =>
    res.json({
      status: "ok",
      revision: DEPLOYMENT_ID,
      diagnostics: {
        rooms: getAllRooms().length,
        playingRooms: getAllRooms().filter(([, room]) => room.status === "playing").length,
        activeTimers: getAllRooms().filter(([, room]) => room.timer !== null).length,
        pausedRounds: getAllRooms().filter(
          ([, room]) => room.roundAdvancePausedRemainingMs !== null,
        ).length,
      },
      storage: getStorageHealth(),
      telemetry: getTelemetryHealth(),
    }),
  );
  app.get("/api/room/:code/exists", (req, res) => {
    res.json({ exists: roomExists(req.params.code.toUpperCase()) });
  });
  app.get("/api/cards", (_, res) => res.json({ cards: publicCards }));
  app.get("/api/card-packs", (_, res) => res.json({ packs: publicPacks }));

  registerHandlers(io);
  setupSocketErrorHandler(io);
  if (startCleanup) startTTLCleanup();
  app.use(expressErrorHandler);

  return { app, server, io };
}

export async function startServer(port = PORT) {
  initializeTelemetry();
  const restored = await initializePersistence();
  setPersistenceAdapter(persistenceAdapter);
  restoreRooms(restored);
  const gameServer = createGameServer();
  setupProcessHandlers();
  gameServer.server.on("close", () => {
    void closePersistence();
  });
  gameServer.server.listen(port, "0.0.0.0", () => {
    console.log(`[hint-server] running on http://0.0.0.0:${port}`);
  });
  return gameServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
