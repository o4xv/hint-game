import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MAX_PLAYERS } from "@hint/contracts";
import { createClient, once, onceWhere, required, roomForTest, type Client } from "./helpers.js";
import { createGameServer } from "../index.js";
import { addPlayer, createRoom, deleteRoom, getAllRooms } from "../roomManager.js";
import { deserializeRoom, serializeRoom } from "../persistence.js";
import { createTeams, rebalanceTeams } from "../teamEngine.js";

async function fixture(playerCount = 2) {
  const gameServer = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", resolve));
  const { port } = gameServer.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const connect = async () => {
    const client = createClient(url, { transports: ["websocket"], forceNew: true });
    clients.push(client);
    await once(client, "connect");
    return client;
  };
  const owner = await connect();
  const created = once(owner, "room_created");
  owner.emit("create_room", { displayName: "Owner", winningScore: 20 });
  const { roomCode } = await created;
  const guests: Client[] = [];
  for (let index = 1; index < playerCount; index++) {
    const guest = await connect();
    const joined = once(guest, "join_success");
    guest.emit("join_room", { roomCode, displayName: `Guest ${index}` });
    await joined;
    guests.push(guest);
  }
  return {
    owner,
    guests,
    roomCode,
    room: () => roomForTest(roomCode),
    close: async () => {
      for (const client of clients) client.close();
      for (const [code] of getAllRooms()) deleteRoom(code);
      await gameServer.io.close();
    },
  };
}

async function enableTeams(owner: Client, roomCode: string) {
  const updated = onceWhere(owner, "settings_updated", (data) => data.teams !== undefined);
  owner.emit("update_game_mode", { roomCode, gameMode: "teams" });
  await updated;
}

void test("the host renames a team in the lobby and every client sees the accepted name", async () => {
  const fx = await fixture(3);
  try {
    await enableTeams(fx.owner, fx.roomCode);
    const guestUpdate = onceWhere(required(fx.guests[0]), "settings_updated", (data) =>
      (data.teams ?? []).some((team) => team.name === "النجوم"),
    );
    fx.owner.emit("rename_team", { roomCode: fx.roomCode, teamId: "team-1", name: "  النجوم  " });
    const broadcast = required(await guestUpdate);
    assert.equal(required(broadcast.teams?.find((team) => team.id === "team-1")).name, "النجوم");
    assert.equal(
      required(fx.room().teams.find((team) => team.id === "team-1")).name,
      "النجوم",
      "the trimmed name is stored",
    );
  } finally {
    await fx.close();
  }
});

void test("only the host can rename, and only before the match starts", async () => {
  const fx = await fixture(4);
  try {
    await enableTeams(fx.owner, fx.roomCode);
    const guestRejected = once(required(fx.guests[0]), "action_error");
    required(fx.guests[0]).emit("rename_team", {
      roomCode: fx.roomCode,
      teamId: "team-1",
      name: "من الغuest",
    });
    assert.deepEqual(required(await guestRejected), {
      event: "rename_team",
      code: "NOT_OWNER",
      teamId: "team-1",
    });
    assert.notEqual(required(fx.room().teams[0]).name, "من الغuest");

    const started = Promise.all([
      once(fx.owner, "round_start"),
      once(required(fx.guests[0]), "round_start"),
    ]);
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    await started;
    const lateRejected = once(fx.owner, "action_error");
    fx.owner.emit("rename_team", { roomCode: fx.roomCode, teamId: "team-1", name: "متأخر" });
    assert.deepEqual(required(await lateRejected), {
      event: "rename_team",
      code: "ROOM_NOT_WAITING",
      teamId: "team-1",
    });
  } finally {
    await fx.close();
  }
});

void test("rejected names keep the stored name and explain the exact rule", async () => {
  const fx = await fixture(2);
  try {
    await enableTeams(fx.owner, fx.roomCode);
    const cases: [string, string][] = [
      ["   ", "TEAM_NAME_BLANK"],
      ["<script>", "TEAM_NAME_INVALID"],
      ["ا".repeat(25), "TEAM_NAME_TOO_LONG"],
      ["الفريق ٢", "TEAM_NAME_DUPLICATE"],
      ["الفريق   ٢", "TEAM_NAME_DUPLICATE"],
    ];
    for (const [name, code] of cases) {
      const rejected = once(fx.owner, "action_error");
      fx.owner.emit("rename_team", { roomCode: fx.roomCode, teamId: "team-1", name });
      // The rejected team travels with the answer so the client can keep two open editors apart.
      assert.deepEqual(
        required(await rejected),
        { event: "rename_team", code, teamId: "team-1" },
        name,
      );
      assert.equal(required(fx.room().teams[0]).name, "الفريق ١", `unchanged after ${code}`);
    }

    const accepted = once(fx.owner, "settings_updated");
    fx.owner.emit("rename_team", {
      roomCode: fx.roomCode,
      teamId: "team-1",
      name: "نجوم\u00a0الليل",
    });
    required(await accepted);
    assert.equal(
      required(fx.room().teams[0]).name,
      "نجوم الليل",
      "internal whitespace is normalised",
    );
  } finally {
    await fx.close();
  }
});

void test("names survive count changes, mode switches, rematches and snapshots", async () => {
  const fx = await fixture(6);
  try {
    await enableTeams(fx.owner, fx.roomCode);
    const renamed = once(fx.owner, "settings_updated");
    fx.owner.emit("rename_team", { roomCode: fx.roomCode, teamId: "team-2", name: "النجوم" });
    await renamed;

    const three = once(fx.owner, "settings_updated");
    fx.owner.emit("update_team_count", { roomCode: fx.roomCode, teamCount: 3 });
    await three;
    assert.equal(required(fx.room().teams.find((team) => team.id === "team-2")).name, "النجوم");
    assert.equal(
      required(fx.room().teams.find((team) => team.id === "team-3")).name,
      "الفريق ٣",
      "a new team gets its own default",
    );

    // Individual mode keeps the names for when teams come back.
    const individual = once(fx.owner, "settings_updated");
    fx.owner.emit("update_game_mode", { roomCode: fx.roomCode, gameMode: "individual" });
    await individual;
    const teamsAgain = once(fx.owner, "settings_updated");
    fx.owner.emit("update_game_mode", { roomCode: fx.roomCode, gameMode: "teams" });
    await teamsAgain;
    assert.equal(required(fx.room().teams.find((team) => team.id === "team-2")).name, "النجوم");

    const snapshot = serializeRoom(fx.room());
    const restored = deserializeRoom(snapshot);
    assert.ok(restored);
    assert.equal(required(restored.teams.find((team) => team.id === "team-2")).name, "النجوم");
  } finally {
    await fx.close();
  }
});

void test("a rename never leaks into another team's default", () => {
  const teams = createTeams(2, []);
  // The host claimed the name the third team would otherwise receive.
  required(teams[0]).name = "الفريق ٣";
  const grown = createTeams(3, teams);
  const names = grown.map((team) => team.name);
  assert.equal(new Set(names).size, names.length, `distinct names: ${names.join(", ")}`);
  assert.equal(required(grown[1]).name, "الفريق ٢", "an existing name is preserved");
  assert.equal(required(grown[2]).name, "الفريق ١", "the new team takes an unused default");
});

void test("team reconstruction keeps surviving names, colours and scores", () => {
  const room = createRoom("TEAM", "owner", "owner-socket", "Owner", 20);
  try {
    room.gameMode = "teams";
    for (let seat = 1; seat < MAX_PLAYERS; seat++) {
      addPlayer(room, `seat-${seat}`, `socket-${seat}`, `Seat ${seat}`);
    }
    required(room.teams[0]).name = "النجوم";
    required(room.teams[0]).score = 7;
    const [original] = room.teams;
    rebalanceTeams(room, 4);
    const survivor = required(room.teams.find((team) => team.id === "team-1"));
    assert.equal(survivor.name, "النجوم");
    assert.equal(survivor.color, required(original).color);
    assert.equal(survivor.score, 7);
  } finally {
    deleteRoom("TEAM");
  }
});

void test("the start error names the team that is short", async () => {
  const fx = await fixture(4);
  try {
    await enableTeams(fx.owner, fx.roomCode);
    const renamed = once(fx.owner, "settings_updated");
    fx.owner.emit("rename_team", { roomCode: fx.roomCode, teamId: "team-2", name: "النجوم" });
    await renamed;

    // Move everyone into team-1 so team-2 is two players short.
    for (const player of fx.room().players) {
      const updated = once(fx.owner, "settings_updated");
      fx.owner.emit("assign_team", {
        roomCode: fx.roomCode,
        playerId: player.id,
        teamId: "team-1",
      });
      await updated;
    }
    const twoShort = once(fx.owner, "game_start_error");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    assert.equal(required(await twoShort).message, "فريق النجوم يحتاج لاعبين");

    // Give team-2 one player: the message becomes singular.
    const moved = once(fx.owner, "settings_updated");
    fx.owner.emit("assign_team", {
      roomCode: fx.roomCode,
      playerId: required(fx.room().players[0]).id,
      teamId: "team-2",
    });
    await moved;
    const oneShort = once(fx.owner, "game_start_error");
    fx.owner.emit("start_game", { roomCode: fx.roomCode });
    assert.equal(required(await oneShort).message, "فريق النجوم يحتاج لاعباً إضافياً");
  } finally {
    await fx.close();
  }
});
