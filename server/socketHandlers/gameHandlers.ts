import { present } from "../invariants.js";
import type { GameIO, GameSocket } from "../types.js";
import { onAction } from "./boundary.js";
import { getRoom, allPlayersSubmitted, clearRoomTimer, touchActivity } from "../roomManager.js";
import { calculatePoints, getTargetRegion } from "../gameEngine.js";
import {
  advanceToNextRound,
  redrawCurrentCard,
  redrawTarget,
  setPlayerRoundReady,
  setRoundAdvancePaused,
  triggerReveal,
  startGuessTimer,
} from "./roundLogic.js";
import {
  cardContextIssue,
  roomCardRedrawStatus,
  socketSupportsCardRedraw,
  socketSupportsTargetRedraw,
} from "../services/capabilities.js";
import { targetRevisionIssue } from "../services/targetRedraw.js";
import { sanitizeClue } from "../validation.js";
import { recordCardRating } from "../persistence.js";
import { trackGameplay } from "../telemetry.js";

const REACTIONS = new Set(["👍", "😂", "😱", "🔥", "🎯", "👏"]);
const reactionWindows = new Map<string, number[]>();

const rateLimiters = new Map<string, number>();
function throttle(key: string, ms = 500) {
  const now = Date.now();
  const last = rateLimiters.get(key) ?? 0;
  if (now - last < ms) return true;
  rateLimiters.set(key, now);
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, v] of rateLimiters) {
    if (v < cutoff) rateLimiters.delete(k);
  }
  for (const [key, timestamps] of reactionWindows) {
    const recent = timestamps.filter((timestamp) => timestamp >= cutoff);
    if (recent.length) reactionWindows.set(key, recent);
    else reactionWindows.delete(key);
  }
}, 300_000).unref();

export function setupGameHandlers(io: GameIO, socket: GameSocket) {
  onAction(socket, "clue_submitted", ({ roomCode, clue, cardId, targetRevision }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    clue = sanitizeClue(clue) ?? "";

    if (!clue) return; // reject empty/whitespace/HTML clues

    const room = getRoom(roomCode);
    if (room?.status !== "playing" || room.currentRound.status !== "waiting") return;

    const contextIssue = cardContextIssue(room, cardId, {
      requireContext: socketSupportsCardRedraw(socket),
    });
    if (contextIssue) {
      socket.emit("action_error", { event: "clue_submitted", code: contextIssue });
      return;
    }
    const revisionIssue = targetRevisionIssue(room, targetRevision, {
      requireContext: socketSupportsTargetRedraw(socket),
    });
    if (revisionIssue) {
      socket.emit("action_error", { event: "clue_submitted", code: revisionIssue });
      return;
    }

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.currentRound.psychicId) return;

    if (room.currentRound.clue) return;
    touchActivity(room);

    // Clear psychic timeout, mark as submitted, save clue, start guessing timer
    clearRoomTimer(room);
    player.hasSubmitted = true;
    room.currentRound.clue = clue;
    room.currentRound.status = "guessing";

    io.to(roomCode).emit("clue_broadcast", { clue, psychicName: player.displayName });

    io.to(roomCode).emit("player_guessed", {
      playerId: player.id,
      allSubmitted: false,
    });

    startGuessTimer(io, room);
  });

  // Voluntary skipping was removed from the rules. Older clients that still send it get an
  // explicit rejection and nothing else happens: no penalty, no timer change, no advance.
  onAction(socket, "skip_round", () => {
    socket.emit("action_error", { event: "skip_round", code: "ACTION_REMOVED" });
  });

  onAction(socket, "redraw_card", ({ roomCode, cardId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (room?.status !== "playing") return;
    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.currentRound.psychicId) return;
    if (room.currentRound.card?.id !== cardId) {
      socket.emit("action_error", { event: "redraw_card", code: "STALE_CARD" });
      return;
    }
    const result = redrawCurrentCard(io, room, {
      playerId: player.id,
      redrawAvailable: roomCardRedrawStatus(io, room).available,
    });
    if (!result.ok) socket.emit("action_error", { event: "redraw_card", code: result.code });
  });

  // Only the current clue giver may move the answer position, and only its own socket learns
  // the new angle: everyone else keeps learning the target at the reveal like always.
  onAction(
    socket,
    "redraw_target",
    ({ roomCode, roundNumber, cardId, targetRevision, requestId }) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      const player = room?.players.find((candidate) => candidate.socketId === socket.id);
      const result = room
        ? redrawTarget(room, {
            playerId: player?.id ?? null,
            roundNumber,
            cardId,
            targetRevision,
            requestId,
            supported: socketSupportsTargetRedraw(socket),
          })
        : ({ ok: false, code: "ROOM_NOT_PLAYING" } as const);
      if (result.ok) {
        socket.emit("target_redrawn", result.payload);
        return;
      }
      socket.emit("action_error", { event: "redraw_target", code: result.code, requestId });
    },
  );

  onAction(socket, "guess_submitted", ({ roomCode, angle, cardId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    const room = getRoom(roomCode);
    const roundNumber = room?.currentRound.roundNumber ?? null;
    const reject = (reason: string): void => {
      socket.emit("guess_rejected", { roundNumber, reason });
    };

    if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
      reject("INVALID_ANGLE");
      return;
    }
    if (room?.status !== "playing") {
      reject("ROOM_NOT_PLAYING");
      return;
    }

    if (room.currentRound.status !== "guessing" || room.currentRound.targetAngle === null) {
      reject("NOT_GUESSING");
      return;
    }
    const contextIssue = cardContextIssue(room, cardId, {
      requireContext: socketSupportsCardRedraw(socket),
    });
    if (contextIssue) {
      reject(contextIssue);
      socket.emit("action_error", { event: "guess_submitted", code: contextIssue });
      return;
    }

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player || player.awaitingNextRound || player.id === room.currentRound.psychicId) {
      reject("NOT_ELIGIBLE");
      return;
    }
    if (room.gameMode === "teams" && player.id !== room.currentRound.controllerId) {
      reject("NOT_CONTROLLER");
      return;
    }

    if (throttle(`guess:${socket.id}`)) {
      reject("RATE_LIMITED");
      return;
    }

    if (player.hasSubmitted) {
      reject("ALREADY_SUBMITTED");
      return;
    }
    touchActivity(room);

    const points = calculatePoints(angle, room.currentRound.targetAngle);

    room.currentRound.guesses.push({
      playerId: player.id,
      angle,
      points,
    });

    player.hasSubmitted = true;

    socket.emit("guess_accepted", {
      roundNumber: room.currentRound.roundNumber,
      angle,
    });

    io.to(roomCode).emit("player_guessed", {
      playerId: player.id,
      teamId: room.gameMode === "teams" ? player.teamId : null,
      allSubmitted: allPlayersSubmitted(room),
    });

    if (allPlayersSubmitted(room)) {
      triggerReveal(io, roomCode);
    }
  });

  onAction(socket, "guess_preview", ({ roomCode, angle, roundNumber, cardId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    if (!Number.isFinite(angle) || angle < 0 || angle > 180) return;
    const room = getRoom(roomCode);
    if (
      room?.status !== "playing" ||
      room.gameMode !== "teams" ||
      room.currentRound.status !== "guessing" ||
      roundNumber !== room.currentRound.roundNumber
    )
      return;
    const controller = room.players.find((player) => player.socketId === socket.id);
    if (controller?.id !== room.currentRound.controllerId) return;
    const contextIssue = cardContextIssue(room, cardId, {
      requireContext: socketSupportsCardRedraw(socket),
    });
    if (contextIssue) {
      socket.emit("action_error", { event: "guess_preview", code: contextIssue });
      return;
    }
    if (throttle(`preview:${socket.id}`, 50)) return;

    room.currentRound.previewAngle = angle;
    const payload = {
      angle,
      roundNumber: room.currentRound.roundNumber,
      activeTeamId: room.currentRound.activeTeamId,
      controllerId: room.currentRound.controllerId,
    };
    room.players
      .filter(
        (player) =>
          player.isConnected &&
          player.teamId === room.currentRound.activeTeamId &&
          player.id !== controller.id,
      )
      .forEach((player) => io.to(player.socketId ?? "").emit("team_guess_preview", payload));
    for (const spectatorSocket of io.sockets.sockets.values()) {
      if (spectatorSocket.data.watchingRoomCode === room.code) {
        spectatorSocket.emit("team_guess_preview", payload);
      }
    }
  });

  onAction(socket, "next_round", ({ roomCode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    const room = getRoom(roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.ownerId) return;

    if (room.status !== "playing" || room.currentRound.status !== "revealed") return;

    advanceToNextRound(io, room);
  });

  onAction(socket, "round_ready", ({ roomCode, ready }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return;
    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player) return;
    setPlayerRoundReady(io, room, player.id, ready);
  });

  onAction(socket, "set_round_pause", ({ roomCode, roundNumber, paused }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (room?.currentRound.roundNumber !== roundNumber) return;
    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (player?.id !== room.ownerId || typeof paused !== "boolean") return;
    setRoundAdvancePaused(io, room, paused);
  });

  onAction(socket, "card_rating", async ({ roomCode, vote }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    if (!["up", "down"].includes(vote)) return;
    const room = getRoom(roomCode);
    if (room?.currentRound.status !== "revealed" || !room.currentRound.card) return;
    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player || player.awaitingNextRound) return;
    if (room.currentRound.ratings.some((rating) => rating.playerId === player.id)) return;
    const card = room.currentRound.card;
    const roundNumber = room.currentRound.roundNumber;
    const targetRegion = getTargetRegion(room.currentRound.targetAngle)?.id ?? "unknown";
    room.currentRound.ratings.push({ playerId: player.id, vote, targetRegion });
    touchActivity(room);
    const aggregate = await recordCardRating(card.id, vote === "up", targetRegion);
    socket.emit("card_rating_recorded", { vote });
    trackGameplay("card_rated", {
      playerId: player.id,
      roomId: room.code,
      cardId: card.id,
      packId: card.packId,
      targetRegion,
      vote,
      roundNumber,
    });
    const total = aggregate.positive + aggregate.negative;
    if (total >= 20 && aggregate.positive / total < 0.6) {
      trackGameplay("card_flagged_review", {
        roomId: room.code,
        cardId: card.id,
        packId: card.packId,
        targetRegion,
        positive: aggregate.positive,
      });
    }
    const overallTotal = aggregate.overallPositive + aggregate.overallNegative;
    if (overallTotal >= 20 && aggregate.overallPositive / overallTotal < 0.6) {
      trackGameplay("card_flagged_review", {
        roomId: room.code,
        cardId: card.id,
        packId: card.packId,
        targetRegion: "all",
        positive: aggregate.overallPositive,
      });
    }
  });

  onAction(socket, "send_reaction", ({ roomCode, reaction }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    if (!REACTIONS.has(reaction)) return;
    const room = getRoom(roomCode);
    if (!room || (room.currentRound.status !== "revealed" && room.status !== "finished")) return;
    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player || player.awaitingNextRound) return;
    const now = Date.now();
    const key = `${room.code}:${player.id}`;
    const recent = (reactionWindows.get(key) ?? []).filter((timestamp) => now - timestamp < 5000);
    if (recent.length >= 5 || (recent.length && now - present(recent[recent.length - 1]) < 400))
      return;
    recent.push(now);
    reactionWindows.set(key, recent);
    io.to(room.code).emit("reaction_received", { playerId: player.id, reaction });
    trackGameplay("reaction_sent", {
      playerId: player.id,
      roomId: room.code,
      reaction,
      roundNumber: room.currentRound.roundNumber,
    });
  });
}
