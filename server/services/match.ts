import type { GameIO, GameSocket, Room } from "../types.js";
import { onAction } from "../socketHandlers/boundary.js";

import {
  getRoom,
  getRematchState,
  getPublicPlayers,
  updateRoomStatus,
  touchActivity,
  clearRoomTimer,
  getPublicRoomMode,
} from "../roomManager.js";
import { startRound } from "../socketHandlers/roundLogic.js";

import { trackGameplay } from "../telemetry.js";
import { validateTeamSetup, resetTeamScores } from "../teamEngine.js";

export function setupMatchService(io: GameIO, socket: GameSocket) {
  onAction(socket, "start_game", ({ roomCode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    const room = getRoom(roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.ownerId) return;

    if (room.status !== "waiting") return;

    const connectedPlayers = room.players.filter((p) => p.isConnected);
    const teamSetup = validateTeamSetup(room);
    if (connectedPlayers.length < 2 || !teamSetup.valid) {
      // Name the team that is short so the host knows exactly what to fix.
      const shortTeam = room.teams.find((team) => team.id === teamSetup.teamId);
      const shortage = teamSetup.shortage ?? 1;
      const message =
        teamSetup.reason === "team_min_players"
          ? "وضع الفرق يحتاج ٤ لاعبين على الأقل"
          : teamSetup.reason === "team_needs_two" && shortTeam
            ? shortage === 1
              ? `فريق ${shortTeam.name} يحتاج لاعباً إضافياً`
              : shortage === 2
                ? `فريق ${shortTeam.name} يحتاج لاعبين`
                : `فريق ${shortTeam.name} يحتاج ${shortage} لاعبين`
            : "تحتاج اللعبة إلى لاعبين على الأقل";
      socket.emit("game_start_error", {
        message,
        reason: teamSetup.reason ?? "not_enough_players",
      });
      return;
    }

    room.matchStartedAt = Date.now();
    room.roundStartedAt = null;
    // A new match starts every player and team with a full allowance.
    room.targetRedrawsUsedByPlayer = {};
    room.targetRedrawsUsedByTeam = {};
    updateRoomStatus(room, "playing");

    io.to(roomCode).emit("game_started", {
      players: getPublicPlayers(room),
      winningScore: room.winningScore,
      selectedPackIds: room.selectedPackIds,
      ...getPublicRoomMode(room),
    });

    trackGameplay("game_started", {
      playerId: player.id,
      roomId: room.code,
      playerCount: connectedPlayers.length,
      packCount: room.selectedPackIds.length,
      winningScore: room.winningScore,
      gameMode: room.gameMode,
      teamCount: room.teamCount,
    });

    startRound(io, room);
  });
  function resetMatch(room: Room) {
    clearRoomTimer(room);
    room.players.forEach((p) => {
      p.score = 0;
      p.hasSubmitted = false;
      p.awaitingNextRound = false;
    });
    resetTeamScores(room);
    room.status = "waiting";
    room.currentRound.roundNumber = 0;
    room.currentRound.psychicId = null;
    room.currentRound.card = null;
    room.currentRound.targetAngle = null;
    room.currentRound.clue = null;
    room.currentRound.status = "waiting";
    room.currentRound.guesses = [];
    room.currentRound.psychicOrder = [];
    room.currentRound.psychicIndex = 0;
    room.currentRound.pausedPsychicTimerRemaining = null;
    room.currentRound.revealData = null;
    room.currentRound.ratings = [];
    room.currentRound.activeTeamId = null;
    room.currentRound.controllerId = null;
    room.currentRound.shouldPromptRating = false;
    room.currentRound.redrawUsed = false;
    room.currentRound.targetRevision = 0;
    room.targetRedrawsUsedByPlayer = {};
    room.targetRedrawsUsedByTeam = {};
    room.roundReadyPlayerIds = [];
    room.roundAdvanceEndsAt = null;
    room.roundAdvancePausedRemainingMs = null;
    room.rematchVoteIds = [];
    room.matchHistory = [];
    room.matchStartedAt = null;
    room.roundStartedAt = null;
    room.finalState = null;
    touchActivity(room);

    io.to(room.code).emit("rematch_started", {
      players: getPublicPlayers(room),
      winningScore: room.winningScore,
      selectedPackIds: room.selectedPackIds,
      ...getPublicRoomMode(room),
    });
  }

  onAction(socket, "vote_rematch", ({ roomCode, vote }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (room?.status !== "finished") return;
    const player = room.players.find(
      (candidate) => candidate.socketId === socket.id && candidate.isConnected,
    );
    if (!player) return;
    const votes = new Set(room.rematchVoteIds);
    if (vote) votes.add(player.id);
    else votes.delete(player.id);
    room.rematchVoteIds = [...votes];
    const state = getRematchState(room);
    room.rematchVoteIds = state.playerIds;
    touchActivity(room);
    io.to(room.code).emit("rematch_vote_updated", state);
    if (state.requiredCount > 0 && state.voteCount >= state.requiredCount) resetMatch(room);
  });

  onAction(socket, "rematch", ({ roomCode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    const room = getRoom(roomCode);
    if (room?.status !== "finished") return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.ownerId) return;

    resetMatch(room);
  });
}
