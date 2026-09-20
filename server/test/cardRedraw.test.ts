import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createClient, once, onceWhere, required, roomForTest, type Client } from "./helpers.js";
import { createGameServer } from "../index.js";
import { addPlayer, createRoom, deleteRoom, getAllRooms } from "../roomManager.js";
import { advanceSkippedTurn } from "../socketHandlers/roundLogic.js";
import { finishMatch } from "../socketHandlers/matchLifecycle.js";
import {
  emitPlayers,
  roomCardRedrawStatus,
  roomSupportsCardRedraw,
} from "../services/capabilities.js";
import type { GameIO } from "../types.js";

async function fixture({ capable = true, psychicTimer = false } = {}) {
  const gameServer = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", resolve));
  const { port } = gameServer.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const connect = async (withCapability = true) => {
    const client = createClient(url, {
      transports: ["websocket"],
      forceNew: true,
      ...(withCapability ? { auth: { cardRedrawV1: true } } : {}),
    });
    clients.push(client);
    await once(client, "connect");
    return client;
  };

  const owner = await connect(capable);
  const created = once(owner, "room_created");
  owner.emit("create_room", { displayName: "Owner", winningScore: 20 });
  const { roomCode } = await created;
  const guest = await connect(capable);
  const joined = once(guest, "join_success");
  guest.emit("join_room", { roomCode, displayName: "Guest" });
  await joined;

  if (psychicTimer) {
    const updated = once(owner, "settings_updated");
    owner.emit("toggle_psychic_timer", { roomCode });
    await updated;
  }

  return {
    owner,
    guest,
    io: gameServer.io,
    roomCode,
    room: () => roomForTest(roomCode),
    connect,
    close: async () => {
      for (const client of clients) client.close();
      for (const [code] of getAllRooms()) deleteRoom(code);
      await gameServer.io.close();
    },
  };
}

function psychicOf(fx: Awaited<ReturnType<typeof fixture>>) {
  const room = fx.room();
  const socketId = required(
    room.players.find((player) => player.id === room.currentRound.psychicId),
  ).socketId;
  return socketId === required(fx.owner.id) ? fx.owner : fx.guest;
}

void test("one replacement keeps the turn, marks both cards and blocks a second try", async () => {
  const fx = await fixture({ psychicTimer: true });
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    await round;
    const before = fx.room();
    const psychic = psychicOf(fx);
    const previousCardId = required(before.currentRound.card).id;
    const target = before.currentRound.targetAngle;
    const deadline = before.timerEndsAt;
    const scores = before.players.map((player) => player.score);
    assert.equal(typeof deadline, "number");

    const redrawn = once(psychic, "card_redrawn");
    psychic.emit("redraw_card", {
      roomCode: fx.roomCode,
      roundNumber: before.currentRound.roundNumber,
      cardId: previousCardId,
    });
    const payload = required(await redrawn);
    assert.equal(payload.previousCardId, previousCardId);
    assert.equal(payload.redrawUsed, true);
    assert.notEqual(payload.card.id, previousCardId);

    const after = fx.room();
    assert.equal(after.currentRound.targetAngle, target, "the hidden target is unchanged");
    assert.equal(after.currentRound.psychicId, before.currentRound.psychicId);
    assert.equal(after.currentRound.controllerId, before.currentRound.controllerId);
    assert.equal(after.currentRound.redrawUsed, true);
    assert.equal(after.timerEndsAt, deadline, "the timer deadline is unchanged");
    assert.deepEqual(
      after.players.map((player) => player.score),
      scores,
      "replacement costs no points",
    );
    assert.ok(
      after.currentRound.usedCardIds.includes(previousCardId),
      "the discarded card stays used for future draws",
    );
    assert.ok(after.currentRound.usedCardIds.includes(payload.card.id));

    const second = once(psychic, "action_error");
    psychic.emit("redraw_card", {
      roomCode: fx.roomCode,
      roundNumber: after.currentRound.roundNumber,
      cardId: required(after.currentRound.card).id,
    });
    assert.deepEqual(required(await second), {
      event: "redraw_card",
      code: "REDRAW_USED",
    });
  } finally {
    await fx.close();
  }
});

void test("replacement is only offered while every live client understands it", async () => {
  const fx = await fixture({ capable: true });
  try {
    const legacy = await fx.connect(false);
    const legacyJoin = once(legacy, "join_success");
    legacy.emit("join_room", { roomCode: fx.roomCode, displayName: "Legacy" });
    await legacyJoin;

    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    const started = required(await round);
    assert.equal(started.redrawAvailable, false, "an older client in the room blocks it");

    const psychic = psychicOf(fx);
    const rejected = once(psychic, "action_error");
    psychic.emit("redraw_card", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      cardId: required(fx.room().currentRound.card).id,
    });
    assert.deepEqual(required(await rejected), {
      event: "redraw_card",
      code: "REDRAW_UNAVAILABLE",
    });
  } finally {
    await fx.close();
  }
});

void test("an accepted clue closes replacement and stale card context is rejected", async () => {
  const fx = await fixture();
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    await round;
    const psychic = psychicOf(fx);
    const previousCardId = required(fx.room().currentRound.card).id;

    const redrawn = once(psychic, "card_redrawn");
    psychic.emit("redraw_card", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      cardId: previousCardId,
    });
    await redrawn;
    const currentCardId = required(fx.room().currentRound.card).id;

    // A client that still refers to the discarded card cannot take a card-sensitive action.
    const stale = once(psychic, "action_error");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      clue: "تلميح قديم",
      cardId: previousCardId,
    });
    assert.deepEqual(required(await stale), { event: "clue_submitted", code: "STALE_CARD" });

    // A client too old to send card context at all is told to update.
    const updateRequired = once(psychic, "action_error");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      clue: "تلميح بلا سياق",
    });
    assert.deepEqual(required(await updateRequired), {
      event: "clue_submitted",
      code: "UPDATE_REQUIRED",
    });

    const accepted = once(fx.guest, "clue_broadcast");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      clue: "تلميح جديد",
      cardId: currentCardId,
    });
    await accepted;

    const late = once(psychic, "action_error");
    psychic.emit("redraw_card", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      cardId: currentCardId,
    });
    assert.deepEqual(required(await late), { event: "redraw_card", code: "CLUE_ACCEPTED" });
  } finally {
    await fx.close();
  }
});

void test("an absent active seat blocks replacement until it reconnects or leaves", async () => {
  const fx = await fixture();
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    const started = required(await round);
    assert.equal(started.redrawAvailable, true);

    const psychic = psychicOf(fx);
    const absent = psychic === fx.owner ? fx.guest : fx.owner;
    const rosterUpdate = onceWhere(psychic, "player_joined", (data) => !data.redrawAvailable);
    absent.close();
    await rosterUpdate;

    const rejected = once(psychic, "action_error");
    psychic.emit("redraw_card", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      cardId: required(fx.room().currentRound.card).id,
    });
    assert.deepEqual(required(await rejected), {
      event: "redraw_card",
      code: "REDRAW_UNAVAILABLE",
    });
  } finally {
    await fx.close();
  }
});

void test("a capable client must send card context with card-sensitive actions", async () => {
  const fx = await fixture();
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    await round;
    const psychic = psychicOf(fx);

    const rejected = once(psychic, "action_error");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      clue: "تلميح بلا سياق",
    });
    assert.deepEqual(required(await rejected), {
      event: "clue_submitted",
      code: "CARD_CONTEXT_REQUIRED",
    });

    const accepted = once(fx.guest, "clue_broadcast");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      roundNumber: fx.room().currentRound.roundNumber,
      clue: "تلميح بسياق",
      cardId: required(fx.room().currentRound.card).id,
    });
    await accepted;
  } finally {
    await fx.close();
  }
});

void test("a legacy spectator joining or leaving updates replacement availability", async () => {
  const fx = await fixture();
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    const started = required(await round);
    assert.equal(started.redrawAvailable, true);
    assert.equal(started.redrawReason, null, "an available change names no blocker");

    const unavailable = onceWhere(fx.owner, "player_joined", (data) => !data.redrawAvailable);
    const legacySpectator = await fx.connect(false);
    const watched = once(legacySpectator, "watch_success");
    legacySpectator.emit("watch_room", { roomCode: fx.roomCode });
    await watched;
    // The client is told which participant blocks the change, so the psychic can read one
    // accurate explanation instead of a generic warning.
    assert.equal(required(await unavailable).redrawReason, "incompatible");
    assert.ok(!roomSupportsCardRedraw(fx.io, fx.room()));

    const restored = onceWhere(fx.owner, "player_joined", (data) => data.redrawAvailable);
    legacySpectator.close();
    assert.equal(required(await restored).redrawReason, null);
    assert.ok(roomSupportsCardRedraw(fx.io, fx.room()));
  } finally {
    await fx.close();
  }
});

void test("a seat inside the reconnect grace is named as the blocker, not an old client", async () => {
  const fx = await fixture();
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    await round;
    assert.equal(roomCardRedrawStatus(fx.io, fx.room()).available, true);

    const blocked = onceWhere(fx.owner, "player_joined", (data) => !data.redrawAvailable);
    for (const player of fx.room().players) {
      if (player.id === fx.room().ownerId) continue;
      player.isConnected = false;
    }
    emitPlayers(fx.io, fx.room());
    const status = required(await blocked);
    assert.equal(status.redrawReason, "disconnected");
    assert.deepEqual(roomCardRedrawStatus(fx.io, fx.room()), {
      available: false,
      reason: "disconnected",
    });
  } finally {
    await fx.close();
  }
});

void test("a rematch keeps the card history so the next match opens with unseen cards", async () => {
  const fx = await fixture();
  try {
    const round = once(fx.owner, "round_start");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    await round;
    const drawn = fx.room().currentRound.usedCardIds.length;
    assert.equal(drawn, 1, "the first round drew one card");

    finishMatch(fx.io, fx.room(), {
      winner: null,
      winners: [],
      gameMode: "individual",
      updatedTeams: [],
      leaderboard: [],
      awards: [],
      reason: "test_abandon",
    });
    assert.equal(fx.room().status, "finished");
    const rematch = once(fx.owner, "rematch_started");
    fx.owner.emit("rematch", { roomCode: fx.roomCode });
    await rematch;

    assert.equal(fx.room().status, "waiting");
    assert.equal(
      fx.room().currentRound.usedCardIds.length,
      drawn,
      "the already-seen card stays out of the fresh match",
    );
  } finally {
    await fx.close();
  }
});

// A stub IO is enough for the shared advance path: it only needs broadcasts and socket
// lookups, and an empty socket map skips the join calls that a real server would make.
function stubIo() {
  const emitted: { event: string; data: unknown }[] = [];
  const io = {
    to: () => ({
      emit: (event: string, data: unknown) => {
        emitted.push({ event, data });
      },
    }),
    sockets: { sockets: new Map() },
  } as unknown as GameIO;
  return { io, emitted };
}

void test("skip and timeout deduct once and advance once in both modes", () => {
  for (const source of ["skip", "timeout"] as const) {
    const room = createRoom("SKIP", "owner", "owner-socket", "Owner", 20);
    try {
      room.status = "playing";
      required(room.players[0]).score = 5;
      addPlayer(room, "mate", "mate-socket", "Mate");
      const { io, emitted } = stubIo();
      room.currentRound.roundNumber = 1;
      room.currentRound.psychicId = "owner";
      room.currentRound.status = "waiting";
      room.currentRound.card = { id: "core-1", packId: "core", left: "أ", right: "ب" };
      room.currentRound.targetAngle = 90;
      // Deterministic rotation: the next turn belongs to the other player.
      room.currentRound.psychicOrder = ["owner", "mate"];
      room.currentRound.psychicIndex = 1;

      assert.equal(advanceSkippedTurn(io, room, "owner", source), true);
      assert.equal(required(room.players[0]).score, 4, `${source} deducts one point`);
      const skipped = emitted.filter((entry) => entry.event === "round_skipped");
      assert.equal(skipped.length, 1, `${source} announces the skip once`);
      const payload = required(skipped[0]).data;
      assert.equal(
        payload && typeof payload === "object" ? Reflect.get(payload, "source") : null,
        source,
      );
      assert.equal(room.currentRound.roundNumber, 2, `${source} advances the turn once`);

      // A duplicate request (double click, or a skip racing the timer) changes nothing.
      assert.equal(advanceSkippedTurn(io, room, "owner", source), false);
      assert.equal(required(room.players[0]).score, 4);
      assert.equal(emitted.filter((entry) => entry.event === "round_skipped").length, 1);
    } finally {
      deleteRoom("SKIP");
    }
  }
});

void test("a team skip charges the active team, not the psychic", () => {
  const room = createRoom("TSKP", "owner", "owner-socket", "Owner", 20);
  try {
    room.status = "playing";
    room.gameMode = "teams";
    required(room.players[0]).score = 5;
    addPlayer(room, "mate", "mate-socket", "Mate");
    required(room.teams[0]).score = 6;
    const { io, emitted } = stubIo();
    room.currentRound.roundNumber = 1;
    room.currentRound.psychicId = "owner";
    room.currentRound.activeTeamId = "team-1";
    room.currentRound.status = "waiting";
    room.currentRound.card = { id: "core-2", packId: "core", left: "أ", right: "ب" };
    room.currentRound.targetAngle = 90;

    assert.equal(advanceSkippedTurn(io, room, "owner", "skip"), true);
    assert.equal(required(room.teams[0]).score, 5, "the active team loses the point");
    assert.equal(required(room.players[0]).score, 5, "the psychic keeps their score");
    assert.equal(emitted.filter((entry) => entry.event === "round_skipped").length, 1);
  } finally {
    deleteRoom("TSKP");
  }
});
