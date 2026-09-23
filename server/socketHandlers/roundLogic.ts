import { present } from "../invariants.js";
import { calculateRoundScore, scoreAfterSkip } from "../services/scoring.js";
import type { RevealData, Winner } from "@hint/contracts";
import type { GameIO, Room } from "../types.js";
import {
  drawCardForTarget,
  getNextPsychic,
  generateTargetAngle,
  generateReplacementTargetAngle,
  getWinners,
  calculateAwards,
  getTargetRegion,
} from "../gameEngine.js";
import {
  getRoom,
  clearRoomTimer,
  pauseRoomTimer,
  setRoomTimer,
  touchActivity,
  activateAwaitingPlayers,
  getPublicPlayers,
  removePlayer,
  persistRoom,
  resetRoundState,
  getPublicRoomMode,
} from "../roomManager.js";
import {
  getTeamWinners,
  getNextTeamRound,
  getPublicTeams,
  validateTeamSetup,
} from "../teamEngine.js";
import { TIMEOUTS } from "../config/gameConfig.js";
import { getCardsForPacks } from "../data/cards.js";
import { trackGameplay } from "../telemetry.js";
import { finishIfInsufficientPlayers, finishMatch } from "./matchLifecycle.js";
import { roomCardRedrawStatus } from "../services/capabilities.js";
import {
  spendTargetRedraw,
  targetRedrawOwner,
  targetRedrawState,
  targetRedrawsUsed,
} from "../services/targetRedraw.js";
import { TARGET_REDRAWS_PER_MATCH, type TargetRedrawState } from "@hint/contracts";

const GUESS_TIMEOUT_MS = TIMEOUTS.GUESS;
const PSYCHIC_TIMEOUT_MS = TIMEOUTS.PSYCHIC;
const GUESS_ACCEPTANCE_GRACE_MS = 750;
const ROUND_ADVANCE_MS = Number(process.env.ROUND_ADVANCE_MS) || 12_000;
const READY_ADVANCE_MS = Number(process.env.READY_ADVANCE_MS) || 650;

export function getRecoveryDelay(endsAt: number | null | undefined, now = Date.now()) {
  return Math.max(15_000, (endsAt ?? now) - now);
}

export function startRound(io: GameIO, room: Room) {
  touchActivity(room);
  clearRoomTimer(room);
  room.roundStartedAt = Date.now();
  room.roundReadyPlayerIds = [];
  room.roundAdvanceEndsAt = null;
  room.roundAdvancePausedRemainingMs = null;
  const activatedPlayers = activateAwaitingPlayers(room);
  activatedPlayers.forEach((player) => {
    void io.sockets.sockets.get(player.socketId ?? "")?.join(room.code);
  });
  const teamRound = room.gameMode === "teams" ? getNextTeamRound(room) : null;
  if (room.gameMode === "teams" && !teamRound) return;
  const psychicId = teamRound?.psychic.id ?? getNextPsychic(room);
  if (!psychicId) return;

  const psychicPlayer = teamRound?.psychic ?? room.players.find((p) => p.id === psychicId);
  if (!psychicPlayer?.isConnected) return;

  const targetAngle = generateTargetAngle();
  const deck = getCardsForPacks(room.selectedPackIds);
  const card = drawCardForTarget(deck, room.currentRound.usedCardIds, targetAngle);
  if (!card) return;

  room.currentRound.roundNumber++;
  room.currentRound.psychicId = psychicId;
  room.currentRound.card = { id: card.id, packId: card.packId, left: card.left, right: card.right };
  room.currentRound.targetAngle = targetAngle;
  room.currentRound.clue = null;
  room.currentRound.status = "waiting";
  room.currentRound.guesses = [];
  room.currentRound.pausedPsychicTimerRemaining = null;
  room.currentRound.revealData = null;
  room.currentRound.ratings = [];
  room.currentRound.activeTeamId = teamRound?.activeTeam.id ?? null;
  room.currentRound.controllerId = teamRound?.controller.id ?? null;
  room.currentRound.previewAngle = null;
  room.currentRound.shouldPromptRating = false;
  room.currentRound.redrawUsed = false;
  room.currentRound.targetRevision = 0;
  room.finalState = null;
  room.players.forEach((p) => {
    p.hasSubmitted = false;
  });

  const redraw = roomCardRedrawStatus(io, room);
  const targetRedraw = targetRedrawState(room);
  io.to(room.code).emit("round_start", {
    roundNumber: room.currentRound.roundNumber,
    psychicId,
    card: { id: card.id, packId: card.packId, left: card.left, right: card.right },
    players: getPublicPlayers(room),
    ...getPublicRoomMode(room),
    activeTeamId: room.currentRound.activeTeamId,
    controllerId: room.currentRound.controllerId,
    redrawUsed: false,
    redrawAvailable: redraw.available,
    redrawReason: redraw.reason,
    targetRedraw,
  });
  io.to(psychicPlayer.socketId ?? "").emit("target_reveal", {
    targetAngle,
    roundNumber: room.currentRound.roundNumber,
    cardId: room.currentRound.card.id,
    targetRevision: room.currentRound.targetRevision,
  });

  startPsychicTimer(io, room);
}

/**
 * Losing a turn to the automatic clue deadline: the owner (the psychic in individual mode,
 * the active team in team mode) loses exactly one point and the turn advances exactly once,
 * even if the timer callback arrives twice. Voluntary skipping no longer exists; this is the
 * only caller of the path.
 */
export function advanceExpiredPsychicTurn(io: GameIO, room: Room, psychicId: string): boolean {
  if (
    room.status !== "playing" ||
    room.currentRound.psychicId !== psychicId ||
    room.currentRound.status !== "waiting" ||
    room.currentRound.clue
  )
    return false;

  const psychic = room.players.find((p) => p.id === psychicId);
  if (!psychic) return false;

  const activeTeam = room.teams.find((team) => team.id === room.currentRound.activeTeamId);
  if (room.gameMode === "teams" && activeTeam) activeTeam.score = scoreAfterSkip(activeTeam.score);
  else psychic.score = scoreAfterSkip(psychic.score);
  const updatedScores = room.players.map((p) => ({
    playerId: p.id,
    displayName: p.displayName,
    totalScore: p.score,
  }));
  io.to(room.code).emit("round_skipped", {
    psychicName: psychic.displayName,
    penalty: -1,
    updatedScores,
    updatedTeams: getPublicTeams(room),
    gameMode: room.gameMode,
    source: "timeout",
  });
  trackGameplay("card_skipped_for_review", {
    playerId: psychic.id,
    roomId: room.code,
    cardId: room.currentRound.card?.id,
    packId: room.currentRound.card?.packId,
    targetRegion: getTargetRegion(room.currentRound.targetAngle)?.id ?? "unknown",
    roundNumber: room.currentRound.roundNumber,
    gameMode: room.gameMode,
    reason: "psychic_timeout",
  });
  startRound(io, room);
  return true;
}

export function startPsychicTimer(io: GameIO, room: Room, delayMs = PSYCHIC_TIMEOUT_MS) {
  if (!room.psychicTimerEnabled || !room.currentRound.psychicId) return null;
  const psychicId = room.currentRound.psychicId;
  const endsAt = setRoomTimer(
    room,
    () => {
      advanceExpiredPsychicTurn(io, room, psychicId);
    },
    delayMs,
    "psychic",
  );
  io.to(room.code).emit("timer_start", {
    endsAt,
    phase: "psychic",
    roundNumber: room.currentRound.roundNumber,
  });
  return endsAt;
}

/**
 * One free replacement per psychic turn. The round, target, roles and timer deadline all
 * stay as they are; only the card changes, and the discarded card stays used for draws.
 */
export function redrawCurrentCard(
  io: GameIO,
  room: Room,
  { playerId, redrawAvailable }: { playerId: string; redrawAvailable: boolean },
): { ok: true; previousCardId: string } | { ok: false; code: string } {
  const round = room.currentRound;
  if (room.status !== "playing") return { ok: false, code: "ROOM_NOT_PLAYING" };
  if (!redrawAvailable) return { ok: false, code: "REDRAW_UNAVAILABLE" };
  if (round.status !== "waiting" || round.clue) return { ok: false, code: "CLUE_ACCEPTED" };
  if (round.psychicId !== playerId) return { ok: false, code: "NOT_PSYCHIC" };
  if (round.redrawUsed) return { ok: false, code: "REDRAW_USED" };
  if (!round.card || round.targetAngle === null) return { ok: false, code: "NO_CARD" };

  const deck = getCardsForPacks(room.selectedPackIds);
  const card = drawCardForTarget(deck, round.usedCardIds, round.targetAngle);
  if (!card) return { ok: false, code: "NO_CARD" };

  const previousCardId = round.card.id;
  round.card = { id: card.id, packId: card.packId, left: card.left, right: card.right };
  round.redrawUsed = true;
  // The turn restarts before the clue: drafts and pre-clue previews belong to the old card.
  round.clue = null;
  round.previewAngle = null;
  touchActivity(room);
  persistRoom(room);

  io.to(room.code).emit("card_redrawn", {
    roundNumber: round.roundNumber,
    previousCardId,
    card: round.card,
    redrawUsed: true,
  });
  trackGameplay("card_redrawn", {
    playerId,
    roomId: room.code,
    packId: card.packId,
    targetRegion: getTargetRegion(round.targetAngle)?.id ?? "unknown",
    roundNumber: round.roundNumber,
    gameMode: room.gameMode,
  });
  return { ok: true, previousCardId };
}

export interface TargetRedrawRequest {
  playerId: string | null;
  roundNumber: number;
  cardId: string;
  targetRevision: number;
  requestId: string;
  /** Connection-time capability of the requesting socket. */
  supported: boolean;
  random?: () => number;
}

export interface TargetRedrawSuccess {
  requestId: string;
  roundNumber: number;
  cardId: string;
  previousTargetRevision: number;
  targetAngle: number;
  targetRedraw: TargetRedrawState;
}

/** A paused (disconnected) psychic turn has no descriptor, so it never reads as expired. */
function psychicDeadlineElapsed(room: Room, now = Date.now()): boolean {
  const descriptor = room.timerDescriptor;
  return room.psychicTimerEnabled && descriptor?.kind === "psychic" && descriptor.endsAt <= now;
}

/**
 * Moves the answer position of the live turn. Everything is checked and mutated
 * synchronously, so two clicks that arrive in the same tick cannot both spend a use: the
 * first one advances the revision and the second reads it as already used.
 */
export function redrawTarget(
  room: Room,
  {
    playerId,
    roundNumber,
    cardId,
    targetRevision,
    requestId,
    supported,
    random = Math.random,
  }: TargetRedrawRequest,
): { ok: true; payload: TargetRedrawSuccess } | { ok: false; code: string } {
  const round = room.currentRound;
  if (!playerId || round.psychicId !== playerId) return { ok: false, code: "NOT_PSYCHIC" };
  if (!supported) return { ok: false, code: "TARGET_REDRAW_UNSUPPORTED" };
  if (room.status !== "playing") return { ok: false, code: "ROOM_NOT_PLAYING" };
  if (round.roundNumber !== roundNumber) return { ok: false, code: "STALE_ROUND" };
  if (round.status !== "waiting" || round.clue) return { ok: false, code: "CLUE_ACCEPTED" };
  const card = round.card;
  if (card?.id !== cardId) return { ok: false, code: "STALE_CARD" };
  if (round.targetRevision !== targetRevision) return { ok: false, code: "STALE_TARGET" };
  if (round.targetRevision > 0) return { ok: false, code: "TARGET_REDRAW_USED" };

  const ownerId = targetRedrawOwner(room);
  if (!ownerId) return { ok: false, code: "NO_TARGET" };
  const used = targetRedrawsUsed(room, ownerId);
  if (used >= TARGET_REDRAWS_PER_MATCH) return { ok: false, code: "TARGET_REDRAW_EXHAUSTED" };

  const previousAngle = round.targetAngle;
  if (previousAngle === null || !Number.isFinite(previousAngle)) {
    return { ok: false, code: "NO_TARGET" };
  }
  if (psychicDeadlineElapsed(room)) return { ok: false, code: "TURN_EXPIRED" };

  const targetAngle = generateReplacementTargetAngle(previousAngle, random);

  const previousTargetRevision = round.targetRevision;
  round.targetAngle = targetAngle;
  round.targetRevision = previousTargetRevision + 1;
  spendTargetRedraw(room, ownerId, used);
  // Drafts and pre-clue previews belong to the old position and must not survive the change.
  round.previewAngle = null;
  touchActivity(room);
  persistRoom(room);

  trackGameplay("target_redrawn", {
    roomId: room.code,
    roundNumber: round.roundNumber,
    cardId: card.id,
    packId: card.packId,
    targetRegion: getTargetRegion(targetAngle)?.id ?? "unknown",
    gameMode: room.gameMode,
    reason: room.gameMode === "teams" ? "team_allowance" : "player_allowance",
  });

  return {
    ok: true,
    payload: {
      requestId,
      roundNumber: round.roundNumber,
      cardId: card.id,
      previousTargetRevision,
      targetAngle,
      targetRedraw: targetRedrawState(room),
    },
  };
}

export function resumePsychicTimer(io: GameIO, room: Room, remainingMs: number | null) {
  if (!remainingMs || room.currentRound.status !== "waiting") return null;
  return startPsychicTimer(io, room, remainingMs);
}

export function triggerReveal(io: GameIO, roomCode: string) {
  const room = getRoom(roomCode);
  if (
    room?.status !== "playing" ||
    room.currentRound.status !== "guessing" ||
    room.currentRound.targetAngle === null ||
    !room.currentRound.card
  )
    return;

  clearRoomTimer(room);
  room.currentRound.status = "revealed";
  const now = Date.now();
  const roundDurationMs = Math.max(0, now - (room.roundStartedAt ?? now));

  const targetAngle = room.currentRound.targetAngle;
  const psychicId = room.currentRound.psychicId;
  const {
    guessResults,
    playerScores,
    psychicPoints,
    psychicBreakdown,
    updatedScores,
    updatedTeams,
  } = calculateRoundScore(room);
  for (const score of updatedScores) {
    const player = room.players.find((candidate) => candidate.id === score.playerId);
    if (player) player.score = score.totalScore;
  }
  for (const score of updatedTeams) {
    const team = room.teams.find((candidate) => candidate.id === score.id);
    if (team) team.score = score.score;
  }
  const winningEntries =
    room.gameMode === "teams" ? getTeamWinners(room) : getWinners(room.players, room.winningScore);
  const winner = winningEntries[0] ?? null;
  const winners: Winner[] = winningEntries.map((entry) =>
    "name" in entry
      ? { teamId: entry.id, displayName: entry.name, score: entry.score }
      : { playerId: entry.id, displayName: entry.displayName, score: entry.score },
  );
  const shouldPromptRating =
    playerScores.every((score) => score === 0) ||
    (room.currentRound.roundNumber + room.currentRound.card.id.length) % 4 === 0;
  room.currentRound.shouldPromptRating = shouldPromptRating;

  let revealData: RevealData = {
    targetAngle,
    guesses: guessResults,
    psychicPoints,
    psychicBreakdown,
    updatedScores,
    updatedTeams,
    gameMode: room.gameMode,
    activeTeamId: room.currentRound.activeTeamId,
    shouldPromptRating,
    winner: winner
      ? "name" in winner
        ? { teamId: winner.id, displayName: winner.name, score: winner.score }
        : { playerId: winner.id, displayName: winner.displayName, score: winner.score }
      : null,
    winners,
  };
  const historyEntry = {
    roundNumber: room.currentRound.roundNumber,
    cardId: room.currentRound.card.id,
    packId: room.currentRound.card.packId,
    psychicId,
    psychicPoints,
    gameMode: room.gameMode,
    teamId: room.currentRound.activeTeamId,
    controllerId: room.currentRound.controllerId,
    guesses: guessResults.flatMap((result) =>
      result.angle !== null && result.playerId !== null
        ? [
            {
              playerId: result.playerId,
              angle: result.angle,
              points: result.points,
              distance: Math.abs(result.angle - targetAngle),
            },
          ]
        : [],
    ),
  };
  room.matchHistory.push(historyEntry);
  room.currentRound.revealData = revealData;
  trackGameplay("round_completed", {
    roomId: room.code,
    roomStatus: room.status,
    roundNumber: room.currentRound.roundNumber,
    playerCount: room.players.filter(
      (player) =>
        !player.awaitingNextRound &&
        (player.isConnected ||
          room.currentRound.guesses.some((guess) => guess.playerId === player.id)),
    ).length,
    cardId: room.currentRound.card.id,
    packId: room.currentRound.card.packId,
    durationMs: roundDurationMs,
    winningScore: room.winningScore,
    gameMode: room.gameMode,
    teamCount: room.teamCount,
  });
  trackGameplay("reveal_completed", {
    roomId: room.code,
    roundNumber: room.currentRound.roundNumber,
  });

  if (winner) {
    const finalState = {
      ...revealData,
      awards: room.gameMode === "teams" ? [] : calculateAwards(room.matchHistory, room.players),
      matchRoundCount: room.matchHistory.length,
    };
    revealData = finishMatch(io, room, finalState, { eventName: null, setRevealData: true });
    trackGameplay("game_completed", {
      roomId: room.code,
      roomStatus: room.status,
      roundNumber: room.matchHistory.length,
      playerCount: room.players.filter((player) => !player.awaitingNextRound).length,
      packCount: room.selectedPackIds.length,
      durationMs: Math.max(0, now - (room.matchStartedAt ?? now)),
      winningScore: room.winningScore,
      gameMode: room.gameMode,
      teamCount: room.teamCount,
    });
  }
  if (!winner) {
    scheduleRoundAdvance(io, room, ROUND_ADVANCE_MS);
    revealData.readyState = getRoundReadyState(room);
  }
  io.to(roomCode).emit("reveal_phase", revealData);
}

function activeReadyPlayers(room: Room) {
  return room.players.filter((player) => player.isConnected && !player.awaitingNextRound);
}

export function getRoundReadyState(room: Room) {
  const required = activeReadyPlayers(room);
  const requiredIds = new Set(required.map((player) => player.id));
  room.roundReadyPlayerIds = room.roundReadyPlayerIds.filter((id) => requiredIds.has(id));
  return {
    playerIds: [...room.roundReadyPlayerIds],
    readyCount: room.roundReadyPlayerIds.length,
    requiredCount: required.length,
    endsAt: room.roundAdvanceEndsAt ?? null,
    paused: room.roundAdvancePausedRemainingMs !== null,
    remainingMs: room.roundAdvancePausedRemainingMs,
  };
}

export function emitRoundReady(io: GameIO, room: Room) {
  io.to(room.code).emit("round_ready_updated", getRoundReadyState(room));
}

export function advanceToNextRound(io: GameIO, room: Room) {
  if (room.status !== "playing" || room.currentRound.status !== "revealed") return false;
  const activatedPlayers = activateAwaitingPlayers(room);
  activatedPlayers.forEach((player) => {
    void io.sockets.sockets.get(player.socketId ?? "")?.join(room.code);
  });
  const connectedPlayers = room.players.filter(
    (player) => player.isConnected && !player.awaitingNextRound,
  );
  if (
    connectedPlayers.length < 2 ||
    (room.gameMode === "teams" && !validateTeamSetup(room).valid)
  ) {
    scheduleRoundAdvance(io, room, 3_000);
    return false;
  }
  clearRoomTimer(room);
  room.roundAdvanceEndsAt = null;
  room.roundAdvancePausedRemainingMs = null;
  room.roundReadyPlayerIds = [];
  resetRoundState(room);
  startRound(io, room);
  return true;
}

export function scheduleRoundAdvance(io: GameIO, room: Room, delayMs = ROUND_ADVANCE_MS) {
  if (room.status !== "playing" || room.currentRound.status !== "revealed") return null;
  room.roundAdvancePausedRemainingMs = null;
  const endsAt = setRoomTimer(
    room,
    () => advanceToNextRound(io, room),
    Math.max(READY_ADVANCE_MS, delayMs),
    "round-ready",
  );
  room.roundAdvanceEndsAt = endsAt;
  emitRoundReady(io, room);
  return endsAt;
}

export function setRoundAdvancePaused(io: GameIO, room: Room, paused: boolean) {
  if (room.status !== "playing" || room.currentRound.status !== "revealed") return false;
  const isPaused = room.roundAdvancePausedRemainingMs !== null;
  if (paused === isPaused) {
    emitRoundReady(io, room);
    return true;
  }
  if (paused) {
    room.roundAdvancePausedRemainingMs = pauseRoomTimer(room) ?? ROUND_ADVANCE_MS;
    room.roundAdvanceEndsAt = null;
    touchActivity(room);
    emitRoundReady(io, room);
    return true;
  }

  const remaining = room.roundAdvancePausedRemainingMs;
  room.roundAdvancePausedRemainingMs = null;
  const ready = getRoundReadyState(room);
  scheduleRoundAdvance(
    io,
    room,
    ready.requiredCount > 0 && ready.readyCount >= ready.requiredCount
      ? READY_ADVANCE_MS
      : (remaining ?? ROUND_ADVANCE_MS),
  );
  return true;
}

export function setPlayerRoundReady(io: GameIO, room: Room, playerId: string, ready = true) {
  if (room.status !== "playing" || room.currentRound.status !== "revealed") return false;
  const eligible = activeReadyPlayers(room).some((player) => player.id === playerId);
  if (!eligible) return false;
  const readyIds = new Set(room.roundReadyPlayerIds);
  if (ready) readyIds.add(playerId);
  else readyIds.delete(playerId);
  room.roundReadyPlayerIds = [...readyIds];
  const readyState = getRoundReadyState(room);
  if (
    readyState.requiredCount > 0 &&
    readyState.readyCount >= readyState.requiredCount &&
    !readyState.paused
  ) {
    scheduleRoundAdvance(io, room, READY_ADVANCE_MS);
  } else {
    touchActivity(room);
    emitRoundReady(io, room);
  }
  return true;
}

export function startGuessTimer(io: GameIO, room: Room, delayMs = GUESS_TIMEOUT_MS) {
  const endsAt = Date.now() + delayMs;
  setRoomTimer(
    room,
    () => {
      triggerReveal(io, room.code);
    },
    delayMs + GUESS_ACCEPTANCE_GRACE_MS,
    "guess",
  );
  room.timerEndsAt = endsAt;
  if (room.timerDescriptor) room.timerDescriptor.endsAt = endsAt;
  persistRoom(room);
  io.to(room.code).emit("timer_start", {
    endsAt,
    phase: "guessing",
    roundNumber: room.currentRound.roundNumber,
  });
}

export function resumeRecoveredRoom(io: GameIO, room: Room) {
  if (!room.recoveryPending || room.status !== "playing") return false;
  const connected = room.players.filter(
    (player) => player.isConnected && !player.awaitingNextRound,
  );
  const descriptor = room.timerDescriptor;
  const remaining = getRecoveryDelay(descriptor?.endsAt);
  const psychic = room.players.find((player) => player.id === room.currentRound.psychicId);

  const scheduleRecoveryExpiry = () => {
    if (room.recoveryTimeout) return;
    const roundNumber = room.currentRound.roundNumber;
    const timeout = setTimeout(() => {
      if (
        getRoom(room.code) !== room ||
        !room.recoveryPending ||
        room.currentRound.roundNumber !== roundNumber ||
        room.recoveryTimeout !== timeout
      )
        return;
      room.recoveryTimeout = null;
      const disconnected = room.players.filter((player) => !player.isConnected);
      disconnected.forEach((player) => removePlayer(room, player.id));
      const active = room.players.filter(
        (player) => player.isConnected && !player.awaitingNextRound,
      );
      if (!room.players.some((player) => player.id === room.ownerId) && active.length) {
        room.ownerId = present(active[0]).id;
        io.to(room.code).emit("ownership_transferred", { ownerId: room.ownerId });
      }
      const recoveredTeamSetupValid = room.gameMode !== "teams" || validateTeamSetup(room).valid;
      if (active.length < 2 || !recoveredTeamSetupValid) {
        finishIfInsufficientPlayers(io, room, "recovery_insufficient_players");
      } else {
        room.recoveryPending = false;
        clearRoomTimer(room);
        startRound(io, room);
      }
      persistRoom(room);
    }, TIMEOUTS.RECONNECT_GRACE);
    room.recoveryTimeout = timeout;
  };

  const enoughPlayers =
    room.gameMode === "teams" ? validateTeamSetup(room).valid : connected.length >= 2;
  if (!enoughPlayers) {
    if (connected.length > 0) scheduleRecoveryExpiry();
    return false;
  }

  if (room.currentRound.status === "waiting" && !psychic?.isConnected) {
    scheduleRecoveryExpiry();
    return false;
  }

  if (room.recoveryTimeout) {
    clearTimeout(room.recoveryTimeout);
    room.recoveryTimeout = null;
  }
  room.recoveryPending = false;
  if (room.currentRound.status === "waiting") startPsychicTimer(io, room, remaining);
  else if (room.currentRound.status === "guessing") {
    startGuessTimer(io, room, remaining);
  } else {
    const ownerConnected = room.players.some(
      (player) => player.id === room.ownerId && player.isConnected,
    );
    if (room.roundAdvancePausedRemainingMs !== null && ownerConnected) {
      emitRoundReady(io, room);
    } else {
      const revealDelay = room.roundAdvancePausedRemainingMs ?? remaining;
      room.roundAdvancePausedRemainingMs = null;
      scheduleRoundAdvance(io, room, revealDelay);
    }
  }
  persistRoom(room);
  return true;
}
