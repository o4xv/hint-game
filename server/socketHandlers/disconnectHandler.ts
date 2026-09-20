import type { GameIO, GameSocket, Room } from "../types.js";
import {
  disconnectPlayer,
  removePlayer,
  clearRoomTimer,
  pauseRoomTimer,
  deleteRoom,
  allPlayersSubmitted,
  scheduleReconnectTimeout,
  getAllRooms,
  touchActivity,
} from "../roomManager.js";
import { emitRoundReady, setRoundAdvancePaused, startRound, triggerReveal } from "./roundLogic.js";
import { emitRematchState, finishIfInsufficientPlayers } from "./matchLifecycle.js";
import { emitPlayers } from "../services/capabilities.js";
import { trackGameplay } from "../telemetry.js";

function broadcastPlayers(io: GameIO, room: Room) {
  emitPlayers(io, room);
}

function emitOwnerJoinRequests(io: GameIO, room: Room) {
  const owner = room.players.find((player) => player.id === room.ownerId && player.isConnected);
  if (!owner) return;
  room.joinRequests.forEach((request) => {
    io.to(owner.socketId ?? "").emit("join_request", {
      requestId: request.id,
      displayName: request.displayName,
    });
  });
}

function trackAbandonment(room: Room, reason: string) {
  const now = Date.now();
  trackGameplay("game_abandoned", {
    roomId: room.code,
    roomStatus: room.status,
    reason,
    roundNumber: room.currentRound.roundNumber,
    playerCount: room.players.filter((player) => player.isConnected && !player.awaitingNextRound)
      .length,
    packCount: room.selectedPackIds.length,
    durationMs: room.matchStartedAt ? Math.max(0, now - room.matchStartedAt) : 0,
    winningScore: room.winningScore,
    gameMode: room.gameMode,
    teamCount: room.teamCount,
  });
}

function transferOwnership(io: GameIO, room: Room, departedOwnerId: string | null) {
  if (room.ownerId !== departedOwnerId) return;
  const replacement = room.players.find(
    (player) => player.isConnected && !player.awaitingNextRound,
  );
  if (!replacement) return;
  room.ownerId = replacement.id;
  io.to(room.code).emit("ownership_transferred", { ownerId: replacement.id });
  emitOwnerJoinRequests(io, room);
}

export function setupDisconnectHandler(io: GameIO, socket: GameSocket) {
  socket.on("disconnect", () => {
    for (const [, room] of getAllRooms()) {
      const player = room.players.find((candidate) => candidate.socketId === socket.id);
      if (!player) {
        // A departing spectator changes replacement availability for the room.
        if (socket.data.watchingRoomCode === room.code) emitPlayers(io, room);
        continue;
      }

      touchActivity(room);
      const wasPsychic = room.currentRound.psychicId === player.id;
      const wasController = room.currentRound.controllerId === player.id;
      const wasOwner = room.ownerId === player.id;
      const disconnectedRoundNumber = room.currentRound.roundNumber;
      const awaitingPsychicClue =
        wasPsychic && room.status === "playing" && room.currentRound.status === "waiting";

      if (awaitingPsychicClue) {
        room.currentRound.pausedPsychicTimerRemaining = pauseRoomTimer(room);
      }
      disconnectPlayer(room, player.id);
      if (
        wasOwner &&
        room.currentRound.status === "revealed" &&
        room.roundAdvancePausedRemainingMs !== null
      ) {
        setRoundAdvancePaused(io, room, false);
      } else if (room.currentRound.status === "revealed") {
        emitRoundReady(io, room);
      }
      trackGameplay("player_disconnected", {
        playerId: player.id,
        roomId: room.code,
        roomStatus: room.status,
        isOwner: wasOwner,
      });

      io.to(room.code).emit("player_disconnected", {
        playerId: player.id,
        displayName: player.displayName,
        wasPsychic: awaitingPsychicClue,
      });
      broadcastPlayers(io, room);
      emitRematchState(io, room);

      scheduleReconnectTimeout(room, player.id, (playerId) => {
        const removed = removePlayer(room, playerId);
        if (!removed) return;
        transferOwnership(io, room, wasOwner ? playerId : null);

        if (room.players.filter((candidate) => candidate.isConnected).length === 0) {
          trackAbandonment(room, "all_disconnected");
          io.to(room.code).emit("room_closed");
          deleteRoom(room.code);
          return;
        }
        if (finishIfInsufficientPlayers(io, room)) return;

        const sameRound = room.currentRound.roundNumber === disconnectedRoundNumber;
        if (sameRound && awaitingPsychicClue) {
          room.currentRound.pausedPsychicTimerRemaining = null;
          startRound(io, room);
          return;
        }
        if (
          sameRound &&
          room.gameMode === "teams" &&
          wasController &&
          room.currentRound.status !== "revealed"
        ) {
          clearRoomTimer(room);
          startRound(io, room);
          return;
        }
        if (room.currentRound.status === "guessing" && allPlayersSubmitted(room)) {
          triggerReveal(io, room.code);
        }
      });
    }
  });
}
