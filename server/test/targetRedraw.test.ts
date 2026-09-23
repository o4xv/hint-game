import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { TARGET_REDRAWS_PER_MATCH } from "@hint/contracts";
import { createClient, once, onceWhere, required, roomForTest, type Client } from "./helpers.js";
import { createGameServer } from "../index.js";
import { addPlayer, createRoom, deleteRoom, getAllRooms, resetRoundState } from "../roomManager.js";
import {
  advanceExpiredPsychicTurn,
  redrawCurrentCard,
  redrawTarget,
} from "../socketHandlers/roundLogic.js";
import { deserializeRoom, serializeRoom } from "../persistence.js";
import { targetRedrawState } from "../services/targetRedraw.js";
import type { GameIO, Room } from "../types.js";

/** The shared advance path only needs broadcasts, so a stub is enough for room-level cases. */
function stubIo(): GameIO {
  return {
    to: () => ({
      emit: () => {
        /* Nothing to broadcast in a room-level check. */
      },
    }),
    sockets: { sockets: new Map() },
  } as unknown as GameIO;
}

let roomCounter = 0;

/**
 * A live room with two players, a current card and a current target, ready for a clue. The
 * sockets are never connected: these cases exercise the authoritative mutation directly.
 */
function playingRoom({
  gameMode = "individual",
  playerIds = ["owner", "mate"],
}: { gameMode?: Room["gameMode"]; playerIds?: string[] } = {}): Room {
  roomCounter += 1;
  const code = `TR${roomCounter}`;
  const room = createRoom(
    code,
    required(playerIds[0]),
    `${required(playerIds[0])}-socket`,
    "Owner",
    20,
  );
  for (const id of playerIds.slice(1)) addPlayer(room, id, `${id}-socket`, id);
  room.status = "playing";
  room.gameMode = gameMode;
  room.currentRound.roundNumber = 1;
  room.currentRound.status = "waiting";
  room.currentRound.psychicId = required(playerIds[0]);
  room.currentRound.card = { id: "core-1", packId: "core", left: "Cold", right: "Hot" };
  room.currentRound.targetAngle = 90;
  return room;
}

function request(overrides: Partial<Parameters<typeof redrawTarget>[1]> = {}) {
  return {
    playerId: "owner",
    roundNumber: 1,
    cardId: "core-1",
    targetRevision: 0,
    requestId: "request-1",
    supported: true,
    random: () => 0,
    ...overrides,
  };
}

function snapshot(room: Room) {
  return { ...serializeRoom(room), savedAt: 0 };
}

void test("a position change moves the target and leaves the turn untouched", () => {
  const room = playingRoom();
  try {
    room.currentRound.redrawUsed = true;
    required(room.players[0]).score = 3;
    required(room.players[1]).score = 4;
    room.timerEndsAt = Date.now() + 30_000;
    room.timerDescriptor = { kind: "psychic", endsAt: room.timerEndsAt };
    const deadline = room.timerEndsAt;

    const result = redrawTarget(room, request({ random: () => 0 }));
    assert.equal(result.ok, true);

    assert.equal(result.payload.previousTargetRevision, 0);
    assert.equal(result.payload.targetAngle, 6, "the leftmost eligible position for a 90 target");
    assert.ok(Math.abs(result.payload.targetAngle - 90) >= 45);
    assert.equal(result.payload.roundNumber, 1);
    assert.equal(result.payload.cardId, "core-1");
    assert.equal(result.payload.requestId, "request-1");
    assert.deepEqual(result.payload.targetRedraw, {
      supported: true,
      remaining: 2,
      usedThisRound: true,
      revision: 1,
    });

    assert.equal(room.currentRound.targetAngle, 6);
    assert.equal(room.currentRound.targetRevision, 1);
    assert.equal(room.currentRound.redrawUsed, true, "the card flag is independent");
    assert.equal(room.currentRound.psychicId, "owner");
    assert.equal(room.currentRound.card?.id, "core-1", "a position change keeps the card");
    assert.equal(room.currentRound.roundNumber, 1);
    assert.equal(room.timerEndsAt, deadline, "the timer is neither restarted nor paused");
    assert.deepEqual(
      room.players.map((player) => player.score),
      [3, 4],
      "a position change costs no points",
    );
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: 1 });
    assert.deepEqual(room.targetRedrawsUsedByTeam, {});

    // A duplicate click cannot spend a second use: the revision is the once-per-turn flag.
    const duplicate = redrawTarget(room, request({ requestId: "request-2" }));
    assert.deepEqual(duplicate, { ok: false, code: "STALE_TARGET" });
    const repeated = redrawTarget(room, request({ requestId: "request-3", targetRevision: 1 }));
    assert.deepEqual(repeated, { ok: false, code: "TARGET_REDRAW_USED" });
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: 1 });
  } finally {
    deleteRoom(room.code);
  }
});

void test("wrong round, card, revision, phase and capability are rejected without mutation", () => {
  const room = playingRoom();
  try {
    room.currentRound.targetRevision = 1;
    const before = snapshot(room);
    const cases: { payload: Partial<Parameters<typeof redrawTarget>[1]>; code: string }[] = [
      { payload: { targetRevision: 0 }, code: "STALE_TARGET" },
      { payload: { cardId: "core-9" }, code: "STALE_CARD" },
      { payload: { roundNumber: 2 }, code: "STALE_ROUND" },
      { payload: { supported: false }, code: "TARGET_REDRAW_UNSUPPORTED" },
      { payload: { playerId: "mate" }, code: "NOT_PSYCHIC" },
      { payload: { playerId: null }, code: "NOT_PSYCHIC" },
    ];
    for (const entry of cases) {
      assert.deepEqual(
        redrawTarget(room, request({ targetRevision: 1, ...entry.payload })),
        { ok: false, code: entry.code },
        entry.code,
      );
      assert.deepEqual(snapshot(room), before, `${entry.code} changes nothing`);
    }

    room.currentRound.status = "guessing";
    assert.deepEqual(redrawTarget(room, request({ targetRevision: 1 })), {
      ok: false,
      code: "CLUE_ACCEPTED",
    });
    room.currentRound.status = "waiting";
    room.currentRound.clue = "late clue";
    assert.deepEqual(redrawTarget(room, request({ targetRevision: 1 })), {
      ok: false,
      code: "CLUE_ACCEPTED",
    });
    room.currentRound.clue = null;

    room.status = "waiting";
    assert.deepEqual(redrawTarget(room, request({ targetRevision: 1 })), {
      ok: false,
      code: "ROOM_NOT_PLAYING",
    });
    room.status = "playing";

    room.currentRound.targetRevision = 0;
    room.currentRound.targetAngle = null;
    assert.deepEqual(redrawTarget(room, request()), { ok: false, code: "NO_TARGET" });
    room.currentRound.targetRevision = 1;
    room.currentRound.targetAngle = 90;
    assert.deepEqual(snapshot(room).targetRedrawsUsedByPlayer, {}, "no case spent an allowance");
  } finally {
    deleteRoom(room.code);
  }
});

void test("an elapsed clue deadline rejects the change and leaves the turn to the timeout", () => {
  const room = playingRoom();
  try {
    room.psychicTimerEnabled = true;
    room.timerDescriptor = { kind: "psychic", endsAt: Date.now() - 1 };
    assert.deepEqual(redrawTarget(room, request()), { ok: false, code: "TURN_EXPIRED" });
    assert.deepEqual(room.targetRedrawsUsedByPlayer, {});
    assert.equal(room.currentRound.targetRevision, 0);

    // A paused turn has no descriptor, so it never reads as expired.
    room.timerDescriptor = null;
    assert.equal(redrawTarget(room, request()).ok, true);
  } finally {
    deleteRoom(room.code);
  }
});

void test("each individual player spends their own three per match while the turn limit resets", () => {
  const room = playingRoom({ playerIds: ["owner", "mate"] });
  try {
    const spend = (playerId: string, requestId: string) => {
      room.currentRound.targetRevision = 0;
      room.currentRound.psychicId = playerId;
      return redrawTarget(room, request({ playerId, requestId }));
    };
    assert.equal(spend("owner", "a1").ok, true);
    assert.equal(spend("owner", "a2").ok, true);
    assert.equal(spend("owner", "a3").ok, true);
    assert.equal(targetRedrawState(room).remaining, 0);
    assert.deepEqual(spend("owner", "a4"), { ok: false, code: "TARGET_REDRAW_EXHAUSTED" });

    // The other player still has a full budget of their own.
    assert.equal(
      targetRedrawState({ ...room, currentRound: { ...room.currentRound, psychicId: "mate" } })
        .remaining,
      TARGET_REDRAWS_PER_MATCH,
    );
    assert.equal(spend("mate", "b1").ok, true);
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: TARGET_REDRAWS_PER_MATCH, mate: 1 });
  } finally {
    deleteRoom(room.code);
  }
});

void test("a team shares one budget that survives a new teammate and never touches other teams", () => {
  const room = playingRoom({ playerIds: ["owner", "mate"], gameMode: "teams" });
  try {
    const teamId = required(room.teams[0]).id;
    const otherTeamId = required(room.teams[1]).id;
    room.currentRound.activeTeamId = teamId;
    room.currentRound.controllerId = "mate";

    const spend = (playerId: string, requestId: string) => {
      room.currentRound.targetRevision = 0;
      room.currentRound.psychicId = playerId;
      return redrawTarget(room, request({ playerId, requestId }));
    };

    // Two different clue givers of the same team share the allowance.
    assert.equal(spend("owner", "t1").ok, true);
    assert.equal(spend("mate", "t2").ok, true);
    assert.deepEqual(room.targetRedrawsUsedByTeam, { [teamId]: 2 });
    assert.deepEqual(room.targetRedrawsUsedByPlayer, {}, "team mode charges the team only");

    // A player joining that team cannot replenish it.
    addPlayer(room, "late", "late-socket", "Late");
    required(room.players.find((player) => player.id === "late")).teamId = teamId;
    assert.equal(targetRedrawState(room).remaining, 1);

    assert.equal(spend("owner", "t3").ok, true);
    assert.deepEqual(spend("mate", "t4"), { ok: false, code: "TARGET_REDRAW_EXHAUSTED" });

    // The other team's allowance is untouched.
    room.currentRound.activeTeamId = otherTeamId;
    room.currentRound.controllerId = "owner";
    assert.equal(spend("owner", "o1").ok, true);
    assert.deepEqual(room.targetRedrawsUsedByTeam, { [teamId]: 3, [otherTeamId]: 1 });
  } finally {
    deleteRoom(room.code);
  }
});

void test("a new round resets only the per-turn limit and never the match budget", () => {
  const room = playingRoom();
  try {
    assert.equal(redrawTarget(room, request()).ok, true);
    assert.equal(room.currentRound.targetRevision, 1);
    resetRoundState(room);
    assert.equal(room.currentRound.targetRevision, 0, "the next turn may change position once");
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: 1 }, "the match budget is kept");
    assert.equal(redrawTarget(room, request({ requestId: "request-2" })).ok, true);
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: 2 });
  } finally {
    deleteRoom(room.code);
  }
});

void test("card and position changes are independent in either order", () => {
  const room = playingRoom({ playerIds: ["owner", "mate"] });
  try {
    // Card first, then position: the position change keeps the replacement flag and the card.
    const io = stubIo();
    assert.equal(
      redrawCurrentCard(io, room, { playerId: "owner", redrawAvailable: true }).ok,
      true,
    );
    const cardAfterRedraw = room.currentRound.card?.id;
    assert.equal(room.currentRound.redrawUsed, true);
    assert.equal(redrawTarget(room, request({ cardId: required(cardAfterRedraw) })).ok, true);
    assert.equal(room.currentRound.redrawUsed, true, "the card flag is preserved");
    assert.equal(room.currentRound.card?.id, cardAfterRedraw, "the card is preserved");
    assert.equal(room.currentRound.targetRevision, 1);

    // Position first, then card: the change does not consume the free card replacement.
    const second = playingRoom();
    try {
      assert.equal(redrawTarget(second, request()).ok, true);
      assert.equal(second.currentRound.redrawUsed, false);
      assert.equal(
        redrawCurrentCard(io, second, { playerId: "owner", redrawAvailable: true }).ok,
        true,
      );
      assert.equal(second.currentRound.targetRevision, 1, "the revision survives the card change");
      assert.equal(second.currentRound.targetAngle, 6, "the card change keeps the position");
      assert.deepEqual(second.targetRedrawsUsedByPlayer, { owner: 1 });
    } finally {
      deleteRoom(second.code);
    }
  } finally {
    deleteRoom(room.code);
  }
});

void test("the timeout and a position change cannot double-charge or double-advance", () => {
  const room = playingRoom({ playerIds: ["owner", "mate"] });
  try {
    required(room.players[0]).score = 5;
    room.currentRound.psychicOrder = ["owner", "mate"];
    room.currentRound.psychicIndex = 1;
    const io = stubIo();

    assert.equal(redrawTarget(room, request()).ok, true);
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: 1 });

    // The timer fires after the change: it still deducts once and advances once.
    assert.equal(advanceExpiredPsychicTurn(io, room, "owner"), true);
    assert.equal(required(room.players[0]).score, 4, "the timeout still costs one point");
    assert.equal(room.currentRound.roundNumber, 2);
    assert.deepEqual(room.targetRedrawsUsedByPlayer, { owner: 1 }, "no use is refunded");

    // A second callback for the finished turn does nothing at all.
    assert.equal(advanceExpiredPsychicTurn(io, room, "owner"), false);
    assert.equal(required(room.players[0]).score, 4);

    // A reply from the finished turn cannot animate or charge the new one.
    room.currentRound.psychicId = "owner";
    assert.deepEqual(redrawTarget(room, request({ roundNumber: 1, targetRevision: 1 })), {
      ok: false,
      code: "STALE_ROUND",
    });
  } finally {
    deleteRoom(room.code);
  }
});

void test("serialized rooms keep budgets and revision, and historical snapshots default them", () => {
  const room = playingRoom();
  try {
    assert.equal(redrawTarget(room, request()).ok, true);
    const restored = required(deserializeRoom(serializeRoom(room)));
    assert.deepEqual(restored.targetRedrawsUsedByPlayer, { owner: 1 });
    assert.deepEqual(restored.targetRedrawsUsedByTeam, {});
    assert.equal(restored.currentRound.targetRevision, 1);
    assert.equal(restored.currentRound.targetAngle, 6);

    const historical = serializeRoom(room) as Record<string, unknown>;
    delete historical.targetRedrawsUsedByPlayer;
    delete historical.targetRedrawsUsedByTeam;
    const round = historical.currentRound as Record<string, unknown>;
    delete round.targetRevision;
    const migrated = required(deserializeRoom(historical));
    assert.deepEqual(migrated.targetRedrawsUsedByPlayer, {});
    assert.deepEqual(migrated.targetRedrawsUsedByTeam, {});
    assert.equal(migrated.currentRound.targetRevision, 0);

    for (const malformed of [
      { owner: 4 },
      { owner: -1 },
      { owner: 1.5 },
      { owner: null },
      3,
      "many",
    ]) {
      const broken = serializeRoom(room) as Record<string, unknown>;
      broken.targetRedrawsUsedByPlayer = malformed;
      assert.equal(deserializeRoom(broken), null, JSON.stringify(malformed));
    }
    const fractionalRevision = serializeRoom(room) as Record<string, unknown>;
    (fractionalRevision.currentRound as Record<string, unknown>).targetRevision = 0.5;
    assert.equal(deserializeRoom(fractionalRevision), null);
  } finally {
    deleteRoom(room.code);
  }
});

async function socketFixture({ capability = true }: { capability?: boolean } = {}) {
  const gameServer = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", resolve));
  const { port } = gameServer.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const socketsByPlayerId = new Map<string, Client>();
  const connect = async (auth: Record<string, unknown>) => {
    const client = createClient(url, { transports: ["websocket"], forceNew: true, auth });
    clients.push(client);
    await once(client, "connect");
    return client;
  };
  const auth = capability ? { cardRedrawV1: true, targetRedrawV1: true } : { cardRedrawV1: true };
  const owner = await connect(auth);
  const created = once(owner, "room_created");
  owner.emit("create_room", { displayName: "Owner", winningScore: 20 });
  const { roomCode, playerId: ownerId } = await created;
  socketsByPlayerId.set(ownerId, owner);
  const guest = await connect(auth);
  const joined = once(guest, "join_success");
  guest.emit("join_room", { roomCode, displayName: "Guest" });
  socketsByPlayerId.set(required(await joined).playerId, guest);
  return {
    owner,
    guest,
    io: gameServer.io,
    roomCode,
    auth,
    room: () => roomForTest(roomCode),
    connect,
    addPlayer: async (displayName: string) => {
      const client = await connect(auth);
      const welcome = once(client, "join_success");
      client.emit("join_room", { roomCode, displayName });
      const playerId = required(await welcome).playerId;
      socketsByPlayerId.set(playerId, client);
      return { socket: client, playerId };
    },
    socketFor: (playerId: string) => required(socketsByPlayerId.get(playerId)),
    close: async () => {
      clients.forEach((client) => client.close());
      for (const [code] of getAllRooms()) deleteRoom(code);
      await gameServer.io.close();
    },
  };
}

type SocketFixture = Awaited<ReturnType<typeof socketFixture>>;

async function startMatch(fx: SocketFixture) {
  const started = once(fx.owner, "round_start");
  fx.owner.emit("start_game", { roomCode: fx.roomCode });
  return started;
}

function socketFor(fx: SocketFixture, playerId: string) {
  return fx.socketFor(playerId);
}

void test("only the clue giver is told the new position", async () => {
  const fx = await socketFixture();
  try {
    const round = await startMatch(fx);
    assert.equal(round.targetRedraw?.supported, true, "round_start carries the allowance");
    const psychic = socketFor(fx, round.psychicId);
    const other = psychic === fx.owner ? fx.guest : fx.owner;
    const seen: string[] = [];
    other.onAny((event: string) => seen.push(event));

    const success = once(psychic, "target_redrawn");
    psychic.emit("redraw_target", {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-1",
    });
    const payload = required(await success);
    assert.equal(payload.requestId, "request-1");
    assert.equal(payload.roundNumber, round.roundNumber);
    assert.equal(payload.cardId, round.card.id);
    assert.equal(payload.previousTargetRevision, 0);
    assert.ok(Number.isFinite(payload.targetAngle));
    assert.ok(Math.abs(payload.targetAngle - required(fx.room().currentRound.targetAngle)) < 1e-9);
    assert.deepEqual(payload.targetRedraw, {
      supported: true,
      remaining: 2,
      usedThisRound: true,
      revision: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(
      seen.filter((event) => event === "target_redrawn" || event === "card_redrawn"),
      [],
      "no participant broadcast carries the change",
    );
  } finally {
    await fx.close();
  }
});

void test("a guesser and a spectator cannot move the answer position", async () => {
  const fx = await socketFixture();
  try {
    const round = await startMatch(fx);
    const psychic = socketFor(fx, round.psychicId);
    const guesser = psychic === fx.owner ? fx.guest : fx.owner;
    const context = {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-1",
    };

    const guesserError = once(guesser, "action_error");
    guesser.emit("redraw_target", context);
    assert.deepEqual(required(await guesserError), {
      event: "redraw_target",
      code: "NOT_PSYCHIC",
      requestId: "request-1",
    });

    const spectator = await fx.connect(fx.auth);
    const watching = once(spectator, "watch_success");
    spectator.emit("watch_room", { roomCode: fx.roomCode });
    await watching;
    const spectatorError = once(spectator, "action_error");
    spectator.emit("redraw_target", context);
    assert.deepEqual(required(await spectatorError), {
      event: "redraw_target",
      code: "NOT_PSYCHIC",
      requestId: "request-1",
    });

    assert.equal(fx.room().currentRound.targetRevision, 0);
    assert.deepEqual(fx.room().targetRedrawsUsedByPlayer, {});
    assert.deepEqual(fx.room().targetRedrawsUsedByTeam, {});
  } finally {
    await fx.close();
  }
});

void test("a teammate who is not the clue giver cannot move the position", async () => {
  const fx = await socketFixture();
  try {
    // Teams mode needs two players per team before the match can start.
    await fx.addPlayer("Third");
    await fx.addPlayer("Fourth");
    const updated = onceWhere(fx.owner, "settings_updated", (data) => data.gameMode === "teams");
    fx.owner.emit("update_game_mode", { roomCode: fx.roomCode, gameMode: "teams" });
    await updated;
    const round = await startMatch(fx);
    const psychic = fx.socketFor(round.psychicId);
    const teammate = fx.socketFor(
      required(
        fx
          .room()
          .players.find(
            (player) => player.id !== round.psychicId && player.teamId === round.activeTeamId,
          ),
      ).id,
    );

    const error = once(teammate, "action_error");
    teammate.emit("redraw_target", {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-1",
    });
    assert.deepEqual(required(await error), {
      event: "redraw_target",
      code: "NOT_PSYCHIC",
      requestId: "request-1",
    });
    assert.deepEqual(fx.room().targetRedrawsUsedByTeam, {}, "the team budget is untouched");

    // The clue giver of that same team still shares the team allowance.
    const success = once(psychic, "target_redrawn");
    psychic.emit("redraw_target", {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-2",
    });
    const payload = required(await success);
    assert.equal(payload.targetRedraw.remaining, 2);
    assert.equal(Object.keys(fx.room().targetRedrawsUsedByTeam).length, 1);
    assert.deepEqual(fx.room().targetRedrawsUsedByPlayer, {});
  } finally {
    await fx.close();
  }
});

void test("an older client without the capability is refused and told why", async () => {
  const fx = await socketFixture({ capability: false });
  try {
    const round = await startMatch(fx);
    const psychic = socketFor(fx, round.psychicId);
    const error = once(psychic, "action_error");
    psychic.emit("redraw_target", {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-1",
    });
    assert.deepEqual(required(await error), {
      event: "redraw_target",
      code: "TARGET_REDRAW_UNSUPPORTED",
      requestId: "request-1",
    });
    assert.equal(fx.room().currentRound.targetRevision, 0);
  } finally {
    await fx.close();
  }
});

void test("a clue must name the revision it was written for", async () => {
  const fx = await socketFixture();
  try {
    const round = await startMatch(fx);
    const psychic = socketFor(fx, round.psychicId);

    const success = once(psychic, "target_redrawn");
    psychic.emit("redraw_target", {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-1",
    });
    await success;

    const stale = once(psychic, "action_error");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      clue: "written for the old position",
      cardId: round.card.id,
      targetRevision: 0,
    });
    assert.deepEqual(required(await stale), {
      event: "clue_submitted",
      code: "STALE_TARGET",
    });
    assert.equal(fx.room().currentRound.clue, null, "the stale clue is not stored");

    const broadcast = once(fx.owner, "clue_broadcast");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      clue: "written for the new position",
      cardId: round.card.id,
      targetRevision: 1,
    });
    assert.equal(required(await broadcast).clue, "written for the new position");
  } finally {
    await fx.close();
  }
});

void test("a legacy clue without revision context is refused once the position moved", async () => {
  const fx = await socketFixture({ capability: false });
  try {
    const round = await startMatch(fx);
    const psychic = socketFor(fx, round.psychicId);

    // While the position has not moved, a legacy clue is still accepted.
    const firstBroadcast = once(fx.owner, "clue_broadcast");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      clue: "legacy clue",
      cardId: round.card.id,
    });
    await firstBroadcast;

    // Simulate the authoritative state of a turn whose position already moved. A legacy
    // client cannot know the revision, so its clue must be refused rather than guessed at.
    const room = fx.room();
    room.currentRound.targetRevision = 1;
    room.currentRound.clue = null;
    room.currentRound.status = "waiting";
    const refused = once(psychic, "action_error");
    psychic.emit("clue_submitted", {
      roomCode: fx.roomCode,
      clue: "legacy clue after the move",
      cardId: round.card.id,
    });
    assert.deepEqual(required(await refused), {
      event: "clue_submitted",
      code: "UPDATE_REQUIRED",
    });
    assert.equal(room.currentRound.clue, null);
  } finally {
    await fx.close();
  }
});

void test("a reconnect restores the changed position and the remaining allowance", async () => {
  const fx = await socketFixture();
  try {
    const round = await startMatch(fx);
    const psychicId = round.psychicId;
    const psychic = socketFor(fx, psychicId);
    const other = psychic === fx.owner ? fx.guest : fx.owner;
    const success = once(psychic, "target_redrawn");
    psychic.emit("redraw_target", {
      roomCode: fx.roomCode,
      roundNumber: round.roundNumber,
      cardId: round.card.id,
      targetRevision: 0,
      requestId: "request-1",
    });
    const payload = required(await success);
    const token = required(
      fx.room().players.find((player) => player.id === psychicId),
    ).reconnectToken;

    const disconnected = onceWhere(
      other,
      "player_disconnected",
      (data) => data.playerId === psychicId,
    );
    psychic.close();
    await disconnected;

    const restored = await fx.connect(fx.auth);
    const welcome = once(restored, "reconnect_success");
    restored.emit("reconnect_player", { roomCode: fx.roomCode, reconnectToken: token });
    const state = required(await welcome);
    assert.equal(state.playerId, psychicId);
    assert.equal(state.currentRound?.psychicTargetAngle, payload.targetAngle);
    assert.deepEqual(required(state.currentRound).targetRedraw, payload.targetRedraw);
  } finally {
    await fx.close();
  }
});

void test("voluntary skipping is refused and only the timeout can end a clue turn", async () => {
  const fx = await socketFixture();
  try {
    const round = await startMatch(fx);
    const psychicId = round.psychicId;
    const psychic = socketFor(fx, psychicId);
    const before = fx.room();
    const beforeRoundNumber = before.currentRound.roundNumber;
    const scores = before.players.map((player) => player.score);

    const removed = once(psychic, "action_error");
    psychic.emit("skip_round", { roomCode: fx.roomCode, cardId: round.card.id });
    assert.deepEqual(required(await removed), { event: "skip_round", code: "ACTION_REMOVED" });

    const after = fx.room();
    assert.equal(after.currentRound.roundNumber, beforeRoundNumber);
    assert.deepEqual(
      after.players.map((player) => player.score),
      scores,
      "an obsolete skip changes no score",
    );

    const skipped = once(fx.owner, "round_skipped");
    assert.equal(advanceExpiredPsychicTurn(fx.io, after, psychicId), true);
    const announcement = required(await skipped);
    assert.equal(announcement.penalty, -1);
    assert.equal(announcement.source, "timeout");
    assert.equal(after.currentRound.roundNumber, beforeRoundNumber + 1);
    assert.deepEqual(
      after.players.map((player) => player.score),
      scores.map((score, index) => (after.players[index]?.id === psychicId ? score - 1 : score)),
      "the timeout still costs exactly one point",
    );
  } finally {
    await fx.close();
  }
});
