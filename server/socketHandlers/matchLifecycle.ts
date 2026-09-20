import { present } from "../invariants.js";
import type { FinalState } from "@hint/contracts";
import type { GameIO, Room } from "../types.js";
import { calculateAwards } from "../gameEngine.js";
import {
  activateAwaitingPlayers,
  clearRoomTimer,
  getRematchState,
  persistRoom,
} from "../roomManager.js";
import { getPublicTeams, validateTeamSetup } from "../teamEngine.js";
import { trackGameplay } from "../telemetry.js";

export function emitRematchState(io: GameIO, room: Room) {
  if (room.status === "finished")
    io.to(room.code).emit("rematch_vote_updated", getRematchState(room));
}

export function finishMatch<T extends FinalState>(
  io: GameIO,
  room: Room,
  finalState: T,
  {
    eventName = "game_over",
    setRevealData = false,
  }: { eventName?: "game_over" | null; setRevealData?: boolean } = {},
) {
  clearRoomTimer(room);
  room.roundAdvanceEndsAt = null;
  room.roundAdvancePausedRemainingMs = null;
  activateAwaitingPlayers(room).forEach((player) => {
    void io.sockets.sockets.get(player.socketId ?? "")?.join(room.code);
  });
  while (room.joinRequests.length) {
    const request = present(room.joinRequests.pop());
    if (request.timeout) clearTimeout(request.timeout);
    io.to(request.socketId).emit("join_request_resolved", { reason: "game_finished" });
    io.to(room.code).emit("join_request_removed", { requestId: request.id });
  }

  room.status = "finished";
  room.finalState = finalState;
  if (setRevealData && "targetAngle" in finalState) room.currentRound.revealData = finalState;
  persistRoom(room);
  if (eventName) io.to(room.code).emit(eventName, finalState);
  emitRematchState(io, room);
  return finalState;
}

export function finishIfInsufficientPlayers(
  io: GameIO,
  room: Room,
  telemetryReason = "insufficient_players",
) {
  const activePlayers = room.players.filter(
    (player) => player.isConnected && !player.awaitingNextRound,
  );
  const invalidTeamSetup = room.gameMode === "teams" && !validateTeamSetup(room).valid;
  if (room.status !== "playing" || (!invalidTeamSetup && activePlayers.length >= 2)) return false;

  const updatedTeams = getPublicTeams(room);
  const finalState = {
    winner: null,
    winners: [],
    gameMode: room.gameMode,
    updatedTeams,
    leaderboard:
      room.gameMode === "teams"
        ? updatedTeams.map((team) => ({
            playerId: team.id,
            displayName: team.name,
            totalScore: team.score,
          }))
        : room.players.map((player) => ({
            playerId: player.id,
            displayName: player.displayName,
            totalScore: player.score,
          })),
    awards: room.gameMode === "teams" ? [] : calculateAwards(room.matchHistory, room.players),
    reason: "لا يوجد لاعبون كافيون",
  };
  trackGameplay("game_abandoned", {
    roomId: room.code,
    roomStatus: "finished",
    reason: telemetryReason,
    roundNumber: room.currentRound.roundNumber,
    playerCount: activePlayers.length,
    packCount: room.selectedPackIds.length,
    durationMs: room.matchStartedAt ? Math.max(0, Date.now() - room.matchStartedAt) : 0,
    winningScore: room.winningScore,
    gameMode: room.gameMode,
    teamCount: room.teamCount,
  });
  finishMatch(io, room, finalState);
  return true;
}
