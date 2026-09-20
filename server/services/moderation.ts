import type { GameIO, GameSocket } from "../types.js";
import { onAction } from "../socketHandlers/boundary.js";
import crypto from "node:crypto";
import {
  getRoom,
  addPlayer,
  getJoinRequest,
  removeJoinRequest,
  removePlayer,
  getPublicPlayers,
  touchActivity,
  clearRoomTimer,
  allPlayersSubmitted,
} from "../roomManager.js";
import { startRound, triggerReveal } from "../socketHandlers/roundLogic.js";
import { emitRematchState, finishIfInsufficientPlayers } from "../socketHandlers/matchLifecycle.js";

import { trackGameplay } from "../telemetry.js";
import { emitPlayers, roomCardRedrawStatus } from "./capabilities.js";

import {
  getPlayerForSocket,
  emitJoinSuccess,
  emitOwnerJoinRequests,
  removeAndNotifyJoinRequest,
  removeSocketFromOtherRooms,
} from "./membership.js";
export function setupModerationService(io: GameIO, socket: GameSocket) {
  onAction(socket, "set_room_lock", ({ roomCode, locked }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return;
    const player = getPlayerForSocket(room, socket.id);
    if (player?.id !== room.ownerId) return;

    room.roomLocked = locked;
    touchActivity(room);
    io.to(roomCode).emit("settings_updated", { roomLocked: room.roomLocked });
    trackGameplay("moderation_action", {
      playerId: player.id,
      roomId: room.code,
      action: room.roomLocked ? "lock" : "unlock",
    });
  });
  onAction(socket, "approve_join_request", ({ roomCode, requestId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (room?.status !== "playing") return;
    const owner = getPlayerForSocket(room, socket.id);
    if (owner?.id !== room.ownerId) return;
    const request = getJoinRequest(room, requestId);
    if (!request) return;

    const requesterSocket = io.sockets.sockets.get(request.socketId);
    if (!requesterSocket) {
      removeAndNotifyJoinRequest(io, room, requestId, "expired");
      return;
    }

    const playerId = crypto.randomUUID();
    removeSocketFromOtherRooms(io, requesterSocket, room.code);
    const player = addPlayer(room, playerId, request.socketId, request.displayName, {
      awaitingNextRound: true,
    });
    if (!player) {
      // A reservation normally guarantees the seat. If the room still filled up, clear
      // it visibly for both sides instead of leaving the request pending forever.
      socket.emit("action_error", { event: "approve_join_request", code: "ROOM_FULL" });
      removeAndNotifyJoinRequest(io, room, requestId, "expired");
      return;
    }
    removeJoinRequest(room, requestId);

    emitJoinSuccess(requesterSocket, room, player, { joinMode: "next_round" });
    io.to(room.code).emit("join_request_removed", { requestId });
    emitPlayers(io, room);
    trackGameplay("join_approved", {
      playerId: owner.id,
      roomId: room.code,
      approved: true,
      joinMode: "next_round",
    });
  });
  onAction(socket, "reject_join_request", ({ roomCode, requestId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return;
    const owner = getPlayerForSocket(room, socket.id);
    if (owner?.id !== room.ownerId) return;
    removeAndNotifyJoinRequest(io, room, requestId, "rejected");
    trackGameplay("join_rejected", { playerId: owner.id, roomId: room.code, approved: false });
  });
  onAction(socket, "transfer_ownership", ({ roomCode, playerId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return;
    const owner = getPlayerForSocket(room, socket.id);
    const replacement = room.players.find(
      (player) => player.id === playerId && player.isConnected && !player.awaitingNextRound,
    );
    if (owner?.id !== room.ownerId || !replacement || replacement.id === owner.id) return;

    room.ownerId = replacement.id;
    touchActivity(room);
    io.to(room.code).emit("ownership_transferred", { ownerId: replacement.id });
    emitOwnerJoinRequests(io, room);
    trackGameplay("moderation_action", {
      playerId: owner.id,
      roomId: room.code,
      action: "transfer_owner",
    });
  });
  onAction(socket, "kick_player", ({ roomCode, playerId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return;
    const owner = getPlayerForSocket(room, socket.id);
    const target = room.players.find((player) => player.id === playerId);
    if (owner?.id !== room.ownerId || !target || target.id === owner.id) return;

    const wasPsychic = room.currentRound.psychicId === target.id;
    const wasController = room.currentRound.controllerId === target.id;
    const wasAwaiting = target.awaitingNextRound;
    const targetSocket = io.sockets.sockets.get(target.socketId ?? "");
    const removed = removePlayer(room, target.id);
    if (!removed) return;

    targetSocket?.emit("kicked_from_room", { message: "تمت إزالتك من الغرفة" });
    void targetSocket?.leave(room.code);

    const removedRedraw = roomCardRedrawStatus(io, room);
    io.to(room.code).emit("player_removed", {
      playerId: removed.id,
      displayName: removed.displayName,
      players: getPublicPlayers(room),
      redrawAvailable: removedRedraw.available,
      redrawReason: removedRedraw.reason,
    });
    trackGameplay("moderation_action", { playerId: owner.id, roomId: room.code, action: "kick" });
    emitRematchState(io, room);

    if (wasAwaiting) return;
    if (finishIfInsufficientPlayers(io, room)) return;
    if (
      room.status === "playing" &&
      (wasPsychic || wasController) &&
      room.currentRound.status !== "revealed"
    ) {
      clearRoomTimer(room);
      startRound(io, room);
      return;
    }
    if (
      room.status === "playing" &&
      room.currentRound.status === "guessing" &&
      allPlayersSubmitted(room)
    ) {
      triggerReveal(io, room.code);
    }
  });
}
