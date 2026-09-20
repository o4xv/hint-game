import { RoomTimerScheduler } from "./timerScheduler.js";
import type { ReconnectSnapshot, RedrawReason } from "@hint/contracts";
import type {
  JoinRequest,
  PersistenceAdapter,
  TimeoutHandle,
  TimerKind,
  Player,
  Room,
} from "./types.js";
import crypto from "node:crypto";
import { CLEANUP, TIMEOUTS, ROOMS } from "./config/gameConfig.js";
import {
  assignPlayerToSmallestTeam,
  createTeams,
  ensureTeamState,
  getPublicTeams,
} from "./teamEngine.js";

// ─── In-Memory Room Store ───
const rooms = new Map<string, Room>();
const roomTimers = new RoomTimerScheduler((code) => rooms.get(code) ?? null);
let persistence: PersistenceAdapter | null = null;
const DEFAULT_PACK_IDS = ["core", "daily-life", "entertainment"];

export function setPersistenceAdapter(adapter: PersistenceAdapter | null) {
  persistence = adapter;
}

export function restoreRooms(restoredRooms: Room[] = []) {
  for (const room of restoredRooms) {
    ensureTeamState(room);
    room.roundAdvanceEndsAt ??= null;
    room.roundAdvancePausedRemainingMs ??= null;
    room.matchStartedAt ??= null;
    room.roundStartedAt ??= null;
    room.currentRound.activeTeamId ??= null;
    room.currentRound.controllerId ??= null;
    room.currentRound.shouldPromptRating ||= false;
    rooms.set(room.code, room);
  }
  return restoredRooms.length;
}

export function persistRoom(room: Room) {
  if (!persistence) return;
  queueMicrotask(() => {
    void persistence?.save(room);
  });
}

// ─── Constants ───
const RECONNECT_GRACE_MS = TIMEOUTS.RECONNECT_GRACE;
const FAST_INTERVAL = CLEANUP.FAST_INTERVAL;
const EMPTY_TTL = CLEANUP.EMPTY_TTL;
const SLOW_INTERVAL = CLEANUP.SLOW_INTERVAL;
const IDLE_TTL = CLEANUP.IDLE_TTL;
const MAX_ROOMS = ROOMS.MAX_ROOMS;
const MAX_PLAYERS = ROOMS.MAX_PLAYERS;

// ─── Room Factory ───

export function createRoom(
  code: string,
  ownerId: string,
  ownerSocketId: string | null,
  displayName: string,
  winningScore: number,
) {
  const token = crypto.randomUUID();
  const room: Room = {
    code,
    ownerId,
    status: "waiting",
    winningScore,
    psychicTimerEnabled: false,
    roomLocked: false,
    snapshotVersion: 2,
    selectedPackIds: [...DEFAULT_PACK_IDS],
    gameMode: "individual",
    teamCount: 2,
    teams: createTeams(2),
    teamTurnIndex: 0,
    teamPsychicIndexes: {},
    teamControllerIndexes: {},
    roundReadyPlayerIds: [],
    roundAdvanceEndsAt: null,
    roundAdvancePausedRemainingMs: null,
    rematchVoteIds: [],
    lastActivity: Date.now(),
    matchStartedAt: null,
    roundStartedAt: null,
    joinRequests: [],
    players: [
      {
        id: ownerId,
        socketId: ownerSocketId,
        displayName,
        score: 0,
        isConnected: true,
        hasSubmitted: false,
        awaitingNextRound: false,
        reconnectToken: token,
        disconnectTimeout: null,
        teamId: null,
      },
    ],
    currentRound: {
      roundNumber: 0,
      psychicId: null,
      card: null,
      targetAngle: null,
      clue: null,
      status: "waiting",
      guesses: [],
      usedCardIds: [],
      psychicOrder: [],
      psychicIndex: 0,
      pausedPsychicTimerRemaining: null,
      revealData: null,
      ratings: [],
      activeTeamId: null,
      controllerId: null,
      previewAngle: null,
      shouldPromptRating: false,
      redrawUsed: false,
    },
    timer: null,
    timerEndsAt: null,
    timerDescriptor: null,
    recoveryPending: false,
    recoveryTimeout: null,
    matchHistory: [],
    finalState: null,
  };

  rooms.set(code, room);
  persistRoom(room);
  return room;
}

// ─── Room Access ───

export function getRoom(code: string) {
  return rooms.get(code) ?? null;
}

export function deleteRoom(code: string) {
  const room = rooms.get(code);
  if (room) {
    roomTimers.clear(room);
    room.roundAdvanceEndsAt = null;
    room.roundAdvancePausedRemainingMs = null;
  }
  // Clear all disconnect timeouts
  room?.players.forEach((p) => {
    if (p.disconnectTimeout) clearTimeout(p.disconnectTimeout);
  });
  room?.joinRequests.forEach((request) => {
    if (request.timeout) clearTimeout(request.timeout);
  });
  if (room?.recoveryTimeout) clearTimeout(room.recoveryTimeout);
  const deleted = rooms.delete(code);
  if (deleted && persistence)
    queueMicrotask(() => {
      void persistence?.remove(code);
    });
  return deleted;
}

export function roomExists(code: string) {
  return rooms.has(code);
}

export function roomsFull() {
  return rooms.size >= MAX_ROOMS;
}

export function touchActivity(room: Room) {
  room.lastActivity = Date.now();
  persistRoom(room);
}

// ─── Player Management ───

export function addPlayer(
  room: Room,
  playerId: string,
  socketId: string,
  displayName: string,
  { awaitingNextRound = false } = {},
) {
  if (room.players.length >= MAX_PLAYERS) return null;

  const token = crypto.randomUUID();
  const player: Player = {
    id: playerId,
    socketId,
    displayName,
    score: 0,
    isConnected: true,
    hasSubmitted: false,
    awaitingNextRound,
    reconnectToken: token,
    disconnectTimeout: null,
    teamId: null,
  };

  room.players.push(player);
  if (room.gameMode === "teams") assignPlayerToSmallestTeam(room, player);
  touchActivity(room);
  return player;
}

export function removePlayer(room: Room, playerId: string) {
  const index = room.players.findIndex((p) => p.id === playerId);
  if (index === -1) return null;
  const [removed] = room.players.splice(index, 1);
  if (!removed) return null;
  if (removed.disconnectTimeout) clearTimeout(removed.disconnectTimeout);
  prunePsychicOrder(room);
  room.roundReadyPlayerIds = room.roundReadyPlayerIds.filter((id) => id !== playerId);
  room.rematchVoteIds = room.rematchVoteIds.filter((id) => id !== playerId);
  touchActivity(room);
  return removed;
}

export function addJoinRequest(room: Room, request: JoinRequest) {
  room.joinRequests.push(request);
  touchActivity(room);
  return request;
}

export function getJoinRequest(room: Room, requestId: string) {
  return room.joinRequests.find((request) => request.id === requestId) ?? null;
}

export function removeJoinRequest(room: Room, requestId: string) {
  const index = room.joinRequests.findIndex((request) => request.id === requestId);
  if (index === -1) return null;
  const [request] = room.joinRequests.splice(index, 1);
  if (!request) return null;
  if (request.timeout) clearTimeout(request.timeout);
  touchActivity(room);
  return request;
}

export function activateAwaitingPlayers(room: Room) {
  const activated = room.players.filter((player) => player.awaitingNextRound && player.isConnected);
  activated.forEach((player) => {
    player.awaitingNextRound = false;
  });
  return activated;
}

export function getPlayer(room: Room, playerId: string) {
  return room.players.find((p) => p.id === playerId) ?? null;
}

export function getPlayerByToken(room: Room, token: string) {
  return room.players.find((p) => p.reconnectToken === token) ?? null;
}

export function disconnectPlayer(room: Room, playerId: string) {
  const player = getPlayer(room, playerId);
  if (player) player.isConnected = false;
  return player;
}

export function reconnectPlayer(room: Room, playerId: string, newSocketId: string) {
  const player = getPlayer(room, playerId);
  if (!player) return null;
  if (player.disconnectTimeout) {
    clearTimeout(player.disconnectTimeout);
    player.disconnectTimeout = null;
  }
  player.socketId = newSocketId;
  player.isConnected = true;
  touchActivity(room);
  return player;
}

// ─── Room State Management ───

export function updateRoomStatus(room: Room, status: Room["status"]) {
  room.status = status;
  touchActivity(room);
}

export function resetRoundState(room: Room) {
  clearRoomTimer(room);
  room.players.forEach((p) => {
    p.hasSubmitted = false;
  });
  room.currentRound.clue = null;
  room.currentRound.guesses = [];
  room.currentRound.status = "waiting";
  room.currentRound.pausedPsychicTimerRemaining = null;
  room.currentRound.revealData = null;
  room.currentRound.ratings = [];
  room.currentRound.activeTeamId = null;
  room.currentRound.controllerId = null;
  room.currentRound.previewAngle = null;
  room.currentRound.shouldPromptRating = false;
  room.currentRound.redrawUsed = false;
  room.roundReadyPlayerIds = [];
  room.roundAdvanceEndsAt = null;
  room.roundAdvancePausedRemainingMs = null;
}

export function getPublicPlayers(room: Room) {
  return room.players.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    score: p.score,
    isConnected: p.isConnected,
    hasSubmitted: p.hasSubmitted,
    awaitingNextRound: p.awaitingNextRound,
    teamId: p.teamId ?? null,
  }));
}

export function getPublicRoomMode(room: Room) {
  ensureTeamState(room);
  return {
    gameMode: room.gameMode,
    teamCount: room.teamCount,
    teams: getPublicTeams(room),
  };
}

export function allPlayersSubmitted(room: Room) {
  if (room.gameMode === "teams") {
    const controller = room.players.find((player) => player.id === room.currentRound.controllerId);
    return Boolean(controller?.hasSubmitted && room.currentRound.guesses.length);
  }
  const guessers = room.players.filter(
    (p) => p.id !== room.currentRound.psychicId && p.isConnected && !p.awaitingNextRound,
  );
  return guessers.length > 0 && guessers.every((p) => p.hasSubmitted);
}

// ─── Timer Management ───

export function clearRoomTimer(room: Room) {
  roomTimers.clear(room);
  persistRoom(room);
}

export function setRoomTimer(
  room: Room,
  callback: () => void,
  delayMs: number,
  kind: TimerKind = "guess",
) {
  const endsAt = roomTimers.schedule(room, callback, delayMs, kind);
  persistRoom(room);
  return endsAt;
}

export function pauseRoomTimer(room: Room) {
  const remaining = roomTimers.pause(room);
  persistRoom(room);
  return remaining;
}

// ─── Reconnect Grace Period ───

export function scheduleReconnectTimeout(
  room: Room,
  playerId: string,
  onExpire: (playerId: string) => void,
) {
  const player = getPlayer(room, playerId);
  if (!player) return;
  if (player.disconnectTimeout) clearTimeout(player.disconnectTimeout);
  const token = setTimeout(() => {
    if (
      getRoom(room.code) !== room ||
      player.disconnectTimeout !== token ||
      player.isConnected ||
      !room.players.includes(player)
    )
      return;
    player.disconnectTimeout = null;
    onExpire(playerId);
  }, RECONNECT_GRACE_MS);
  player.disconnectTimeout = token;
}

export function clearReconnectTimeout(room: Room, playerId: string) {
  const player = getPlayer(room, playerId);
  if (player?.disconnectTimeout) {
    clearTimeout(player.disconnectTimeout);
    player.disconnectTimeout = null;
  }
}

// ─── TTL Cleanup ───

let cleanupInterval: TimeoutHandle | null = null;
let fastCleanupInterval: TimeoutHandle | null = null;

export function startTTLCleanup() {
  if (cleanupInterval) return;

  // Fast cleanup: delete rooms with 0 connected players for >5min (runs every 60s)
  fastCleanupInterval = setInterval(() => {
    const now = Date.now();
    let deleted = 0;
    for (const [code, room] of rooms) {
      const connected = room.players.filter((p) => p.isConnected).length;
      if (connected === 0 && now - room.lastActivity > EMPTY_TTL) {
        deleteRoom(code);
        deleted++;
      }
    }
    if (deleted > 0) {
      console.log(`[roomManager] fast cleanup: removed ${deleted} empty room(s)`);
    }
  }, FAST_INTERVAL).unref();

  // Slow cleanup: delete rooms idle for >2 hours (runs every 30min)
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let deleted = 0;
    for (const [code, room] of rooms) {
      if (now - room.lastActivity > IDLE_TTL) {
        deleteRoom(code);
        deleted++;
      }
    }
    if (deleted > 0) {
      console.log(`[roomManager] TTL cleanup: removed ${deleted} abandoned room(s)`);
    }
  }, SLOW_INTERVAL).unref();

  console.log(
    `[roomManager] Cleanup started (fast:${FAST_INTERVAL / 1000}s/${EMPTY_TTL / 60000}min, slow:${SLOW_INTERVAL / 60000}min/${IDLE_TTL / 3600000}h, max:${MAX_ROOMS})`,
  );
}

export function stopTTLCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (fastCleanupInterval) {
    clearInterval(fastCleanupInterval);
    fastCleanupInterval = null;
  }
}

// ─── Reconnect State Export ───

export function getRematchState(room: Room) {
  const connected = new Set(
    room.players.filter((player) => player.isConnected).map((player) => player.id),
  );
  const playerIds = room.rematchVoteIds.filter((id) => connected.has(id));
  return {
    playerIds,
    voteCount: playerIds.length,
    requiredCount: Math.floor(connected.size / 2) + 1,
  };
}

export function getReconnectState(
  room: Room,
  playerId: string,
  {
    redrawAvailable = false,
    redrawReason = null,
  }: { redrawAvailable?: boolean; redrawReason?: RedrawReason | null } = {},
): ReconnectSnapshot {
  touchActivity(room);
  const player = getPlayer(room, playerId);
  const isPsychic = room.currentRound.psychicId === playerId;
  const submittedGuess = room.currentRound.guesses.find((g) => g.playerId === playerId);
  const submittedRating = room.currentRound.ratings.find((rating) => rating.playerId === playerId);
  const connectedPlayerIds = new Set(
    room.players
      .filter((candidate) => candidate.isConnected && !candidate.awaitingNextRound)
      .map((candidate) => candidate.id),
  );
  const readyPlayerIds = room.roundReadyPlayerIds.filter((id) => connectedPlayerIds.has(id));
  const state = {
    roomCode: room.code,
    status: room.status,
    redrawAvailable,
    winningScore: room.winningScore,
    psychicTimerEnabled: room.psychicTimerEnabled,
    roomLocked: room.roomLocked,
    selectedPackIds: [...room.selectedPackIds],
    ...getPublicRoomMode(room),
    readyState: {
      playerIds: readyPlayerIds,
      readyCount: readyPlayerIds.length,
      requiredCount: connectedPlayerIds.size,
      endsAt: room.roundAdvanceEndsAt ?? null,
      paused: room.roundAdvancePausedRemainingMs !== null,
      remainingMs: room.roundAdvancePausedRemainingMs,
    },
    rematchState: getRematchState(room),
    awaitingNextRound: player?.awaitingNextRound ?? false,
    players: getPublicPlayers(room),
    currentRound:
      ["playing", "finished"].includes(room.status) && !player?.awaitingNextRound
        ? {
            roundNumber: room.currentRound.roundNumber,
            psychicId: room.currentRound.psychicId,
            card: room.currentRound.card,
            clue: room.currentRound.clue,
            status: room.currentRound.status,
            timerEndsAt: room.timerEndsAt,
            timerPhase:
              room.timerDescriptor?.kind === "guess"
                ? ("guessing" as const)
                : (room.timerDescriptor?.kind ?? null),
            hasSubmitted: player?.hasSubmitted ?? false,
            hasRated: Boolean(submittedRating),
            myRatingVote: submittedRating?.vote ?? null,
            activeTeamId: room.currentRound.activeTeamId ?? null,
            controllerId: room.currentRound.controllerId ?? null,
            shouldPromptRating: room.currentRound.shouldPromptRating,
            redrawUsed: room.currentRound.redrawUsed,
            redrawAvailable,
            redrawReason,
            myGuessAngle: submittedGuess?.angle ?? null,
            revealData:
              room.currentRound.status === "revealed" ? room.currentRound.revealData : null,
          }
        : null,
    finalState: room.status === "finished" ? room.finalState : null,
  };
  const { currentRound, ...base } = state;
  if (!currentRound) return { ...base, currentRound: null };
  const publicRound = {
    ...currentRound,
    // Older clients read readiness from the nested reveal before the top-level snapshot.
    revealData: currentRound.revealData
      ? { ...currentRound.revealData, readyState: base.readyState }
      : null,
  };
  return {
    ...base,
    currentRound: isPsychic
      ? { ...publicRound, psychicTargetAngle: room.currentRound.targetAngle }
      : publicRound,
  };
}

export function prunePsychicOrder(room: Room) {
  const connectedIds = room.players
    .filter((p) => p.isConnected && !p.awaitingNextRound)
    .map((p) => p.id);
  const connected = new Set(connectedIds);
  const round = room.currentRound;
  const completed = round.psychicOrder
    .slice(0, round.psychicIndex)
    .filter((id) => connected.has(id));
  const pending = round.psychicOrder.slice(round.psychicIndex).filter((id) => connected.has(id));
  const known = new Set([...completed, ...pending]);

  round.psychicOrder = [...completed, ...pending, ...connectedIds.filter((id) => !known.has(id))];
  round.psychicIndex = completed.length;
}

// ─── Room Iteration (read-only accessor) ───

export function getAllRooms() {
  return [...rooms.entries()];
}

export function getRoomCount() {
  return rooms.size;
}

// ─── Exports ───

export { RECONNECT_GRACE_MS, MAX_ROOMS };
