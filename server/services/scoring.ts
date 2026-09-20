import { present } from "../invariants.js";
import type { Room } from "../types.js";
import { calculatePsychicPoints } from "../gameEngine.js";
import { getPublicTeams } from "../teamEngine.js";

/** Score on copies; applying a result belongs to the match lifecycle. */
export function calculateRoundScore(input: Room) {
  const room = {
    ...input,
    players: input.players.map((player) => ({ ...player })),
    teams: input.teams.map((team) => ({ ...team })),
  };
  const psychicId = room.currentRound.psychicId;
  const psychic = room.players.find((p) => p.id === psychicId);
  const activeTeam = room.teams.find((team) => team.id === room.currentRound.activeTeamId);
  const guessResults =
    room.gameMode === "teams"
      ? (() => {
          const controller = room.players.find(
            (player) => player.id === room.currentRound.controllerId,
          );
          const submitted = room.currentRound.guesses.find(
            (guess) => guess.playerId === room.currentRound.controllerId,
          );
          return [
            {
              playerId: controller?.id ?? room.currentRound.controllerId,
              teamId: activeTeam?.id ?? null,
              displayName: activeTeam?.name ?? "الفريق",
              angle: submitted?.angle ?? null,
              points: submitted?.points ?? 0,
            },
          ];
        })()
      : room.players
          .filter(
            (p) =>
              p.id !== psychicId &&
              !p.awaitingNextRound &&
              (p.isConnected || room.currentRound.guesses.some((guess) => guess.playerId === p.id)),
          )
          .map((p) => {
            const submitted = room.currentRound.guesses.find((g) => g.playerId === p.id);
            return submitted
              ? {
                  playerId: p.id,
                  displayName: p.displayName,
                  angle: submitted.angle,
                  points: submitted.points,
                }
              : { playerId: p.id, displayName: p.displayName, angle: null, points: 0 };
          });

  const playerScores = guessResults.map((g) => g.points);
  let psychicPoints = null;
  let psychicBreakdown = null;
  if (room.gameMode === "teams") {
    if (activeTeam) activeTeam.score += guessResults[0]?.points ?? 0;
  } else {
    const averagePoints = calculatePsychicPoints(playerScores);
    const twoPlayerBonus =
      guessResults.length === 1 && present(guessResults[0]).points >= 3 ? 1 : 0;
    const bullseyeBonus =
      guessResults.length > 1 ? Math.min(playerScores.filter((score) => score >= 3).length, 2) : 0;
    const allMissPenalty = guessResults.length >= 2 && playerScores.every((score) => score === 0);
    psychicPoints = allMissPenalty ? -1 : averagePoints + twoPlayerBonus + bullseyeBonus;
    psychicBreakdown = { averagePoints, twoPlayerBonus, bullseyeBonus, allMissPenalty };

    guessResults.forEach((result) => {
      const player = room.players.find((p) => p.id === result.playerId);
      if (player) player.score += result.points;
    });
    if (psychic) psychic.score += psychicPoints;
  }

  const updatedScores = room.players.map((p) => ({
    playerId: p.id,
    displayName: p.displayName,
    totalScore: p.score,
  }));
  const updatedTeams = getPublicTeams(room);
  return {
    guessResults,
    playerScores,
    psychicPoints,
    psychicBreakdown,
    updatedScores,
    updatedTeams,
  };
}

export function scoreAfterSkip(score: number): number {
  return Math.max(-999, score - 1);
}
