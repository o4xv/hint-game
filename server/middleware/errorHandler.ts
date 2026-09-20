import type { Request, Response, NextFunction } from "express";
import type { GameIO } from "../types.js";
// ─── Express Error Handler ───

export function expressErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  captureException(err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
  next();
}

// ─── Socket.io Error Handler ───

export function setupSocketErrorHandler(io: GameIO) {
  io.engine.on("connection_error", (err) => {
    captureException(err);
  });
}

// ─── Process-Level Handlers ───

export function setupProcessHandlers() {
  process.on("uncaughtException", (err) => {
    captureException(err);
    // Stay alive — do not process.exit()
  });

  process.on("unhandledRejection", (reason) => {
    captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
}
import { captureException } from "../telemetry.js";
