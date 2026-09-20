import { required } from "./helpers.js";
import type { GameIO } from "../types.js";
import test from "node:test";
import assert from "node:assert/strict";
import { addPlayer, createRoom, deleteRoom } from "../roomManager.js";
import {
  deserializeRoom,
  recordCardRating,
  serializeRoom,
  SNAPSHOT_VERSION,
} from "../persistence.js";
import { CLEANUP } from "../config/gameConfig.js";
import { resumeRecoveredRoom } from "../socketHandlers/roundLogic.js";

void test("serializes durable room state and strips all live transport state", () => {
  const room = createRoom("SAVE", "owner", "socket-secret", "Owner", 20);
  required(room.players[0]).disconnectTimeout = setTimeout(() => {
    /* Deliberately inert timer/transport fixture. */
  }, 1000);
  room.joinRequests.push({
    id: "pending",
    socketId: "request-socket",
    displayName: "Pending",
    requestedAt: Date.now(),
    timeout: setTimeout(() => {
      /* Deliberately inert timer/transport fixture. */
    }, 1000),
  });
  room.timer = setTimeout(() => {
    /* Deliberately inert timer/transport fixture. */
  }, 1000);
  room.timerDescriptor = { kind: "guess", endsAt: Date.now() + 5000 };
  room.selectedPackIds = ["core", "daily-life"];
  room.gameMode = "teams";
  required(room.players[0]).teamId = "team-1";
  required(room.teams[0]).score = 7;
  room.roundReadyPlayerIds = ["owner"];
  room.roundAdvanceEndsAt = Date.now() + 3000;
  room.roundAdvancePausedRemainingMs = 2400;
  room.rematchVoteIds = ["owner"];
  room.matchStartedAt = Date.now() - 20_000;
  room.roundStartedAt = Date.now() - 5_000;
  const snapshot = serializeRoom(room);

  assert.equal(snapshot.snapshotVersion, SNAPSHOT_VERSION);
  assert.equal(Reflect.get(required(snapshot.players[0]), "socketId"), undefined);
  assert.equal(Reflect.get(required(snapshot.players[0]), "disconnectTimeout"), undefined);
  assert.equal(Reflect.get(snapshot, "joinRequests"), undefined);
  assert.equal(Reflect.get(snapshot, "timer"), undefined);
  assert.deepEqual(snapshot.selectedPackIds, ["core", "daily-life"]);
  assert.equal(snapshot.gameMode, "teams");
  assert.equal(required(snapshot.players[0]).teamId, "team-1");
  assert.equal(required(snapshot.teams[0]).score, 7);
  assert.deepEqual(snapshot.roundReadyPlayerIds, ["owner"]);
  assert.equal(snapshot.roundAdvancePausedRemainingMs, 2400);
  assert.deepEqual(snapshot.rematchVoteIds, ["owner"]);
  assert.equal(snapshot.matchStartedAt, room.matchStartedAt);
  assert.equal(snapshot.roundStartedAt, room.roundStartedAt);
  assert.equal(JSON.stringify(snapshot).includes("socket-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("request-socket"), false);

  const restored = deserializeRoom(snapshot);
  assert.ok(restored);
  assert.equal(required(restored.players[0]).isConnected, false);
  assert.equal(required(restored.players[0]).socketId, null);
  assert.deepEqual(restored.joinRequests, []);
  assert.equal(restored.recoveryPending, false);
  assert.equal(restored.gameMode, "teams");
  assert.equal(restored.roundAdvanceEndsAt, room.roundAdvanceEndsAt);
  assert.equal(restored.roundAdvancePausedRemainingMs, 2400);
  assert.equal(restored.matchStartedAt, room.matchStartedAt);
  assert.equal(restored.roundStartedAt, room.roundStartedAt);
  deleteRoom(room.code);
});

void test("defaults older room snapshots to an unpaused reveal countdown", () => {
  const room = createRoom("OLDPAUSE", "owner", null, "Owner", 20);
  const snapshot = serializeRoom(room);
  Reflect.deleteProperty(snapshot, "roundAdvancePausedRemainingMs");

  const restored = deserializeRoom(snapshot);
  assert.ok(restored);
  assert.equal(restored.roundAdvancePausedRemainingMs, null);
  deleteRoom(room.code);
});

void test("normalizes removed pack selections when restoring a room", () => {
  const room = createRoom("PACK", "owner", null, "Owner", 20);
  room.selectedPackIds = ["core", "friends"];
  const partlyLegacy = deserializeRoom(serializeRoom(room));
  assert.ok(partlyLegacy);
  assert.deepEqual(partlyLegacy.selectedPackIds, ["core"]);

  room.selectedPackIds = ["friends"];
  const friendsOnly = deserializeRoom(serializeRoom(room));
  assert.ok(friendsOnly);
  assert.deepEqual(friendsOnly.selectedPackIds, ["core", "daily-life", "entertainment"]);
  deleteRoom(room.code);
});

void test("resets a restored round that references a removed card", () => {
  const room = createRoom("OLDCARD", "owner", null, "Owner", 20);
  room.status = "playing";
  room.selectedPackIds = ["friends"];
  required(room.players[0]).hasSubmitted = true;
  room.currentRound.roundNumber = 2;
  room.currentRound.psychicId = "owner";
  room.currentRound.card = { id: "friends-1", packId: "friends", left: "left", right: "right" };
  room.currentRound.targetAngle = 90;
  room.currentRound.clue = "legacy clue";
  room.currentRound.status = "guessing";
  room.currentRound.guesses = [{ playerId: "owner", angle: 90, points: 3 }];
  room.timerDescriptor = { kind: "guess", endsAt: Date.now() + 5_000 };

  const restored = deserializeRoom(serializeRoom(room));
  assert.ok(restored);
  assert.equal(restored.status, "waiting");
  assert.equal(restored.recoveryPending, false);
  assert.equal(restored.timerDescriptor, null);
  assert.equal(restored.timerEndsAt, null);
  assert.equal(required(restored.players[0]).hasSubmitted, false);
  assert.equal(restored.currentRound.card, null);
  assert.equal(restored.currentRound.psychicId, null);
  assert.equal(restored.currentRound.targetAngle, null);
  assert.equal(restored.currentRound.clue, null);
  assert.equal(restored.currentRound.status, "waiting");
  assert.deepEqual(restored.currentRound.guesses, []);
  deleteRoom(room.code);
});

void test("rejects expired and unknown snapshot versions", () => {
  const base = {
    snapshotVersion: SNAPSHOT_VERSION,
    code: "OLD1",
    lastActivity: Date.now() - CLEANUP.IDLE_TTL - 1,
  };
  assert.equal(deserializeRoom(base), null);
  assert.equal(deserializeRoom({ ...base, snapshotVersion: 999, lastActivity: Date.now() }), null);
});

void test("keeps regional card rating aggregates separate while preserving the overall total", async () => {
  const cardId = `rating-test-${Date.now()}`;
  const innerLeft = await recordCardRating(cardId, true, "inner-left");
  const farRight = await recordCardRating(cardId, false, "far-right");
  const innerLeftAgain = await recordCardRating(cardId, false, "inner-left");

  assert.deepEqual(innerLeft, { positive: 1, negative: 0, overallPositive: 1, overallNegative: 0 });
  assert.deepEqual(farRight, { positive: 0, negative: 1, overallPositive: 1, overallNegative: 1 });
  assert.deepEqual(innerLeftAgain, {
    positive: 1,
    negative: 1,
    overallPositive: 1,
    overallNegative: 2,
  });
});

void test("cancels a restored round when its psychic misses the reconnect grace", async () => {
  const room = createRoom("BACK", "owner", null, "Owner", 20);
  required(room.players[0]).isConnected = false;
  addPlayer(room, "a", "socket-a", "A");
  addPlayer(room, "b", "socket-b", "B");
  room.status = "playing";
  room.recoveryPending = true;
  room.currentRound.roundNumber = 1;
  room.currentRound.psychicId = "owner";
  room.currentRound.psychicOrder = ["owner", "a", "b"];
  room.currentRound.psychicIndex = 1;
  room.currentRound.status = "waiting";
  room.timerDescriptor = { kind: "psychic", endsAt: Date.now() - 1000 };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const io = {
    sockets: { sockets: new Map() },
    to: () => ({
      emit: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    }),
  };

  assert.equal(resumeRecoveredRoom(io as unknown as GameIO, room), false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(room.currentRound.roundNumber, 2);
  assert.notEqual(room.currentRound.psychicId, "owner");
  assert.equal(room.ownerId, "a");
  assert.ok(events.some((event) => event.event === "ownership_transferred"));
  deleteRoom(room.code);
});

void test("keeps a restored reveal paused when its owner has reconnected", () => {
  const room = createRoom("PAUSEBACK", "owner", "socket-owner", "Owner", 20);
  addPlayer(room, "guest", "socket-guest", "Guest");
  room.status = "playing";
  room.recoveryPending = true;
  room.currentRound.roundNumber = 2;
  room.currentRound.status = "revealed";
  room.roundAdvancePausedRemainingMs = 2400;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const io = {
    sockets: { sockets: new Map() },
    to: () => ({
      emit: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    }),
  };

  assert.equal(resumeRecoveredRoom(io as unknown as GameIO, room), true);
  assert.equal(room.roundAdvancePausedRemainingMs, 2400);
  assert.equal(room.roundAdvanceEndsAt, null);
  assert.equal(room.timer, null);
  assert.ok(events.some((event) => event.event === "round_ready_updated" && event.data.paused));
  deleteRoom(room.code);
});

void test("resumes a restored paused reveal when its owner is absent", () => {
  const room = createRoom("AUTOBACK", "owner", null, "Owner", 20);
  required(room.players[0]).isConnected = false;
  addPlayer(room, "a", "socket-a", "A");
  addPlayer(room, "b", "socket-b", "B");
  room.status = "playing";
  room.recoveryPending = true;
  room.currentRound.roundNumber = 2;
  room.currentRound.status = "revealed";
  room.roundAdvancePausedRemainingMs = 2400;
  const io = {
    sockets: { sockets: new Map() },
    to: () => ({
      emit: () => {
        /* Deliberately inert timer/transport fixture. */
      },
    }),
  };

  assert.equal(resumeRecoveredRoom(io as unknown as GameIO, room), true);
  assert.equal(room.roundAdvancePausedRemainingMs, null);
  assert.ok(required(room.roundAdvanceEndsAt) > Date.now());
  deleteRoom(room.code);
});

void test("version-one reveal snapshots default newer team and pause fields", () => {
  const room = createRoom("VONE", "owner", "socket", "Owner", 20);
  room.status = "playing";
  room.currentRound.status = "revealed";
  room.currentRound.revealData = {
    targetAngle: 90,
    guesses: [],
    psychicPoints: 0,
    psychicBreakdown: null,
    updatedScores: [],
    updatedTeams: [],
    gameMode: "individual",
    activeTeamId: null,
    shouldPromptRating: false,
    winner: null,
    winners: [],
  };
  const snapshot = serializeRoom(room);
  snapshot.snapshotVersion = 1;
  const reveal = required(snapshot.currentRound.revealData);
  for (const key of ["gameMode", "updatedTeams", "activeTeamId", "shouldPromptRating"])
    Reflect.deleteProperty(reveal, key);
  for (const key of ["gameMode", "teams", "teamCount", "roundAdvancePausedRemainingMs"])
    Reflect.deleteProperty(snapshot, key);
  const restored = deserializeRoom(snapshot);
  assert.ok(restored);
  assert.equal(restored.gameMode, "individual");
  assert.equal(restored.roundAdvancePausedRemainingMs, null);
  assert.equal(required(restored.currentRound.revealData).gameMode, "individual");
  assert.deepEqual(required(restored.currentRound.revealData).updatedTeams, []);
  deleteRoom(room.code);
});
