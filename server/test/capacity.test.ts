import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MAX_PLAYERS } from "@hint/contracts";
import { createClient, once, onceWhere, required, type Client } from "./helpers.js";
import { createGameServer } from "../index.js";
import {
  addJoinRequest,
  addPlayer,
  createRoom,
  deleteRoom,
  getAllRooms,
  getRoom,
} from "../roomManager.js";
import { deserializeRoom, serializeRoom } from "../persistence.js";
import { rebalanceTeams } from "../teamEngine.js";
import { ROOMS } from "../config/gameConfig.js";

async function createServerFixture() {
  const gameServer = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", resolve));
  const { port } = gameServer.server.address() as AddressInfo;
  return { gameServer, url: `http://127.0.0.1:${port}` };
}

async function connect(url: string) {
  const client = createClient(url, { transports: ["websocket"], forceNew: true });
  await once(client, "connect");
  return client;
}

void test("seats accept twelve players and reject the thirteenth", async () => {
  const { gameServer, url } = await createServerFixture();
  const clients: Client[] = [];
  try {
    const owner = await connect(url);
    clients.push(owner);
    const created = once(owner, "room_created");
    owner.emit("create_room", { displayName: "Owner", winningScore: 20 });
    const { roomCode } = await created;

    for (let seat = 2; seat <= MAX_PLAYERS; seat++) {
      const player = await connect(url);
      clients.push(player);
      const joined = once(player, "join_success");
      player.emit("join_room", { roomCode, displayName: `Player ${seat}` });
      await joined;
    }
    const room = required(getRoom(roomCode));
    assert.equal(room.players.length, MAX_PLAYERS, "the twelfth player takes the last seat");

    const thirteenth = await connect(url);
    clients.push(thirteenth);
    const rejected = once(thirteenth, "join_error");
    thirteenth.emit("join_room", { roomCode, displayName: "Player 13" });
    assert.equal(required(await rejected).message, "الغرفة ممتلئة");
    assert.equal(required(getRoom(roomCode)).players.length, MAX_PLAYERS);
  } finally {
    for (const client of clients) client.close();
    for (const [code] of getAllRooms()) deleteRoom(code);
    await gameServer.io.close();
  }
});

void test("a pending request keeps its answer once seats and reservations are full", async () => {
  const { gameServer, url } = await createServerFixture();
  const clients: Client[] = [];
  try {
    const owner = await connect(url);
    clients.push(owner);
    const created = once(owner, "room_created");
    owner.emit("create_room", { displayName: "Owner", winningScore: 20 });
    const { roomCode } = await created;

    // Eleven seats plus one reservation is the full twelve-player budget.
    for (let seat = 2; seat <= MAX_PLAYERS - 1; seat++) {
      const player = await connect(url);
      clients.push(player);
      const joined = once(player, "join_success");
      player.emit("join_room", { roomCode, displayName: `Player ${seat}` });
      await joined;
    }
    const started = Promise.all([once(owner, "round_start")]);
    owner.emit("start_game", { roomCode });
    await started;

    const requester = await connect(url);
    clients.push(requester);
    const pending = once(requester, "join_pending");
    requester.emit("join_room", { roomCode, displayName: "Late" });
    const { requestId } = required(await pending);

    // The retry must be recognised as the same request, not as a fresh rejected seat.
    // The join handler rate-limits one attempt per socket per 500 ms, so wait that out.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const retried = once(requester, "join_pending");
    requester.emit("join_room", { roomCode, displayName: "Late" });
    assert.equal(required(await retried).requestId, requestId);

    const stranger = await connect(url);
    clients.push(stranger);
    const rejected = once(stranger, "join_error");
    stranger.emit("join_room", { roomCode, displayName: "Stranger" });
    assert.equal(required(await rejected).message, "الغرفة ممتلئة");
  } finally {
    for (const client of clients) client.close();
    for (const [code] of getAllRooms()) deleteRoom(code);
    await gameServer.io.close();
  }
});

void test("an approval that cannot be seated is resolved for both sides", async () => {
  const { gameServer, url } = await createServerFixture();
  const clients: Client[] = [];
  try {
    const owner = await connect(url);
    clients.push(owner);
    const room = createRoom("FULL", "owner-id", required(owner.id), "Owner", 20);
    room.status = "playing";
    for (let seat = 1; seat < MAX_PLAYERS; seat++) {
      addPlayer(room, `seat-${seat}`, `socket-${seat}`, `Seat ${seat}`);
    }
    assert.equal(room.players.length, MAX_PLAYERS);

    const requester = await connect(url);
    clients.push(requester);
    addJoinRequest(room, {
      id: "request-1",
      socketId: required(requester.id),
      displayName: "Late",
      requestedAt: Date.now(),
      timeout: null,
    });

    const failure = onceWhere(owner, "action_error", (data) => data.code === "ROOM_FULL");
    const resolved = once(requester, "join_request_resolved");
    owner.emit("approve_join_request", { roomCode: "FULL", requestId: "request-1" });
    assert.equal(required(await failure).event, "approve_join_request");
    required(await resolved);
    assert.equal(room.joinRequests.length, 0, "the request is not left hanging");
    assert.equal(room.players.length, MAX_PLAYERS, "no seat is created beyond the limit");
  } finally {
    for (const client of clients) client.close();
    for (const [code] of getAllRooms()) deleteRoom(code);
    await gameServer.io.close();
  }
});

void test("twelve players split into evenly sized teams for two, three or four teams", () => {
  const room = createRoom("TEAM", "owner", "owner-socket", "Owner", 20);
  try {
    room.gameMode = "teams";
    for (let seat = 1; seat < MAX_PLAYERS; seat++) {
      addPlayer(room, `seat-${seat}`, `socket-${seat}`, `Seat ${seat}`);
    }
    assert.equal(room.players.length, MAX_PLAYERS);

    const expected: Record<number, number[]> = {
      2: [6, 6],
      3: [4, 4, 4],
      4: [3, 3, 3, 3],
    };
    for (const teamCount of [2, 3, 4]) {
      rebalanceTeams(room, teamCount);
      const sizes = room.teams.map(
        (team) => room.players.filter((player) => player.teamId === team.id).length,
      );
      assert.deepEqual(sizes, expected[teamCount], `${teamCount} teams across twelve players`);
    }
  } finally {
    deleteRoom("TEAM");
  }
});

void test("twelve-player snapshots restore while a thirteenth player is rejected", () => {
  const room = createRoom("SNAP", "owner", "owner-socket", "Owner", 20);
  try {
    for (let seat = 1; seat < MAX_PLAYERS; seat++) {
      addPlayer(room, `seat-${seat}`, `socket-${seat}`, `Seat ${seat}`);
    }
    const snapshot = serializeRoom(room);
    const restored = deserializeRoom(snapshot);
    assert.ok(restored, "a twelve-player snapshot restores");
    assert.equal(restored.players.length, MAX_PLAYERS);

    const oversized = {
      ...snapshot,
      players: [
        ...snapshot.players,
        { ...required(snapshot.players[0]), id: "one-too-many", reconnectToken: "extra-token" },
      ],
    };
    assert.equal(deserializeRoom(oversized), null, "a thirteen-player snapshot is rejected");
  } finally {
    deleteRoom("SNAP");
  }
});

void test("the server room limit comes from the shared contract", () => {
  assert.equal(MAX_PLAYERS, 12);
  assert.equal(ROOMS.MAX_PLAYERS, MAX_PLAYERS);
});
