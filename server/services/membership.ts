import { present } from "../invariants.js";
import type { GameIO, GameSocket, Player, Room, JoinRequest } from "../types.js";
import { onAction } from "../socketHandlers/boundary.js";
import crypto from "node:crypto";
import { MAX_PLAYERS } from "@hint/contracts";
import {
  createRoom,
  getRoom,
  roomExists,
  roomsFull,
  addPlayer,
  addJoinRequest,
  getJoinRequest,
  removeJoinRequest,
  removePlayer,
  getPlayerByToken,
  reconnectPlayer,
  getPublicPlayers,
  getReconnectState,
  touchActivity,
  clearRoomTimer,
  allPlayersSubmitted,
  getPublicRoomMode,
  getAllRooms,
  deleteRoom,
  scheduleReconnectTimeout,
} from "../roomManager.js";
import {
  setRoundAdvancePaused,
  getRoundReadyState,
  startRound,
  resumePsychicTimer,
  resumeRecoveredRoom,
  triggerReveal,
} from "../socketHandlers/roundLogic.js";
import { emitRematchState, finishIfInsufficientPlayers } from "../socketHandlers/matchLifecycle.js";
import { sanitizeDisplayName } from "../validation.js";
import { TIMEOUTS } from "../config/gameConfig.js";
import { DEFAULT_PACK_IDS, validatePackIds } from "../data/cards.js";
import { trackGameplay } from "../telemetry.js";
import { emitPlayers, roomCardRedrawStatus } from "./capabilities.js";
import { targetRedrawState } from "./targetRedraw.js";

const rateLimiters = new Map<string, number>();
const roomCreationWindows = new WeakMap<GameIO, Map<string, number[]>>();
function throttle(key: string, ms = 500) {
  const now = Date.now();
  const last = rateLimiters.get(key) ?? 0;
  if (now - last < ms) return true;
  rateLimiters.set(key, now);
  return false;
}
function allowRoomCreation(io: GameIO, socket: GameSocket) {
  let windows = roomCreationWindows.get(io);
  if (!windows) {
    windows = new Map();
    roomCreationWindows.set(io, windows);
  }
  const key = socket.handshake.address || "unknown";
  const cutoff = Date.now() - 60_000;
  const recent = (windows.get(key) ?? []).filter((timestamp) => timestamp >= cutoff);
  const limit = Math.max(1, Number(process.env.ROOM_CREATION_LIMIT) || 30);
  if (recent.length >= limit) return false;
  recent.push(Date.now());
  windows.set(key, recent);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, v] of rateLimiters) {
    if (v < cutoff) rateLimiters.delete(k);
  }
}, 300_000).unref();
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (roomExists(code));
  return code;
}
export function getPlayerForSocket(room: Room, socketId: string) {
  return room.players.find((player) => player.socketId === socketId) ?? null;
}
function getSocketMembership(socketId: string) {
  for (const [, room] of getAllRooms()) {
    const player = getPlayerForSocket(room, socketId);
    if (player) return { room, player };
  }
  return null;
}
function emitRoomCreated(socket: GameSocket, room: Room, player: Player) {
  void socket.join(room.code);
  socket.emit("room_created", {
    roomCode: room.code,
    playerId: player.id,
    reconnectToken: player.reconnectToken,
    selectedPackIds: room.selectedPackIds,
    ...getPublicRoomMode(room),
  });
}
export function emitJoinSuccess(socket: GameSocket, room: Room, player: Player, extra = {}) {
  if (!player.awaitingNextRound) void socket.join(room.code);
  socket.emit("join_success", {
    playerId: player.id,
    reconnectToken: player.reconnectToken,
    roomCode: room.code,
    players: getPublicPlayers(room),
    winningScore: room.winningScore,
    psychicTimerEnabled: room.psychicTimerEnabled,
    roomLocked: room.roomLocked,
    selectedPackIds: room.selectedPackIds,
    ...getPublicRoomMode(room),
    isOwner: player.id === room.ownerId,
    ...extra,
  });
}
export function emitOwnerJoinRequests(io: GameIO, room: Room) {
  const owner = room.players.find((player) => player.id === room.ownerId && player.isConnected);
  if (!owner) return;
  room.joinRequests.forEach((request) => {
    io.to(owner.socketId ?? "").emit("join_request", {
      requestId: request.id,
      displayName: request.displayName,
    });
  });
}
export function removeAndNotifyJoinRequest(
  io: GameIO,
  room: Room,
  requestId: string,
  reason: "cancelled" | "expired" | "rejected" | "game_finished",
) {
  const request = removeJoinRequest(room, requestId);
  if (!request) return null;
  io.to(request.socketId).emit("join_request_resolved", { reason });
  io.to(room.code).emit("join_request_removed", { requestId });
  return request;
}
export function removeSocketFromOtherRooms(
  io: GameIO,
  socket: GameSocket,
  exceptRoomCode: string | null = null,
) {
  for (const [code, room] of getAllRooms()) {
    if (code === exceptRoomCode) continue;

    for (const request of room.joinRequests.filter(
      (candidate) => candidate.socketId === socket.id,
    )) {
      removeAndNotifyJoinRequest(io, room, request.id, "cancelled");
    }

    const player = getPlayerForSocket(room, socket.id);
    if (!player) continue;
    const wasPsychic = room.currentRound.psychicId === player.id;
    const wasController = room.currentRound.controllerId === player.id;
    const wasOwner = room.ownerId === player.id;
    removePlayer(room, player.id);
    void socket.leave(room.code);

    const removedRedraw = roomCardRedrawStatus(io, room);
    io.to(room.code).emit("player_removed", {
      playerId: player.id,
      displayName: player.displayName,
      players: getPublicPlayers(room),
      redrawAvailable: removedRedraw.available,
      redrawReason: removedRedraw.reason,
    });
    emitRematchState(io, room);

    if (wasOwner) {
      if (room.currentRound.status === "revealed" && room.roundAdvancePausedRemainingMs !== null)
        setRoundAdvancePaused(io, room, false);
      const replacement = room.players.find(
        (candidate) => candidate.isConnected && !candidate.awaitingNextRound,
      );
      if (replacement) {
        room.ownerId = replacement.id;
        io.to(room.code).emit("ownership_transferred", { ownerId: replacement.id });
        emitOwnerJoinRequests(io, room);
      }
    }

    if (!room.players.length) {
      io.to(room.code).emit("room_closed");
      deleteRoom(room.code);
      continue;
    }
    if (finishIfInsufficientPlayers(io, room)) continue;
    if (
      room.status === "playing" &&
      (wasPsychic || wasController) &&
      room.currentRound.status !== "revealed"
    ) {
      clearRoomTimer(room);
      startRound(io, room);
    } else if (
      room.status === "playing" &&
      room.currentRound.status === "guessing" &&
      allPlayersSubmitted(room)
    ) {
      triggerReveal(io, room.code);
    }
  }
}
function scheduleRestoredPlayerExpiry(io: GameIO, room: Room) {
  for (const player of room.players.filter(
    (candidate) => !candidate.isConnected && !candidate.disconnectTimeout,
  )) {
    const expiredRoundNumber = room.currentRound.roundNumber;
    const wasPsychic = room.currentRound.psychicId === player.id;
    const wasController = room.currentRound.controllerId === player.id;
    scheduleReconnectTimeout(room, player.id, (playerId) => {
      const removed = removePlayer(room, playerId);
      if (!removed) return;

      if (room.ownerId === playerId) {
        const replacement = room.players.find(
          (candidate) => candidate.isConnected && !candidate.awaitingNextRound,
        );
        if (replacement) {
          room.ownerId = replacement.id;
          io.to(room.code).emit("ownership_transferred", { ownerId: replacement.id });
          emitOwnerJoinRequests(io, room);
        }
      }

      if (!room.players.some((candidate) => candidate.isConnected)) {
        deleteRoom(room.code);
        return;
      }
      if (finishIfInsufficientPlayers(io, room)) return;

      const sameRound = room.currentRound.roundNumber === expiredRoundNumber;
      if (
        sameRound &&
        room.status === "playing" &&
        (wasPsychic || wasController) &&
        room.currentRound.status !== "revealed"
      ) {
        clearRoomTimer(room);
        startRound(io, room);
      } else if (
        sameRound &&
        room.currentRound.status === "guessing" &&
        allPlayersSubmitted(room)
      ) {
        triggerReveal(io, room.code);
      }
    });
  }
}
export function setupMembershipService(io: GameIO, socket: GameSocket) {
  onAction(socket, "create_room", ({ displayName, winningScore, selectedPackIds }) => {
    const existing = getSocketMembership(socket.id);
    if (existing && existing.player.id === existing.room.ownerId) {
      emitRoomCreated(socket, existing.room, existing.player);
      return;
    }
    if (throttle(`create:${socket.id}`)) return;

    if (roomsFull()) {
      socket.emit("join_error", {
        message:
          "\u0627\u0644\u062E\u0627\u062F\u0645 \u0645\u0634\u063A\u0648\u0644\u002E \u062D\u0627\u0648\u0644 \u0645\u0631\u0629 \u0623\u062E\u0631\u0649 \u0628\u0639\u062F \u0642\u0644\u064A\u0644\u002E",
      });
      return;
    }

    displayName = sanitizeDisplayName(displayName) ?? "";
    // winningScore validated by the shared schema.
    if (!displayName) {
      socket.emit("join_error", {
        message:
          "\u0627\u0644\u0627\u0633\u0645 \u064A\u062D\u062A\u0648\u064A \u0639\u0644\u0649 \u0623\u062D\u0631\u0641 \u063A\u064A\u0631 \u0645\u0633\u0645\u0648\u062D\u0629",
      });
      return;
    }

    if (!allowRoomCreation(io, socket)) {
      socket.emit("join_error", {
        code: "ROOM_CREATE_RATE_LIMITED",
        message: "تم إنشاء غرف كثيرة من هذا الاتصال. حاول لاحقاً.",
      });
      return;
    }

    removeSocketFromOtherRooms(io, socket);

    const code = generateRoomCode();
    const playerId = crypto.randomUUID();
    const room = createRoom(code, playerId, socket.id, displayName, winningScore);
    room.selectedPackIds = validatePackIds(selectedPackIds) ?? [...DEFAULT_PACK_IDS];
    touchActivity(room);
    const player = present(room.players[0]);

    emitRoomCreated(socket, room, player);
    trackGameplay("room_created", {
      playerId,
      roomId: code,
      playerCount: 1,
      packCount: room.selectedPackIds.length,
    });
  });
  onAction(socket, "join_room", ({ roomCode, displayName }) => {
    if (throttle(`join:${socket.id}`)) return;

    displayName = sanitizeDisplayName(displayName) ?? "";
    roomCode = (roomCode || "").trim().toUpperCase();

    if (!displayName) {
      socket.emit("join_error", {
        message:
          "\u0627\u0644\u0627\u0633\u0645 \u064A\u062D\u062A\u0648\u064A \u0639\u0644\u0649 \u0623\u062D\u0631\u0641 \u063A\u064A\u0631 \u0645\u0633\u0645\u0648\u062D\u0629",
      });
      return;
    }

    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("join_error", {
        message:
          "\u0627\u0644\u063A\u0631\u0641\u0629 \u063A\u064A\u0631 \u0645\u0648\u062C\u0648\u062F\u0629",
      });
      return;
    }

    const existingPlayer = getPlayerForSocket(room, socket.id);
    if (existingPlayer) {
      emitJoinSuccess(socket, room, existingPlayer, {
        joinMode: existingPlayer.awaitingNextRound ? "next_round" : undefined,
      });
      return;
    }

    if (room.roomLocked) {
      socket.emit("join_error", { message: "الغرفة مقفلة" });
      return;
    }

    if (room.status !== "waiting") {
      if (room.status !== "playing") {
        socket.emit("join_error", { message: "انتهت المباراة" });
        return;
      }

      // A player who already asked to join keeps that answer even when the room has
      // filled up in the meantime, so a retry never looks like a fresh, rejected seat.
      const existingRequest = room.joinRequests.find((request) => request.socketId === socket.id);
      if (existingRequest) {
        socket.emit("join_pending", { roomCode, requestId: existingRequest.id });
        return;
      }

      // Seats and reservations share one budget: players inside the reconnect grace
      // and approved players waiting for the next round still hold their place.
      if (room.players.length + room.joinRequests.length >= MAX_PLAYERS) {
        socket.emit("join_error", { message: "الغرفة ممتلئة" });
        return;
      }

      const request: JoinRequest = {
        id: crypto.randomUUID(),
        socketId: socket.id,
        displayName,
        requestedAt: Date.now(),
        timeout: null,
      };
      request.timeout = setTimeout(() => {
        if (getRoom(room.code) !== room || getJoinRequest(room, request.id) !== request) return;
        removeAndNotifyJoinRequest(io, room, request.id, "expired");
      }, TIMEOUTS.JOIN_REQUEST);
      addJoinRequest(room, request);

      socket.emit("join_pending", { roomCode, requestId: request.id });
      emitOwnerJoinRequests(io, room);
      return;
    }

    const playerId = crypto.randomUUID();
    removeSocketFromOtherRooms(io, socket, roomCode);
    const player = addPlayer(room, playerId, socket.id, displayName);
    if (!player) {
      socket.emit("join_error", {
        message: "\u0627\u0644\u063A\u0631\u0641\u0629 \u0645\u0645\u062A\u0644\u0626\u0629",
      });
      return;
    }

    emitJoinSuccess(socket, room, player);

    emitPlayers(io, room);
  });
  onAction(socket, "reconnect_player", ({ roomCode, reconnectToken }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    reconnectToken = (reconnectToken || "").trim();

    if (roomCode.length !== 4 || !reconnectToken) {
      socket.emit("join_error", {
        code: "INVALID_RECONNECT",
        message:
          "\u0628\u064A\u0627\u0646\u0627\u062A \u063A\u064A\u0631 \u0635\u0627\u0644\u062D\u0629",
      });
      return;
    }

    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("join_error", {
        code: "ROOM_NOT_FOUND",
        message:
          "\u0627\u0644\u063A\u0631\u0641\u0629 \u063A\u064A\u0631 \u0645\u0648\u062C\u0648\u062F\u0629",
      });
      return;
    }

    const player = getPlayerByToken(room, reconnectToken);
    if (!player) {
      socket.emit("join_error", {
        code: "SESSION_EXPIRED",
        message: "\u0627\u0646\u062A\u0647\u062A \u0627\u0644\u062C\u0644\u0633\u0629",
      });
      return;
    }

    const previousSocketId = player.socketId;
    scheduleRestoredPlayerExpiry(io, room);
    removeSocketFromOtherRooms(io, socket, roomCode);
    reconnectPlayer(room, player.id, socket.id);
    if (!player.awaitingNextRound) void socket.join(roomCode);
    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) {
        previousSocket.emit("session_replaced");
        previousSocket.disconnect(true);
      }
    }

    if (
      player.id === room.currentRound.psychicId &&
      room.currentRound.pausedPsychicTimerRemaining !== null
    ) {
      const remaining = room.currentRound.pausedPsychicTimerRemaining;
      room.currentRound.pausedPsychicTimerRemaining = null;
      resumePsychicTimer(io, room, remaining);
    }

    resumeRecoveredRoom(io, room);

    const reconnectRedraw = roomCardRedrawStatus(io, room);
    const reconnectState = getReconnectState(room, player.id, {
      redrawAvailable: reconnectRedraw.available,
      redrawReason: reconnectRedraw.reason,
      targetRedraw: targetRedrawState(room),
    });

    socket.emit("reconnect_success", {
      playerId: player.id,
      displayName: player.displayName,
      isOwner: player.id === room.ownerId,
      ...reconnectState,
    });

    if (player.id === room.ownerId) emitOwnerJoinRequests(io, room);

    emitPlayers(io, room);
    trackGameplay("player_reconnected", {
      playerId: player.id,
      roomId: room.code,
      roomStatus: room.status,
    });
    emitRematchState(io, room);
  });
  onAction(socket, "leave_room", ({ roomCode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    if (roomCode) {
      void socket.leave(roomCode);
    }
  });
  onAction(socket, "cancel_join_request", ({ roomCode, requestId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return;
    const request = getJoinRequest(room, requestId);
    if (request?.socketId !== socket.id) return;
    removeJoinRequest(room, requestId);
    io.to(room.code).emit("join_request_removed", { requestId });
  });
  onAction(socket, "watch_room", ({ roomCode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("watch_error", { message: "الغرفة غير موجودة" });
      return;
    }
    void socket.join(room.code);
    socket.data.watchingRoomCode = room.code;
    const readyState = getRoundReadyState(room);
    const spectatorRedraw = roomCardRedrawStatus(io, room);
    const currentRound = ["playing", "finished"].includes(room.status)
      ? {
          roundNumber: room.currentRound.roundNumber,
          psychicId: room.currentRound.psychicId,
          card: room.currentRound.card,
          clue: room.currentRound.clue,
          status: room.currentRound.status,
          activeTeamId: room.currentRound.activeTeamId ?? null,
          controllerId: room.currentRound.controllerId ?? null,
          previewAngle: room.currentRound.previewAngle ?? null,
          redrawUsed: room.currentRound.redrawUsed,
          redrawAvailable: spectatorRedraw.available,
          redrawReason: spectatorRedraw.reason,
          targetRedraw: targetRedrawState(room),
          revealData:
            room.currentRound.status === "revealed" || room.status === "finished"
              ? room.currentRound.revealData && { ...room.currentRound.revealData, readyState }
              : null,
        }
      : null;
    socket.emit("watch_success", {
      roomCode: room.code,
      status: room.status,
      redrawAvailable: spectatorRedraw.available,
      winningScore: room.winningScore,
      players: getPublicPlayers(room),
      ...getPublicRoomMode(room),
      currentRound,
      readyState,
      finalState: room.status === "finished" ? room.finalState : null,
    });
    // A spectator's capability decides same-turn replacement for the whole room, so the
    // players' availability changes the moment one arrives.
    emitPlayers(io, room);
  });
}
