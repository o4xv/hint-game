import type { GameIO, GameSocket, Room } from "../types.js";
import type { RedrawReason } from "@hint/contracts";
import { getPublicPlayers } from "../roomManager.js";

/** Looks at connection-time capabilities, so it never depends on persisted state. */
export function socketSupportsCardRedraw(socket: GameSocket | undefined): boolean {
  const auth: unknown = socket?.handshake.auth;
  if (!auth || typeof auth !== "object") return false;
  return (auth as Record<string, unknown>).cardRedrawV1 === true;
}

export interface CardRedrawStatus {
  available: boolean;
  /** Named only when the server can tell which kind of participant blocks replacement. */
  reason: RedrawReason | null;
}

// A same-turn replacement changes the card for everyone at once, so it is only offered
// while every participant understands it: every active seat, including a disconnected one
// inside the reconnect grace, plus every connected spectator. An absent client may return
// with an older card, so replacement stays unavailable until it reconnects or leaves.
// Only players approved for the next round decide nothing about the current card.
// The returned reason lets the psychic read one accurate explanation instead of a guess.
export function roomCardRedrawStatus(io: GameIO, room: Room): CardRedrawStatus {
  let disconnected = false;
  let incompatible = false;
  for (const player of room.players) {
    if (player.awaitingNextRound) continue;
    if (!player.isConnected) disconnected = true;
    if (!socketSupportsCardRedraw(io.sockets.sockets.get(player.socketId ?? "")))
      incompatible = true;
  }
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.watchingRoomCode !== room.code) continue;
    if (!socketSupportsCardRedraw(socket)) incompatible = true;
  }
  if (disconnected) return { available: false, reason: "disconnected" };
  if (incompatible) return { available: false, reason: "incompatible" };
  return { available: true, reason: null };
}

export function roomSupportsCardRedraw(io: GameIO, room: Room): boolean {
  return roomCardRedrawStatus(io, room).available;
}

/** One roster broadcast that always carries the current replacement availability. */
export function emitPlayers(io: GameIO, room: Room) {
  const redraw = roomCardRedrawStatus(io, room);
  io.to(room.code).emit("player_joined", {
    players: getPublicPlayers(room),
    redrawAvailable: redraw.available,
    redrawReason: redraw.reason,
  });
}

// Card-sensitive actions must name the card they belong to. A capable client that omits it
// is asked to update, a client that predates replacement gets an explicit update
// instruction on a turn whose card already changed, and an older card is rejected.
export function cardContextIssue(
  room: Room,
  cardId: string | undefined,
  { requireContext = false }: { requireContext?: boolean } = {},
): string | null {
  if (typeof cardId === "string" && cardId.length > 0) {
    if (room.currentRound.card?.id !== cardId) return "STALE_CARD";
    return null;
  }
  if (room.currentRound.redrawUsed) return "UPDATE_REQUIRED";
  if (requireContext && room.currentRound.card) return "CARD_CONTEXT_REQUIRED";
  return null;
}
