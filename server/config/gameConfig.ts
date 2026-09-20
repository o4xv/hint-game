import { MAX_PLAYERS } from "@hint/contracts";

// ─── Game Configuration (server-side) ───

// Scoring zones — degrees from target angle
export const SCORING = {
  BULLSEYE: 6, // ±6°  → 3 pts
  MIDDLE: 16, // ±16° → 2 pts
  OUTER: 24, // ±24° → 1 pt
};

// Timeouts (milliseconds)
export const TIMEOUTS = {
  GUESS: 60_000,
  PSYCHIC: 90_000,
  RECONNECT_GRACE: Number(process.env.RECONNECT_GRACE_MS) || 30_000,
  JOIN_REQUEST: 2 * 60_000,
};

// Cleanup intervals
export const CLEANUP = {
  FAST_INTERVAL: 60_000,
  EMPTY_TTL: 5 * 60_000,
  SLOW_INTERVAL: 30 * 60_000,
  IDLE_TTL: 2 * 60 * 60_000,
};

// Room limits
export const ROOMS = {
  MAX_ROOMS: 100,
  MAX_PLAYERS,
};

export const WINNING_SCORES = [10, 20, 30, 40];
