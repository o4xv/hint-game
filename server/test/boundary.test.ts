import type { GameSocket } from "../types.js";
import { setupGameHandlers } from "../socketHandlers/gameHandlers.js";
import type { IncomingEvent } from "@hint/contracts";
import { incomingSchemas } from "@hint/contracts/schemas";
import { serializeRoom } from "../persistence.js";
import { present } from "../invariants.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createGameServer } from "../index.js";
import type { AddressInfo } from "node:net";
import { createClient, once } from "./helpers.js";
import { createRoom, deleteRoom, addPlayer } from "../roomManager.js";

void test("stale clue is rejected without changing the round", async (t) => {
  const game = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  const client = createClient(`http://127.0.0.1:${(game.server.address() as AddressInfo).port}`, {
    transports: ["websocket"],
  });
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const room = createRoom("TSTA", "owner", client.id ?? null, "Owner", 20);
  room.status = "playing";
  room.currentRound.roundNumber = 2;
  room.currentRound.psychicId = "owner";
  t.after(async () => {
    client.close();
    deleteRoom(room.code);
    await game.io.close();
  });
  client.emit("clue_submitted", { roomCode: room.code, roundNumber: 1, clue: "stale" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(room.currentRound.clue, null);
});

void test("unauthorized and wrong-phase clue actions do not touch room state", async (t) => {
  const game = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  const client = createClient(`http://127.0.0.1:${(game.server.address() as AddressInfo).port}`, {
    transports: ["websocket"],
  });
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const room = createRoom("AUTH", "owner", "another-socket", "Owner", 20);
  room.status = "playing";
  room.currentRound.psychicId = "owner";
  room.currentRound.roundNumber = 1;
  room.lastActivity = 1;
  t.after(async () => {
    client.close();
    deleteRoom(room.code);
    await game.io.close();
  });
  client.emit("clue_submitted", { roomCode: room.code, clue: "unauthorized" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(room.lastActivity, 1);
  present(room.players[0]).socketId = client.id ?? null;
  room.currentRound.status = "revealed";
  client.emit("clue_submitted", { roomCode: room.code, clue: "wrong phase" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(room.currentRound.clue, null);
  assert.equal(room.lastActivity, 1);
});

void test("health reports build revision and aggregate diagnostics without credentials", async (t) => {
  const game = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  const room = createRoom("DIAG", "owner", "private-socket", "Private name", 20);
  t.after(async () => {
    deleteRoom(room.code);
    await game.io.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${(game.server.address() as AddressInfo).port}/health`,
  );
  const health: unknown = await response.json();
  assert.ok(typeof health === "object" && health !== null && "revision" in health);
  assert.ok("diagnostics" in health);
  const serialized = JSON.stringify(health);
  for (const secret of [
    room.code,
    "private-socket",
    "Private name",
    present(room.players[0]).reconnectToken,
  ])
    assert.equal(serialized.includes(secret), false);
});

void test("a host switching rooms resumes the old paused reveal", async (t) => {
  const game = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  const client = createClient(`http://127.0.0.1:${(game.server.address() as AddressInfo).port}`, {
    transports: ["websocket"],
  });
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const old = createRoom("SWCH", "owner", client.id ?? null, "Owner", 20);
  addPlayer(old, "a", "a-socket", "A");
  addPlayer(old, "b", "b-socket", "B");
  const other = createRoom("OTHR", "other", "other-socket", "Other", 20);
  old.status = "playing";
  old.currentRound.status = "revealed";
  old.currentRound.roundNumber = 1;
  old.roundAdvancePausedRemainingMs = 2400;
  t.after(async () => {
    client.close();
    deleteRoom(old.code);
    deleteRoom(other.code);
    await game.io.close();
  });
  const joined = once(client, "join_success");
  client.emit("join_room", { roomCode: other.code, displayName: "Owner" });
  await joined;
  assert.equal(old.ownerId, "a");
  assert.equal(old.roundAdvancePausedRemainingMs, null);
  assert.ok((old.roundAdvanceEndsAt ?? 0) > Date.now());
});

void test("all protected actions reject outsiders without changing activity or room state", async (t) => {
  const game = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  const client = createClient(`http://127.0.0.1:${(game.server.address() as AddressInfo).port}`, {
    transports: ["websocket"],
  });
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const room = createRoom("PRIV", "owner", "another-socket", "Owner", 20);
  addPlayer(room, "guest", "guest-socket", "Guest");
  t.after(async () => {
    client.close();
    deleteRoom(room.code);
    await game.io.close();
  });
  const events: IncomingEvent[] = [
    "update_settings",
    "update_packs",
    "update_game_mode",
    "update_team_count",
    "assign_team",
    "toggle_psychic_timer",
    "set_room_lock",
    "approve_join_request",
    "reject_join_request",
    "transfer_ownership",
    "kick_player",
    "start_game",
    "clue_submitted",
    "skip_round",
    "guess_submitted",
    "guess_preview",
    "next_round",
    "round_ready",
    "set_round_pause",
    "card_rating",
    "send_reaction",
    "vote_rematch",
    "rematch",
    "cancel_join_request",
  ];
  const payload = {
    roomCode: room.code,
    winningScore: 10,
    selectedPackIds: ["core"],
    gameMode: "teams",
    teamCount: 3,
    playerId: "guest",
    teamId: "team-1",
    locked: true,
    requestId: "request",
    clue: "clue",
    angle: 90,
    roundNumber: 1,
    ready: true,
    paused: true,
    vote: true,
    reaction: "👍",
  };
  for (const status of ["waiting", "playing", "finished"] as const)
    for (const phase of ["waiting", "guessing", "revealed"] as const) {
      room.status = status;
      room.currentRound.status = phase;
      room.currentRound.roundNumber = 1;
      room.currentRound.psychicId = "owner";
      room.currentRound.targetAngle = 90;
      room.currentRound.card = { id: "core-1", packId: "core", left: "Left", right: "Right" };
      room.lastActivity = 1;
      const before = serializeRoom(room);
      for (const event of events)
        client.emit(event, { ...payload, ...(event === "card_rating" ? { vote: "up" } : {}) });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(
        { ...serializeRoom(room), savedAt: 0 },
        { ...before, savedAt: 0 },
        `${status}/${phase}`,
      );
    }
});

void test("malformed payloads for all registered actions leave a live socket connected", async (t) => {
  const game = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  const client = createClient(`http://127.0.0.1:${(game.server.address() as AddressInfo).port}`, {
    transports: ["websocket"],
  });
  await new Promise<void>((resolve) => client.once("connect", resolve));
  t.after(async () => {
    client.close();
    await game.io.close();
  });
  for (const event of Object.keys(incomingSchemas) as IncomingEvent[]) {
    const rejected = once(client, "action_error");
    client.emit(event, null);
    assert.deepEqual(await rejected, { event, code: "INVALID_PAYLOAD" });
  }
  assert.equal(client.connected, true);
});

void test("an in-flight rating keeps its card context when the next match resets the round", async (t) => {
  const game = createGameServer({ startCleanup: false });
  const listeners = new Map<string, (payload: unknown) => void>();
  const errors: unknown[] = [];
  const socket = {
    id: "rating-socket",
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
    },
    emit: () => true,
  } as unknown as GameSocket;
  const room = createRoom("RATE", "owner", "rating-socket", "Owner", 20);
  room.status = "playing";
  room.currentRound.status = "revealed";
  room.currentRound.card = { id: "core-1", packId: "core", left: "Left", right: "Right" };
  t.after(async () => {
    deleteRoom(room.code);
    await game.io.close();
  });
  t.mock.method(console, "error", (...values: unknown[]) => {
    errors.push(values);
  });
  setupGameHandlers(game.io, socket);
  present(listeners.get("card_rating"))({ roomCode: room.code, vote: "up" });
  room.currentRound.card = null;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
});
