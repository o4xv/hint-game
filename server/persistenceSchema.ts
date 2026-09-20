import { z } from "zod";
import { MAX_PLAYERS } from "@hint/contracts";
const text = z.string();
const number = z.number();
const nullableNumber = number.nullable();
const strings = z.array(text);
const mode = z.enum(["individual", "teams"]);
const team = z.object({ id: text, name: text, color: text, score: number });
const score = z.object({ playerId: text, displayName: text, totalScore: number });
const winner = z.union([
  z.object({ playerId: text, displayName: text, score: number }),
  z.object({ teamId: text, displayName: text, score: number }),
]);
const award = z.object({
  type: z.enum(["closest_guess", "largest_miss", "best_guessing_average", "best_psychic_average"]),
  title: text,
  playerIds: strings,
  value: nullableNumber,
  players: z.array(z.object({ playerId: text, displayName: text })),
});
const ready = z.object({
  playerIds: strings,
  readyCount: number,
  requiredCount: number,
  endsAt: nullableNumber,
  paused: z.boolean().default(false),
  remainingMs: nullableNumber.default(null),
});
const guess = z.object({
  playerId: text.nullable(),
  displayName: text,
  teamId: text.nullable().optional(),
  angle: nullableNumber,
  points: number,
});
const reveal = z.object({
  targetAngle: number,
  guesses: z.array(guess),
  psychicPoints: nullableNumber,
  psychicBreakdown: z
    .object({
      averagePoints: number,
      twoPlayerBonus: number,
      bullseyeBonus: number,
      allMissPenalty: z.boolean(),
    })
    .nullable(),
  updatedScores: z.array(score),
  updatedTeams: z.array(team).default([]),
  gameMode: mode.default("individual"),
  activeTeamId: text.nullable().default(null),
  shouldPromptRating: z.boolean().default(false),
  winner: winner.nullable(),
  winners: z.array(winner),
  readyState: ready.optional(),
  awards: z.array(award).optional(),
  matchRoundCount: number.optional(),
});
const final = z.union([
  reveal.extend({ awards: z.array(award), matchRoundCount: number }),
  z.object({
    winner: z.null(),
    winners: z.array(winner),
    gameMode: mode.default("individual"),
    updatedTeams: z.array(team).default([]),
    leaderboard: z.array(score),
    awards: z.array(award),
    reason: text,
  }),
]);
const card = z.object({ id: text, packId: text, left: text, right: text });
const round = z.object({
  roundNumber: number,
  psychicId: text.nullable(),
  card: card.nullable(),
  targetAngle: nullableNumber,
  clue: text.nullable(),
  status: z.enum(["waiting", "guessing", "revealed"]),
  guesses: z.array(z.object({ playerId: text, angle: number, points: number })),
  usedCardIds: strings,
  psychicOrder: strings,
  psychicIndex: number,
  pausedPsychicTimerRemaining: nullableNumber.default(null),
  revealData: reveal.nullable().default(null),
  ratings: z
    .array(z.object({ playerId: text, vote: z.enum(["up", "down"]), targetRegion: text }))
    .default([]),
  activeTeamId: text.nullable().default(null),
  controllerId: text.nullable().default(null),
  previewAngle: nullableNumber.default(null),
  shouldPromptRating: z.boolean().default(false),
  redrawUsed: z.boolean().default(false),
});
const player = z.object({
  id: text,
  displayName: text,
  score: number,
  isConnected: z.boolean(),
  hasSubmitted: z.boolean(),
  awaitingNextRound: z.boolean().default(false),
  reconnectToken: text,
  teamId: text.nullable().default(null),
});
const history = z.object({
  roundNumber: number,
  psychicId: text.nullable(),
  psychicPoints: nullableNumber,
  guesses: z.array(
    z.object({
      playerId: text,
      distance: number,
      angle: number.optional(),
      points: number.optional(),
    }),
  ),
  cardId: text.optional(),
  packId: text.optional(),
  gameMode: mode.optional(),
  teamId: text.nullable().optional(),
  controllerId: text.nullable().optional(),
});
const modernSnapshotSchema = z.object({
  snapshotVersion: z.union([z.literal(1), z.literal(2)]),
  savedAt: number,
  code: text.min(1),
  ownerId: text,
  status: z.enum(["waiting", "playing", "finished"]),
  winningScore: number,
  psychicTimerEnabled: z.boolean(),
  roomLocked: z.boolean().default(false),
  selectedPackIds: strings.default([]),
  gameMode: mode.default("individual"),
  teamCount: number.default(2),
  teams: z.array(team).default([]),
  teamTurnIndex: number.default(0),
  teamPsychicIndexes: z.record(text, number).default({}),
  teamControllerIndexes: z.record(text, number).default({}),
  roundReadyPlayerIds: strings.default([]),
  roundAdvanceEndsAt: nullableNumber.default(null),
  roundAdvancePausedRemainingMs: nullableNumber.default(null),
  rematchVoteIds: strings.default([]),
  lastActivity: number,
  matchStartedAt: nullableNumber.default(null),
  roundStartedAt: nullableNumber.default(null),
  players: z.array(player).max(MAX_PLAYERS),
  currentRound: round,
  timerDescriptor: z
    .object({ kind: z.enum(["guess", "psychic", "round-ready"]), endsAt: number })
    .nullable()
    .default(null),
  matchHistory: z.array(history).default([]),
  finalState: final.nullable().default(null),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateLegacyResults(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // Preserve the singular recorded winner; never recompute historical scores/ties.
  return {
    ...value,
    psychicBreakdown: value.psychicBreakdown === undefined ? null : value.psychicBreakdown,
    winners:
      value.winners === undefined ? (value.winner == null ? [] : [value.winner]) : value.winners,
  };
}

/** Actual60287c6 v1 producers predate breakdowns, winner lists and regional ratings. */
function migrateVersionOne(value: unknown): unknown {
  if (!isRecord(value) || value.snapshotVersion !== 1) return value;
  const round = value.currentRound;
  return {
    ...value,
    currentRound: isRecord(round)
      ? {
          ...round,
          revealData: migrateLegacyResults(round.revealData),
          ratings: Array.isArray(round.ratings)
            ? round.ratings.map((rating: unknown) =>
                isRecord(rating) && rating.targetRegion === undefined
                  ? { ...rating, targetRegion: "all" }
                  : rating,
              )
            : round.ratings,
        }
      : round,
    finalState: migrateLegacyResults(value.finalState),
  };
}

export const snapshotSchema = z.preprocess(migrateVersionOne, modernSnapshotSchema);
