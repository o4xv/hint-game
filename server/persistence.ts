import { present } from "./invariants.js";
import { snapshotSchema } from "./persistenceSchema.js";
import type { Player, Room } from "./types.js";
import { createClient } from "redis";
import { REDIS_URL } from "./config.js";
import { CLEANUP } from "./config/gameConfig.js";
import { DEFAULT_PACK_IDS, validatePackIds } from "./data/cards.js";
import { captureException } from "./telemetry.js";

export const SNAPSHOT_VERSION = 2;
const KEY_PREFIX = "hint:room:";
const INDEX_KEY = "hint:rooms";
const CARD_RATINGS_KEY = "hint:card-ratings";
const TTL_SECONDS = Math.floor(CLEANUP.IDLE_TTL / 1000);

let client: ReturnType<typeof createClient> | null = null;
let status = REDIS_URL ? "connecting" : "disabled";

const memoryRatings = new Map<string, { positive: number; negative: number }>();
const pendingSnapshots = new Map<string, string>();
const pendingDeletes = new Set<string>();

function cleanPlayer(player: Player) {
  return {
    id: player.id,
    displayName: player.displayName,
    score: player.score,
    isConnected: false,
    hasSubmitted: player.hasSubmitted,
    awaitingNextRound: player.awaitingNextRound,
    reconnectToken: player.reconnectToken,
    teamId: player.teamId ?? null,
  };
}

function normalizeSelectedPackIds(packIds: unknown) {
  const retained = [...new Set((Array.isArray(packIds) ? packIds : []).map(String))].filter(
    (packId) => validatePackIds([packId]),
  );
  return retained.length ? retained : [...DEFAULT_PACK_IDS];
}

function hasRemovedRoundCard(round: Room["currentRound"]) {
  return Boolean(round.card?.packId && !validatePackIds([round.card.packId]));
}

function resetRemovedCardRound(round: Room["currentRound"]): Room["currentRound"] {
  return {
    ...round,
    psychicId: null,
    card: null,
    targetAngle: null,
    clue: null,
    status: "waiting",
    guesses: [],
    pausedPsychicTimerRemaining: null,
    revealData: null,
    ratings: [],
    activeTeamId: null,
    controllerId: null,
    shouldPromptRating: false,
    redrawUsed: false,
  };
}

export function serializeRoom(room: Room) {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    code: room.code,
    ownerId: room.ownerId,
    status: room.status,
    winningScore: room.winningScore,
    psychicTimerEnabled: room.psychicTimerEnabled,
    roomLocked: room.roomLocked,
    selectedPackIds: [...room.selectedPackIds],
    gameMode: room.gameMode,
    teamCount: room.teamCount || 2,
    teams: structuredClone(room.teams),
    teamTurnIndex: room.teamTurnIndex || 0,
    teamPsychicIndexes: { ...room.teamPsychicIndexes },
    teamControllerIndexes: { ...room.teamControllerIndexes },
    roundReadyPlayerIds: [...room.roundReadyPlayerIds],
    roundAdvanceEndsAt: room.roundAdvanceEndsAt ?? null,
    roundAdvancePausedRemainingMs: room.roundAdvancePausedRemainingMs ?? null,
    rematchVoteIds: [...room.rematchVoteIds],
    lastActivity: room.lastActivity,
    matchStartedAt: room.matchStartedAt ?? null,
    roundStartedAt: room.roundStartedAt ?? null,
    players: room.players.map(cleanPlayer),
    currentRound: structuredClone(room.currentRound),
    timerDescriptor: room.timerDescriptor ? { ...room.timerDescriptor } : null,
    matchHistory: structuredClone(room.matchHistory),
    finalState: room.finalState ? structuredClone(room.finalState) : null,
  };
}

export function deserializeRoom(input: unknown, now = Date.now()): Room | null {
  const result = snapshotSchema.safeParse(input);
  if (!result.success) return null;
  // Schema optional fields permit explicit undefined in TypeScript; durable JSON omits them.
  const snapshot = result.data as ReturnType<typeof serializeRoom>;
  if (now - (snapshot.lastActivity || snapshot.savedAt || 0) >= CLEANUP.IDLE_TTL) return null;
  const removedRoundCard = hasRemovedRoundCard(snapshot.currentRound);
  return {
    ...snapshot,
    status: removedRoundCard ? "waiting" : snapshot.status,
    players: snapshot.players.map((player) => ({
      ...player,
      socketId: null,
      isConnected: false,
      disconnectTimeout: null,
      hasSubmitted: removedRoundCard ? false : player.hasSubmitted,
      awaitingNextRound: removedRoundCard ? false : player.awaitingNextRound,
    })),
    joinRequests: [],
    timer: null,
    timerEndsAt: removedRoundCard ? null : (snapshot.timerDescriptor?.endsAt ?? null),
    timerDescriptor: removedRoundCard ? null : (snapshot.timerDescriptor ?? null),
    recoveryPending: !removedRoundCard && snapshot.status === "playing",
    recoveryTimeout: null,
    matchHistory: snapshot.matchHistory,
    selectedPackIds: normalizeSelectedPackIds(snapshot.selectedPackIds),
    gameMode: snapshot.gameMode,
    teamCount: snapshot.teamCount || 2,
    teams: snapshot.teams,
    teamTurnIndex: snapshot.teamTurnIndex || 0,
    teamPsychicIndexes: snapshot.teamPsychicIndexes,
    teamControllerIndexes: snapshot.teamControllerIndexes,
    roundReadyPlayerIds: removedRoundCard ? [] : snapshot.roundReadyPlayerIds,
    roundAdvanceEndsAt: removedRoundCard ? null : (snapshot.roundAdvanceEndsAt ?? null),
    roundAdvancePausedRemainingMs: removedRoundCard
      ? null
      : (snapshot.roundAdvancePausedRemainingMs ?? null),
    rematchVoteIds: removedRoundCard ? [] : snapshot.rematchVoteIds,
    matchStartedAt: removedRoundCard ? null : (snapshot.matchStartedAt ?? null),
    roundStartedAt: removedRoundCard ? null : (snapshot.roundStartedAt ?? null),
    currentRound: removedRoundCard
      ? resetRemovedCardRound(snapshot.currentRound)
      : snapshot.currentRound,
    finalState: removedRoundCard ? null : (snapshot.finalState ?? null),
  };
}

function markDegraded(error: unknown) {
  status = "degraded";

  captureException(error, { storageStatus: status });
}

async function flushPending() {
  if (!client?.isReady) return;
  for (const code of pendingDeletes) {
    await client.multi().del(`${KEY_PREFIX}${code}`).sRem(INDEX_KEY, code).exec();
    pendingDeletes.delete(code);
  }
  for (const [code, snapshot] of pendingSnapshots) {
    await client
      .multi()
      .set(`${KEY_PREFIX}${code}`, snapshot, { EX: TTL_SECONDS })
      .sAdd(INDEX_KEY, code)
      .exec();
    if (pendingSnapshots.get(code) === snapshot) pendingSnapshots.delete(code);
  }
}

export async function initializePersistence() {
  if (!REDIS_URL) return [];
  try {
    client = createClient({
      url: REDIS_URL,
      socket: { reconnectStrategy: (retries) => Math.min(retries * 250, 5000) },
    });
    client.on("error", markDegraded);
    client.on("ready", () => {
      status = "connected";

      flushPending().catch(markDegraded);
    });
    client.on("reconnecting", () => {
      status = "degraded";
    });
    const connection = client.connect();
    connection.catch(markDegraded);
    await Promise.race([
      connection,
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error("Redis startup timeout"));
        }, 5000),
      ),
    ]);
    const codes = await client.sMembers(INDEX_KEY);
    const values = codes.length
      ? await client.mGet(codes.map((code) => `${KEY_PREFIX}${code}`))
      : [];
    const rooms = [];
    for (let index = 0; index < codes.length; index++) {
      if (!values[index]) {
        await client.sRem(INDEX_KEY, present(codes[index]));
        continue;
      }
      try {
        const room = deserializeRoom(JSON.parse(present(values[index])));
        if (room) rooms.push(room);
      } catch (error) {
        markDegraded(error);
      }
    }
    status = "connected";
    return rooms;
  } catch (error) {
    markDegraded(error);
    return [];
  }
}

export const persistenceAdapter = {
  async save(room: Room) {
    if (!REDIS_URL) return;
    const snapshot = JSON.stringify(serializeRoom(room));
    pendingDeletes.delete(room.code);
    pendingSnapshots.set(room.code, snapshot);
    if (!client?.isReady) return;
    try {
      await client
        .multi()
        .set(`${KEY_PREFIX}${room.code}`, snapshot, { EX: TTL_SECONDS })
        .sAdd(INDEX_KEY, room.code)
        .exec();
      if (pendingSnapshots.get(room.code) === snapshot) pendingSnapshots.delete(room.code);
      status = "connected";
    } catch (error) {
      markDegraded(error);
    }
  },
  async remove(code: string) {
    if (!REDIS_URL) return;
    pendingSnapshots.delete(code);
    pendingDeletes.add(code);
    if (!client?.isReady) return;
    try {
      await client.multi().del(`${KEY_PREFIX}${code}`).sRem(INDEX_KEY, code).exec();
      pendingDeletes.delete(code);
    } catch (error) {
      markDegraded(error);
    }
  },
};

export function getStorageHealth() {
  return { configured: Boolean(REDIS_URL), status, degraded: status === "degraded" };
}

export async function recordCardRating(cardId: string, positive: boolean, targetRegion = "all") {
  const ratingKey = `${cardId}:${targetRegion}`;
  const voteKey = positive ? "positive" : "negative";
  const otherVoteKey = positive ? "negative" : "positive";
  const incrementMemory = (key: string) => {
    const value = memoryRatings.get(key) ?? { positive: 0, negative: 0 };
    value[voteKey]++;
    memoryRatings.set(key, value);
    return value;
  };
  const current = incrementMemory(ratingKey);
  const overall = ratingKey === cardId ? current : incrementMemory(cardId);
  if (client?.isReady) {
    try {
      const field = `${ratingKey}:${voteKey}`;
      const value = await client.hIncrBy(CARD_RATINGS_KEY, field, 1);
      const otherField = `${ratingKey}:${otherVoteKey}`;
      const other = Number((await client.hGet(CARD_RATINGS_KEY, otherField)) ?? 0);
      const regionAggregate = positive
        ? { positive: value, negative: other }
        : { positive: other, negative: value };
      if (ratingKey === cardId) {
        return {
          ...regionAggregate,
          overallPositive: regionAggregate.positive,
          overallNegative: regionAggregate.negative,
        };
      }
      const overallValue = await client.hIncrBy(CARD_RATINGS_KEY, `${cardId}:${voteKey}`, 1);
      const overallOther = Number(
        (await client.hGet(CARD_RATINGS_KEY, `${cardId}:${otherVoteKey}`)) ?? 0,
      );
      const overallAggregate = positive
        ? { overallPositive: overallValue, overallNegative: overallOther }
        : { overallPositive: overallOther, overallNegative: overallValue };
      return { ...regionAggregate, ...overallAggregate };
    } catch (error) {
      markDegraded(error);
    }
  }
  return {
    ...current,
    overallPositive: overall.positive,
    overallNegative: overall.negative,
  };
}

export async function closePersistence() {
  if (client?.isOpen) await client.quit();
  client = null;
}
