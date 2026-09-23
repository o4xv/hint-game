import type { PublicPack } from "@hint/contracts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createClient,
  once,
  onceWhere,
  required,
  roomForTest as getRoom,
  type Client,
} from "./helpers.js";
import { createGameServer } from "../index.js";
import { createRoom, getAllRooms, deleteRoom } from "../roomManager.js";
import { getTargetRegion } from "../gameEngine.js";
import { advanceExpiredPsychicTurn, startGuessTimer } from "../socketHandlers/roundLogic.js";

async function createFixture() {
  const gameServer = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", resolve));
  const { port } = gameServer.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const owner = createClient(url, { transports: ["websocket"], forceNew: true });
  const guest = createClient(url, { transports: ["websocket"], forceNew: true });
  await Promise.all([once(owner, "connect"), once(guest, "connect")]);

  const ownerCreated = once(owner, "room_created");
  owner.emit("create_room", { displayName: "Owner", winningScore: 20 });
  const ownerData = await ownerCreated;

  const guestJoined = once(guest, "join_success");
  guest.emit("join_room", { roomCode: ownerData.roomCode, displayName: "Guest" });
  const guestData = await guestJoined;

  async function close() {
    owner.close();
    guest.close();
    for (const [code] of getAllRooms()) deleteRoom(code);
    await gameServer.io.close();
  }

  return { gameServer, url, owner, guest, ownerData, guestData, close };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function startRound(fixture: Fixture, enablePsychicTimer = false) {
  const { owner, guest, ownerData } = fixture;
  if (enablePsychicTimer) {
    const settingsUpdated = once(owner, "settings_updated");
    owner.emit("toggle_psychic_timer", { roomCode: ownerData.roomCode });
    await settingsUpdated;
  }

  const ownerRound = once(owner, "round_start");
  const guestRound = once(guest, "round_start");
  owner.emit("start_game", { roomCode: ownerData.roomCode });
  const [round] = await Promise.all([ownerRound, guestRound]);
  return required(round);
}

async function addFixturePlayer(fixture: Fixture, displayName: string) {
  const socket = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  await once(socket, "connect");
  const joined = once(socket, "join_success");
  socket.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName });
  const data = await joined;
  return { socket, data };
}

void test("labels psychic and guessing timers with their round context", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const settingsUpdated = once(fixture.owner, "settings_updated");
  fixture.owner.emit("toggle_psychic_timer", { roomCode: fixture.ownerData.roomCode });
  await settingsUpdated;

  const psychicTimer = once(fixture.owner, "timer_start");
  const round = await startRound(fixture);
  const psychicTimerData = await psychicTimer;
  assert.equal(psychicTimerData.phase, "psychic");
  assert.equal(psychicTimerData.roundNumber, round.roundNumber);

  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guessTimer = once(fixture.owner, "timer_start");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "phase contract" });
  const guessTimerData = await guessTimer;
  assert.equal(guessTimerData.phase, "guessing");
  assert.equal(guessTimerData.roundNumber, round.roundNumber);
});

void test("acknowledges accepted guesses and rejects guesses outside the guessing phase", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;

  const prematureRejection = once(guesser, "guess_rejected");
  guesser.emit("guess_submitted", { roomCode: fixture.ownerData.roomCode, angle: 90 });
  assert.deepEqual(await prematureRejection, {
    roundNumber: round.roundNumber,
    reason: "NOT_GUESSING",
  });

  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "ack contract" });
  await clue;

  const accepted = once(guesser, "guess_accepted");
  guesser.emit("guess_submitted", { roomCode: fixture.ownerData.roomCode, angle: 42 });
  assert.deepEqual(await accepted, {
    roundNumber: round.roundNumber,
    angle: 42,
  });
});

void test("accepts an automatic guess at the displayed deadline before revealing", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", {
    roomCode: fixture.ownerData.roomCode,
    clue: "deadline contract",
  });
  await clue;

  const room = getRoom(fixture.ownerData.roomCode);
  const timer = onceWhere(guesser, "timer_start", (data) => data.endsAt - Date.now() < 1_000);
  startGuessTimer(fixture.gameServer.io, room, 40);
  const { endsAt } = await timer;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, endsAt - Date.now() + 25)));

  const accepted = once(guesser, "guess_accepted");
  guesser.emit("guess_submitted", { roomCode: room.code, angle: 90 });
  assert.equal((await accepted).roundNumber, round.roundNumber);
});

void test("ignores guess previews outside team mode", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", {
    roomCode: fixture.ownerData.roomCode,
    clue: "individual preview",
  });
  await clue;

  let previewReceived = false;
  psychic.on("team_guess_preview", () => {
    previewReceived = true;
  });
  guesser.emit("guess_preview", {
    roomCode: fixture.ownerData.roomCode,
    angle: 90,
    roundNumber: round.roundNumber,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(previewReceived, false);
});

void test("rejects duplicate starts, invalid settings, invalid guesses, and premature next rounds", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const round = await startRound(fixture);
  const room = getRoom(fixture.ownerData.roomCode);
  assert.equal(room.currentRound.roundNumber, 1);

  fixture.owner.emit("start_game", { roomCode: fixture.ownerData.roomCode });
  fixture.owner.emit("update_settings", { roomCode: fixture.ownerData.roomCode, winningScore: 1 });
  fixture.owner.emit("update_settings", { roomCode: fixture.ownerData.roomCode, winningScore: 10 });
  fixture.owner.emit("toggle_psychic_timer", { roomCode: fixture.ownerData.roomCode });
  fixture.owner.emit("next_round", { roomCode: fixture.ownerData.roomCode });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(room.currentRound.roundNumber, 1);
  assert.equal(room.winningScore, 20);
  assert.equal(room.psychicTimerEnabled, false);

  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clueBroadcast = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "clue" });
  await clueBroadcast;

  guesser.emit("guess_submitted", { roomCode: fixture.ownerData.roomCode, angle: 181 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(room.currentRound.guesses.length, 0);
});

void test("transfers ownership after the former owner leaves", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const transferred = once(fixture.guest, "ownership_transferred");
  fixture.owner.close();
  const event = await transferred;
  assert.equal(event.ownerId, fixture.guestData.playerId);
  assert.equal(getRoom(fixture.ownerData.roomCode).ownerId, fixture.guestData.playerId);
});

void test("disconnects a socket from every room membership it created", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const secondRoom = createRoom(
    "DUAL",
    "legacy-owner",
    required(fixture.owner.id),
    "Legacy Owner",
    20,
  );

  fixture.owner.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(required(getRoom(fixture.ownerData.roomCode).players[0]).isConnected, false);
  assert.equal(required(secondRoom.players[0]).isConnected, false);
});

void test("treats repeated room creation from one socket as idempotent", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  await new Promise((resolve) => setTimeout(resolve, 510));
  const repeated = once(fixture.owner, "room_created");
  fixture.owner.emit("create_room", { displayName: "Owner Again", winningScore: 40 });
  const data = await repeated;

  assert.equal(data.roomCode, fixture.ownerData.roomCode);
  assert.equal([...getAllRooms()].length, 1);
});

void test("treats repeated joins from one socket as idempotent", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  await new Promise((resolve) => setTimeout(resolve, 510));
  const repeated = once(fixture.guest, "join_success");
  fixture.guest.emit("join_room", {
    roomCode: fixture.ownerData.roomCode,
    displayName: "Guest Again",
  });
  const data = await repeated;

  assert.equal(data.playerId, fixture.guestData.playerId);
  assert.equal(getRoom(fixture.ownerData.roomCode).players.length, 2);
});

void test("does not reset the room creation quota when a client reconnects", async (t) => {
  const previousLimit = process.env.ROOM_CREATION_LIMIT;
  process.env.ROOM_CREATION_LIMIT = "5";
  t.after(() => {
    if (previousLimit === undefined) delete process.env.ROOM_CREATION_LIMIT;
    else process.env.ROOM_CREATION_LIMIT = previousLimit;
  });
  const fixture = await createFixture();
  t.after(fixture.close);
  const creators: Client[] = [];
  t.after(() => {
    creators.forEach((socket) => socket.close());
  });

  for (let index = 0; index < 4; index++) {
    const socket = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
    creators.push(socket);
    await once(socket, "connect");
    const created = once(socket, "room_created");
    socket.emit("create_room", { displayName: `Creator ${index}`, winningScore: 20 });
    await created;
    socket.close();
  }

  const reconnectingCreator = createClient(fixture.url, {
    transports: ["websocket"],
    forceNew: true,
  });
  creators.push(reconnectingCreator);
  await once(reconnectingCreator, "connect");
  const rejected = once(reconnectingCreator, "join_error");
  reconnectingCreator.emit("create_room", { displayName: "Creator Limit", winningScore: 20 });

  assert.equal((await rejected).code, "ROOM_CREATE_RATE_LIMITED");
});

void test("forwards pending join requests to the replacement owner", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  t.after(() => third.socket.close());
  await startRound(fixture);

  const late = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => late.close());
  await once(late, "connect");
  const originalRequest = once(fixture.owner, "join_request");
  late.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Late" });
  const request = await originalRequest;

  const forwardedRequest = onceWhere(
    fixture.guest,
    "join_request",
    (candidate) => candidate.requestId === request.requestId,
  );
  fixture.owner.close();
  const forwarded = await forwardedRequest;

  assert.equal(forwarded.requestId, request.requestId);
  assert.equal(forwarded.displayName, "Late");
  assert.equal(getRoom(fixture.ownerData.roomCode).ownerId, fixture.guestData.playerId);
});

void test("allows a page refresh to take over an existing session safely", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const refreshed = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => refreshed.close());
  await once(refreshed, "connect");
  const rejoined = once(refreshed, "reconnect_success");
  const replaced = once(fixture.owner, "session_replaced");
  refreshed.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: fixture.ownerData.reconnectToken,
  });
  await rejoined;
  await replaced;

  const room = getRoom(fixture.ownerData.roomCode);
  assert.equal(required(room.players[0]).socketId, refreshed.id);

  fixture.owner.emit("update_settings", { roomCode: fixture.ownerData.roomCode, winningScore: 10 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(room.winningScore, 20);
});

void test("labels terminal reconnect failures so clients preserve only recoverable sessions", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const invalid = once(fixture.guest, "join_error");
  fixture.guest.emit("reconnect_player", { roomCode: "", reconnectToken: "" });
  assert.equal((await invalid).code, "INVALID_RECONNECT");

  const missingRoom = once(fixture.guest, "join_error");
  fixture.guest.emit("reconnect_player", { roomCode: "ZZZZ", reconnectToken: "token" });
  assert.equal((await missingRoom).code, "ROOM_NOT_FOUND");

  const expired = once(fixture.guest, "join_error");
  fixture.guest.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: "expired-token",
  });
  assert.equal((await expired).code, "SESSION_EXPIRED");
});

void test("restores a psychic target and timer after reconnecting before a clue", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const round = await startRound(fixture, true);
  const psychicIsOwner = round.psychicId === fixture.ownerData.playerId;
  const psychic = psychicIsOwner ? fixture.owner : fixture.guest;
  const psychicData = psychicIsOwner ? fixture.ownerData : fixture.guestData;
  const room = getRoom(fixture.ownerData.roomCode);
  const targetAngle = room.currentRound.targetAngle;

  const disconnected = once(psychicIsOwner ? fixture.guest : fixture.owner, "player_disconnected");
  psychic.close();
  await disconnected;
  const reconnected = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => reconnected.close());
  await once(reconnected, "connect");
  const timerStarted = once(reconnected, "timer_start");
  const rejoin = once(reconnected, "reconnect_success");
  reconnected.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: psychicData.reconnectToken,
  });
  const [state] = await Promise.all([rejoin, timerStarted]);

  assert.equal(required(state.currentRound).psychicTargetAngle, targetAngle);
  assert.ok(required(required(state.currentRound).timerEndsAt) > Date.now());
});

void test("restores a submitted guess without leaking the target to a non-psychic", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const third = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => third.close());
  await once(third, "connect");
  const thirdJoined = once(third, "join_success");
  third.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Third" });
  const thirdData = await thirdJoined;

  const round = await startRound(fixture);
  const players = [
    { socket: fixture.owner, data: fixture.ownerData },
    { socket: fixture.guest, data: fixture.guestData },
    { socket: third, data: thirdData },
  ];
  const psychicEntry = players.find((player) => player.data.playerId === round.psychicId);
  const guesserEntry = players.find((player) => player.data.playerId !== round.psychicId);
  const observerEntry = players.find(
    (player) => player !== psychicEntry && player !== guesserEntry,
  );
  const psychic = required(psychicEntry).socket;
  const guesser = required(guesserEntry).socket;
  const guesserData = required(guesserEntry).data;
  const clueBroadcast = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "clue" });
  await clueBroadcast;

  const submitted = onceWhere(
    psychic,
    "player_guessed",
    (data) => data.playerId === guesserData.playerId,
  );
  guesser.emit("guess_submitted", { roomCode: fixture.ownerData.roomCode, angle: 42 });
  await submitted;

  const disconnected = once(required(observerEntry).socket, "player_disconnected");
  guesser.close();
  await disconnected;
  const reconnected = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => reconnected.close());
  await once(reconnected, "connect");
  const rejoin = once(reconnected, "reconnect_success");
  reconnected.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: guesserData.reconnectToken,
  });
  const state = await rejoin;

  assert.equal(required(state.currentRound).hasSubmitted, true);
  assert.equal(required(state.currentRound).myGuessAngle, 42);
  assert.equal("psychicTargetAngle" in required(state.currentRound), false);
  assert.ok(required(required(state.currentRound).timerEndsAt) > Date.now());
});

void test("restores reveal data after reconnecting during results", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clueBroadcast = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "clue" });
  await clueBroadcast;

  const revealed = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  const revealData = await revealed;

  const ratingRecorded = once(fixture.owner, "card_rating_recorded");
  fixture.owner.emit("card_rating", { roomCode: fixture.ownerData.roomCode, vote: "down" });
  await ratingRecorded;

  const observer = fixture.guest;
  const disconnected = once(observer, "player_disconnected");
  fixture.owner.close();
  await disconnected;
  const reconnected = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => reconnected.close());
  await once(reconnected, "connect");
  const rejoin = once(reconnected, "reconnect_success");
  reconnected.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: fixture.ownerData.reconnectToken,
  });
  const state = await rejoin;

  assert.equal(state.status, "playing");
  assert.equal(required(state.currentRound).status, "revealed");
  assert.equal(required(state.currentRound).hasRated, true);
  assert.equal(required(state.currentRound).myRatingVote, "down");
  assert.deepEqual(required(state.currentRound).revealData, revealData);
  assert.equal(state.readyState.endsAt, required(revealData.readyState).endsAt);
  assert.equal(state.readyState.requiredCount, 2);
});

void test("restores final results after reconnecting from the winner screen", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const round = await startRound(fixture);
  const room = getRoom(fixture.ownerData.roomCode);
  room.winningScore = 1;
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clueBroadcast = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "clue" });
  await clueBroadcast;

  const revealed = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: room.currentRound.targetAngle,
  });
  const revealData = await revealed;
  assert.equal(room.status, "finished");

  const disconnected = once(fixture.guest, "player_disconnected");
  fixture.owner.close();
  await disconnected;
  const reconnected = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => reconnected.close());
  await once(reconnected, "connect");
  const rejoin = once(reconnected, "reconnect_success");
  reconnected.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: fixture.ownerData.reconnectToken,
  });
  const state = await rejoin;

  assert.equal(state.status, "finished");
  assert.deepEqual(state.finalState, revealData);
});

void test("expires absent restored players and transfers restored ownership", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  t.after(() => third.socket.close());
  await startRound(fixture);

  const room = getRoom(fixture.ownerData.roomCode);
  room.currentRound.psychicId = fixture.guestData.playerId;
  room.currentRound.status = "guessing";
  room.currentRound.clue = "restored clue";
  room.recoveryPending = true;
  room.timerDescriptor = { kind: "guess", endsAt: Date.now() + 5_000 };
  room.timerEndsAt = room.timerDescriptor.endsAt;
  room.players.forEach((player) => {
    player.socketId = null;
    player.isConnected = false;
    player.disconnectTimeout = null;
  });

  const restoredGuest = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  const restoredThird = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => {
    restoredGuest.close();
    restoredThird.close();
  });
  await Promise.all([once(restoredGuest, "connect"), once(restoredThird, "connect")]);
  const guestReady = once(restoredGuest, "reconnect_success");
  restoredGuest.emit("reconnect_player", {
    roomCode: room.code,
    reconnectToken: fixture.guestData.reconnectToken,
  });
  await guestReady;
  const thirdReady = once(restoredThird, "reconnect_success");
  restoredThird.emit("reconnect_player", {
    roomCode: room.code,
    reconnectToken: third.data.reconnectToken,
  });
  await thirdReady;

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    room.players.some((player) => player.id === fixture.ownerData.playerId),
    false,
  );
  assert.equal(room.ownerId, fixture.guestData.playerId);
});

void test("expires an absent owner from a restored waiting room", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const room = getRoom(fixture.ownerData.roomCode);
  room.recoveryPending = false;
  room.players.forEach((player) => {
    player.socketId = null;
    player.isConnected = false;
    player.disconnectTimeout = null;
  });

  const restoredGuest = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => restoredGuest.close());
  await once(restoredGuest, "connect");
  const guestReady = once(restoredGuest, "reconnect_success");
  restoredGuest.emit("reconnect_player", {
    roomCode: room.code,
    reconnectToken: fixture.guestData.reconnectToken,
  });
  await guestReady;

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    room.players.some((player) => player.id === fixture.ownerData.playerId),
    false,
  );
  assert.equal(room.ownerId, fixture.guestData.playerId);
});

void test("reveals a completed round and permits the next round", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clueBroadcast = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "clue" });
  await clueBroadcast;

  const revealed = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await revealed;

  const nextRound = once(fixture.owner, "round_start");
  fixture.owner.emit("next_round", { roomCode: fixture.ownerData.roomCode });
  const next = await nextRound;
  assert.equal(next.roundNumber, 2);
});

void test("allows the owner to lock and unlock a room for new players", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const third = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => third.close());
  await once(third, "connect");

  const locked = once(fixture.owner, "settings_updated");
  fixture.owner.emit("set_room_lock", { roomCode: fixture.ownerData.roomCode, locked: true });
  assert.equal((await locked).roomLocked, true);

  const rejected = once(third, "join_error");
  third.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Third" });
  assert.equal((await rejected).message, "الغرفة مقفلة");

  const unlocked = once(fixture.owner, "settings_updated");
  fixture.owner.emit("set_room_lock", { roomCode: fixture.ownerData.roomCode, locked: false });
  assert.equal((await unlocked).roomLocked, false);

  await new Promise((resolve) => setTimeout(resolve, 520));
  const joined = once(third, "join_success");
  third.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Third" });
  assert.equal(Reflect.get(await joined, "displayName"), undefined);
  assert.equal(getRoom(fixture.ownerData.roomCode).players.length, 3);
});

void test("approves a late join without exposing the live round, then activates that player next round", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);

  const third = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => third.close());
  await once(third, "connect");

  const ownerRequest = once(fixture.owner, "join_request");
  const pending = once(third, "join_pending");
  third.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Late" });
  const [request, pendingData] = await Promise.all([ownerRequest, pending]);
  assert.equal(pendingData.roomCode, fixture.ownerData.roomCode);

  const accepted = once(third, "join_success");
  fixture.owner.emit("approve_join_request", {
    roomCode: fixture.ownerData.roomCode,
    requestId: request.requestId,
  });
  const lateData = await accepted;
  assert.equal(lateData.joinMode, "next_round");

  const room = getRoom(fixture.ownerData.roomCode);
  const latePlayer = room.players.find((player) => player.id === lateData.playerId);
  assert.equal(required(latePlayer).awaitingNextRound, true);
  assert.equal(
    fixture.gameServer.io.sockets.adapter.rooms.get(room.code)?.has(required(third.id)) ?? false,
    false,
  );

  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  let receivedLiveClue = false;
  third.once("clue_broadcast", () => {
    receivedLiveClue = true;
  });
  const clueBroadcast = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: room.code, clue: "clue" });
  await clueBroadcast;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(receivedLiveClue, false);

  const revealed = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", { roomCode: room.code, angle: room.currentRound.targetAngle });
  await revealed;

  const ownerNext = once(fixture.owner, "round_start");
  const lateNext = once(third, "round_start");
  fixture.owner.emit("next_round", { roomCode: room.code });
  const [nextRound] = await Promise.all([ownerNext, lateNext]);
  assert.equal(nextRound.roundNumber, 2);
  assert.equal(required(latePlayer).awaitingNextRound, false);
  assert.equal(
    fixture.gameServer.io.sockets.adapter.rooms.get(room.code)?.has(required(third.id)),
    true,
  );
});

void test("transfers ownership manually and blocks a kicked player from reconnecting", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const transferred = once(fixture.guest, "ownership_transferred");
  fixture.owner.emit("transfer_ownership", {
    roomCode: fixture.ownerData.roomCode,
    playerId: fixture.guestData.playerId,
  });
  assert.equal((await transferred).ownerId, fixture.guestData.playerId);

  const kicked = once(fixture.owner, "kicked_from_room");
  fixture.guest.emit("kick_player", {
    roomCode: fixture.ownerData.roomCode,
    playerId: fixture.ownerData.playerId,
  });
  await kicked;
  assert.equal(
    getRoom(fixture.ownerData.roomCode).players.some(
      (player) => player.id === fixture.ownerData.playerId,
    ),
    false,
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.owner.connected, true);

  const refreshed = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => refreshed.close());
  await once(refreshed, "connect");
  const rejected = once(refreshed, "join_error");
  refreshed.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: fixture.ownerData.reconnectToken,
  });
  await rejected;
});

void test("uses an approved late player when an active player leaves at the round boundary", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const room = getRoom(fixture.ownerData.roomCode);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;

  const late = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => late.close());
  await once(late, "connect");
  const request = once(fixture.owner, "join_request");
  late.emit("join_room", { roomCode: room.code, displayName: "Replacement" });
  const { requestId } = await request;
  const joined = once(late, "join_success");
  fixture.owner.emit("approve_join_request", { roomCode: room.code, requestId });
  const lateData = await joined;

  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: room.code, clue: "boundary clue" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", { roomCode: room.code, angle: room.currentRound.targetAngle });
  await reveal;

  const departing = fixture.guest;
  const departed = onceWhere(
    fixture.owner,
    "player_disconnected",
    (data) => data.playerId === fixture.guestData.playerId,
  );
  departing.close();
  await departed;

  const nextRound = once(late, "round_start");
  fixture.owner.emit("next_round", { roomCode: room.code });
  const next = await nextRound;

  assert.equal(next.roundNumber, 2);
  assert.equal(room.status, "playing");
  assert.equal(
    room.players.find((player) => player.id === lateData.playerId)?.awaitingNextRound,
    false,
  );
});

void test("keeps an already submitted guess when that player disconnects before reveal", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  t.after(() => third.socket.close());
  const round = await startRound(fixture);
  const room = getRoom(fixture.ownerData.roomCode);
  const participants = [
    { socket: fixture.owner, data: fixture.ownerData },
    { socket: fixture.guest, data: fixture.guestData },
    third,
  ];
  const psychic = participants.find((candidate) => candidate.data.playerId === round.psychicId);
  const guessers = participants.filter((candidate) => candidate.data.playerId !== round.psychicId);

  const clue = once(required(guessers[0]).socket, "clue_broadcast");
  required(psychic).socket.emit("clue_submitted", { roomCode: room.code, clue: "disconnect clue" });
  await clue;

  required(guessers[0]).socket.emit("guess_submitted", {
    roomCode: room.code,
    angle: room.currentRound.targetAngle,
  });
  await onceWhere(
    required(psychic).socket,
    "player_guessed",
    (data) => data.playerId === required(guessers[0]).data.playerId,
  );
  const disconnected = onceWhere(
    required(psychic).socket,
    "player_disconnected",
    (data) => data.playerId === required(guessers[0]).data.playerId,
  );
  required(guessers[0]).socket.close();
  await disconnected;

  const reveal = once(required(psychic).socket, "reveal_phase");
  required(guessers[1]).socket.emit("guess_submitted", {
    roomCode: room.code,
    angle: room.currentRound.targetAngle,
  });
  const result = await reveal;

  assert.equal(result.guesses.length, 2);
  assert.equal(
    result.guesses.find((guess) => guess.playerId === required(guessers[0]).data.playerId)?.points,
    3,
  );
});

void test("restores an accepted late player to the next-round waiting state without live-round data", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  await startRound(fixture);

  const third = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => third.close());
  await once(third, "connect");
  const request = once(fixture.owner, "join_request");
  third.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Late" });
  const { requestId } = await request;
  const accepted = once(third, "join_success");
  fixture.owner.emit("approve_join_request", { roomCode: fixture.ownerData.roomCode, requestId });
  const lateData = await accepted;

  const refreshed = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => refreshed.close());
  await once(refreshed, "connect");
  const rejoined = once(refreshed, "reconnect_success");
  refreshed.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: lateData.reconnectToken,
  });
  const state = await rejoined;

  assert.equal(state.awaitingNextRound, true);
  assert.equal(state.currentRound, null);
  assert.equal(
    fixture.gameServer.io.sockets.adapter.rooms
      .get(fixture.ownerData.roomCode)
      ?.has(required(refreshed.id)) ?? false,
    false,
  );
});

void test("kicking the current psychic restarts a valid round for the remaining players", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => third.close());
  await once(third, "connect");
  const thirdJoined = once(third, "join_success");
  third.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Third" });
  const thirdData = await thirdJoined;

  const round = await startRound(fixture);
  const psychicIsOwner = round.psychicId === fixture.ownerData.playerId;
  const controller = psychicIsOwner ? fixture.guest : fixture.owner;
  const controllerData = psychicIsOwner ? fixture.guestData : fixture.ownerData;
  if (psychicIsOwner) {
    const transferred = once(controller, "ownership_transferred");
    fixture.owner.emit("transfer_ownership", {
      roomCode: fixture.ownerData.roomCode,
      playerId: controllerData.playerId,
    });
    await transferred;
  }

  const restarted = once(controller, "round_start");
  controller.emit("kick_player", {
    roomCode: fixture.ownerData.roomCode,
    playerId: round.psychicId,
  });
  const replacementRound = await restarted;
  const room = getRoom(fixture.ownerData.roomCode);
  assert.notEqual(replacementRound.psychicId, round.psychicId);
  assert.equal(
    room.players.some((player) => player.id === round.psychicId),
    false,
  );
  assert.equal(
    room.players.some((player) => player.id === thirdData.playerId),
    true,
  );
});

void test("synchronizes valid pack changes and rejects invalid or empty selections", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const room = getRoom(fixture.ownerData.roomCode);
  const updated = once(fixture.guest, "settings_updated");
  fixture.owner.emit("update_packs", {
    roomCode: room.code,
    selectedPackIds: ["core", "daily-life"],
  });
  assert.deepEqual((await updated).selectedPackIds, ["core", "daily-life"]);
  assert.deepEqual(room.selectedPackIds, ["core", "daily-life"]);

  fixture.owner.emit("update_packs", { roomCode: room.code, selectedPackIds: ["core", "friends"] });
  fixture.owner.emit("update_packs", { roomCode: room.code, selectedPackIds: [] });
  fixture.owner.emit("update_packs", { roomCode: room.code, selectedPackIds: ["unknown"] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(room.selectedPackIds, ["core", "daily-life"]);
});

void test("deduplicates card ratings and validates reveal-only reaction bursts", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;

  psychic.emit("send_reaction", { roomCode: fixture.ownerData.roomCode, reaction: "👍" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "clue" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;

  const ratingRecorded = once(guesser, "card_rating_recorded");
  guesser.emit("card_rating", { roomCode: fixture.ownerData.roomCode, vote: "up" });
  guesser.emit("card_rating", { roomCode: fixture.ownerData.roomCode, vote: "down" });
  assert.equal((await ratingRecorded).vote, "up");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const ratedRound = getRoom(fixture.ownerData.roomCode).currentRound;
  assert.equal(ratedRound.ratings.length, 1);
  assert.equal(
    required(ratedRound.ratings[0]).targetRegion,
    required(getTargetRegion(ratedRound.targetAngle)).id,
  );

  let reactions = 0;
  fixture.owner.on("reaction_received", () => {
    reactions++;
  });
  for (let index = 0; index < 6; index++) {
    guesser.emit("send_reaction", {
      roomCode: fixture.ownerData.roomCode,
      reaction: index === 5 ? "invalid" : "😂",
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reactions, 1);
});

void test("serves card-pack metadata with REST CORS for an allowed client origin", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const response = await fetch(`${fixture.url}/api/card-packs`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const payload = (await response.json()) as { packs: PublicPack[] };
  assert.equal(payload.packs.length, 3);
  assert.equal(
    payload.packs.some((pack) => pack.id === "friends"),
    false,
  );
});

void test("advances a revealed round when every connected player is ready", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;

  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "ready clue" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  const revealData = await reveal;
  assert.equal(required(revealData.readyState).requiredCount, 2);
  assert.ok(required(required(revealData.readyState).endsAt) > Date.now());

  const readyOne = onceWhere(
    fixture.owner,
    "round_ready_updated",
    (state) => state.readyCount === 1,
  );
  fixture.owner.emit("round_ready", { roomCode: fixture.ownerData.roomCode, ready: true });
  await readyOne;

  const nextRound = onceWhere(
    fixture.owner,
    "round_start",
    (data) => data.roundNumber === 2,
    2_000,
  );
  fixture.guest.emit("round_ready", { roomCode: fixture.ownerData.roomCode, ready: true });
  assert.equal((await nextRound).roundNumber, 2);
});

void test("advances a revealed round after the fallback countdown without owner input", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "automatic" });
  await clue;
  const nextRound = onceWhere(
    fixture.owner,
    "round_start",
    (data) => data.roundNumber === 2,
    2_000,
  );
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  assert.equal((await nextRound).roundNumber, 2);
});

void test("only the owner can pause the current revealed round", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "pause contract" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;

  const room = getRoom(fixture.ownerData.roomCode);
  fixture.guest.emit("set_round_pause", {
    roomCode: room.code,
    roundNumber: round.roundNumber,
    paused: true,
  });
  fixture.owner.emit("set_round_pause", {
    roomCode: room.code,
    roundNumber: round.roundNumber - 1,
    paused: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(room.roundAdvancePausedRemainingMs, null);

  const paused = onceWhere(fixture.guest, "round_ready_updated", (state) => state.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: room.code,
    roundNumber: round.roundNumber,
    paused: true,
  });
  const state = await paused;
  assert.equal(state.endsAt, null);
  assert.ok(required(state.remainingMs) > 0);
  assert.equal(room.timer, null);
  assert.ok(required(room.roundAdvancePausedRemainingMs) > 0);

  const frozenRemainingMs = state.remainingMs;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const resumed = onceWhere(fixture.guest, "round_ready_updated", (update) => !update.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: room.code,
    roundNumber: round.roundNumber,
    paused: false,
  });
  const resumedState = await resumed;
  const restoredRemainingMs = required(resumedState.endsAt) - Date.now();
  assert.ok(restoredRemainingMs >= required(frozenRemainingMs) - 100);
  assert.ok(restoredRemainingMs <= required(frozenRemainingMs) + 100);
  assert.equal(room.roundAdvancePausedRemainingMs, null);
});

void test("a spectator joining a paused reveal receives the frozen countdown state", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "spectator pause" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;

  const paused = onceWhere(fixture.guest, "round_ready_updated", (state) => state.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: true,
  });
  await paused;

  const spectator = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => spectator.close());
  await once(spectator, "connect");
  const watching = once(spectator, "watch_success");
  spectator.emit("watch_room", { roomCode: fixture.ownerData.roomCode });
  const snapshot = await watching;

  assert.deepEqual(snapshot.currentRound?.revealData?.readyState, snapshot.readyState);

  assert.equal(snapshot.readyState.paused, true);
  assert.equal(snapshot.readyState.endsAt, null);
  assert.ok(required(snapshot.readyState.remainingMs) > 0);
});

void test("ready votes cannot advance a paused round and resume uses the ready delay", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", {
    roomCode: fixture.ownerData.roomCode,
    clue: "ready while paused",
  });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;

  const paused = onceWhere(fixture.owner, "round_ready_updated", (state) => state.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: true,
  });
  await paused;
  fixture.owner.emit("round_ready", { roomCode: fixture.ownerData.roomCode, ready: true });
  fixture.guest.emit("round_ready", { roomCode: fixture.ownerData.roomCode, ready: true });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(getRoom(fixture.ownerData.roomCode).currentRound.roundNumber, 1);

  const nextRound = onceWhere(
    fixture.owner,
    "round_start",
    (data) => data.roundNumber === 2,
    2_000,
  );
  fixture.owner.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: false,
  });
  assert.equal((await nextRound).roundNumber, 2);
});

void test("the owner can explicitly advance a paused round", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "manual advance" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;

  const paused = onceWhere(fixture.guest, "round_ready_updated", (state) => state.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: true,
  });
  await paused;

  const nextRound = onceWhere(fixture.guest, "round_start", (data) => data.roundNumber === 2);
  fixture.owner.emit("next_round", { roomCode: fixture.ownerData.roomCode });
  assert.equal((await nextRound).roundNumber, 2);
  assert.equal(getRoom(fixture.ownerData.roomCode).roundAdvancePausedRemainingMs, null);
});

void test("disconnecting a host resumes a paused reveal countdown for the group", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "host leaves" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;

  const paused = onceWhere(fixture.guest, "round_ready_updated", (state) => state.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: true,
  });
  await paused;
  const resumed = onceWhere(fixture.guest, "round_ready_updated", (state) => !state.paused);
  fixture.owner.close();
  const state = await resumed;
  assert.ok(required(state.endsAt) > Date.now());
  assert.equal(getRoom(fixture.ownerData.roomCode).roundAdvancePausedRemainingMs, null);
});

void test("a guest reconnects into a paused reveal and ownership transfer preserves it", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", {
    roomCode: fixture.ownerData.roomCode,
    clue: "reconnect paused",
  });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  await reveal;
  const paused = onceWhere(fixture.owner, "round_ready_updated", (state) => state.paused);
  fixture.owner.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: true,
  });
  await paused;

  const disconnected = onceWhere(
    fixture.owner,
    "player_disconnected",
    (data) => data.playerId === fixture.guestData.playerId,
  );
  fixture.guest.close();
  await disconnected;
  const reconnected = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => reconnected.close());
  await once(reconnected, "connect");
  const rejoin = once(reconnected, "reconnect_success");
  reconnected.emit("reconnect_player", {
    roomCode: fixture.ownerData.roomCode,
    reconnectToken: fixture.guestData.reconnectToken,
  });
  const snapshot = await rejoin;
  assert.equal(snapshot.readyState.paused, true);
  assert.deepEqual(snapshot.currentRound?.revealData?.readyState, snapshot.readyState);
  assert.equal(snapshot.readyState.endsAt, null);
  assert.ok(required(snapshot.readyState.remainingMs) > 0);

  const transferred = onceWhere(
    reconnected,
    "ownership_transferred",
    (data) => data.ownerId === fixture.guestData.playerId,
  );
  fixture.owner.emit("transfer_ownership", {
    roomCode: fixture.ownerData.roomCode,
    playerId: fixture.guestData.playerId,
  });
  await transferred;
  assert.ok(required(getRoom(fixture.ownerData.roomCode).roundAdvancePausedRemainingMs) > 0);
  const resumed = onceWhere(fixture.owner, "round_ready_updated", (state) => !state.paused);
  reconnected.emit("set_round_pause", {
    roomCode: fixture.ownerData.roomCode,
    roundNumber: round.roundNumber,
    paused: false,
  });
  assert.ok(required((await resumed).endsAt) > Date.now());
});

void test("updates rematch progress when finished-room players disconnect, return, leave or are kicked", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  const fourth = await addFixturePlayer(fixture, "Fourth");
  t.after(() => {
    third.socket.close();
    fourth.socket.close();
  });
  const room = getRoom(fixture.ownerData.roomCode);
  room.status = "finished";
  const first = once(fixture.owner, "rematch_vote_updated");
  fixture.owner.emit("vote_rematch", { roomCode: room.code, vote: true });
  assert.equal((await first).requiredCount, 3);
  const disconnected = once(fixture.owner, "rematch_vote_updated");
  fourth.socket.disconnect();
  assert.equal((await disconnected).requiredCount, 2);
  const connected = once(fourth.socket, "connect");
  fourth.socket.connect();
  await connected;
  const restored = once(fixture.owner, "rematch_vote_updated");
  fourth.socket.emit("reconnect_player", {
    roomCode: room.code,
    reconnectToken: fourth.data.reconnectToken,
  });
  assert.equal((await restored).requiredCount, 3);
  const left = once(fixture.owner, "rematch_vote_updated");
  fixture.guest.emit("leave_room", { roomCode: room.code });
  fixture.guest.disconnect(); // Matches the client leave flow after leaving the room channel.
  assert.equal((await left).requiredCount, 2);
  const kicked = once(fixture.owner, "rematch_vote_updated");
  fixture.owner.emit("kick_player", { roomCode: room.code, playerId: third.data.playerId });
  assert.deepEqual(await kicked, {
    playerIds: [fixture.ownerData.playerId],
    voteCount: 1,
    requiredCount: 2,
  });
  assert.equal(room.status, "finished");
});

void test("uses a strict-majority rematch vote while retaining the owner override", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const round = await startRound(fixture);
  const room = getRoom(fixture.ownerData.roomCode);
  room.winningScore = 1;
  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(guesser, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: room.code, clue: "finish" });
  await clue;
  const reveal = once(fixture.owner, "reveal_phase");
  const initialRematch = once(fixture.owner, "rematch_vote_updated");
  guesser.emit("guess_submitted", { roomCode: room.code, angle: room.currentRound.targetAngle });
  await reveal;
  assert.deepEqual(await initialRematch, { playerIds: [], voteCount: 0, requiredCount: 2 });
  assert.equal(room.status, "finished");
  assert.equal(room.roundAdvancePausedRemainingMs, null);

  const firstVote = onceWhere(
    fixture.owner,
    "rematch_vote_updated",
    (state) => state.voteCount === 1,
  );
  fixture.owner.emit("vote_rematch", { roomCode: room.code, vote: true });
  const voteState = await firstVote;
  assert.equal(voteState.requiredCount, 2);
  assert.equal(room.status, "finished");

  const rematch = once(fixture.owner, "rematch_started");
  fixture.guest.emit("vote_rematch", { roomCode: room.code, vote: true });
  const rematchState = await rematch;
  assert.equal(room.status, "waiting");
  assert.equal(room.roundAdvancePausedRemainingMs, null);
  assert.deepEqual(
    rematchState.players.map((player) => player.score),
    [0, 0],
  );
});

void test("runs a shared-guess team round and rotates the active team", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  const fourth = await addFixturePlayer(fixture, "Fourth");
  t.after(() => {
    third.socket.close();
    fourth.socket.close();
  });

  const modeUpdated = onceWhere(
    fixture.owner,
    "settings_updated",
    (data) => data.gameMode === "teams",
  );
  fixture.owner.emit("update_game_mode", {
    roomCode: fixture.ownerData.roomCode,
    gameMode: "teams",
  });
  const mode = await modeUpdated;
  assert.equal(required(mode.teams).length, 2);
  assert.ok(
    required(mode.teams).every(
      (team) => required(mode.players).filter((player) => player.teamId === team.id).length === 2,
    ),
  );

  const ownerRound = once(fixture.owner, "round_start");
  fixture.owner.emit("start_game", { roomCode: fixture.ownerData.roomCode });
  const round = await ownerRound;
  assert.equal(round.gameMode, "teams");
  assert.ok(round.activeTeamId);
  assert.ok(round.controllerId);
  const room = getRoom(fixture.ownerData.roomCode);
  const clients = [
    { socket: fixture.owner, id: fixture.ownerData.playerId },
    { socket: fixture.guest, id: fixture.guestData.playerId },
    { socket: third.socket, id: third.data.playerId },
    { socket: fourth.socket, id: fourth.data.playerId },
  ];
  const psychic = clients.find((client) => client.id === round.psychicId);
  const controller = clients.find((client) => client.id === round.controllerId);
  const blocked = clients.find(
    (client) => client.id !== round.psychicId && client.id !== round.controllerId,
  );

  const clue = once(required(controller).socket, "clue_broadcast");
  required(psychic).socket.emit("clue_submitted", { roomCode: room.code, clue: "team clue" });
  await clue;
  required(blocked).socket.emit("guess_submitted", {
    roomCode: room.code,
    angle: room.currentRound.targetAngle,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(room.currentRound.guesses.length, 0);

  const reveal = once(fixture.owner, "reveal_phase");
  required(controller).socket.emit("guess_submitted", {
    roomCode: room.code,
    angle: room.currentRound.targetAngle,
  });
  const data = await reveal;
  assert.equal(data.gameMode, "teams");
  assert.equal(data.guesses.length, 1);
  assert.equal(required(data.guesses[0]).teamId, round.activeTeamId);
  assert.equal(required(data.updatedTeams.find((team) => team.id === round.activeTeamId)).score, 3);
  assert.equal(data.psychicPoints, null);

  const nextRound = onceWhere(fixture.owner, "round_start", (next) => next.roundNumber === 2);
  fixture.owner.emit("next_round", { roomCode: room.code });
  const next = await nextRound;
  assert.notEqual(next.activeTeamId, round.activeTeamId);
});

void test("declares joint winners when players tie above the target score", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  t.after(() => third.socket.close());
  const round = await startRound(fixture);
  const room = getRoom(fixture.ownerData.roomCode);
  room.winningScore = 10;
  const players = [
    { socket: fixture.owner, data: fixture.ownerData },
    { socket: fixture.guest, data: fixture.guestData },
    { socket: third.socket, data: third.data },
  ];
  const psychic = players.find((entry) => entry.data.playerId === round.psychicId);
  const guessers = players.filter((entry) => entry !== psychic);
  const clue = once(required(guessers[0]).socket, "clue_broadcast");
  required(psychic).socket.emit("clue_submitted", { roomCode: room.code, clue: "joint winners" });
  await clue;
  guessers.forEach((entry) => {
    required(room.players.find((player) => player.id === entry.data.playerId)).score = 9;
  });

  const reveal = once(fixture.owner, "reveal_phase");
  required(guessers[0]).socket.emit("guess_submitted", {
    roomCode: room.code,
    angle: room.currentRound.targetAngle,
  });
  required(guessers[1]).socket.emit("guess_submitted", {
    roomCode: room.code,
    angle: room.currentRound.targetAngle,
  });
  const data = await reveal;

  assert.equal(data.winners.length, 2);
  assert.deepEqual(
    new Set(data.winners.map((winner) => winner.playerId)),
    new Set(guessers.map((entry) => entry.data.playerId)),
  );
  assert.equal(required(data.winner).playerId, required(data.winners[0]).playerId);
});

void test("an expired controller disconnect cannot advance a newer team round", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const extraPlayers = await Promise.all([
    addFixturePlayer(fixture, "Third"),
    addFixturePlayer(fixture, "Fourth"),
    addFixturePlayer(fixture, "Fifth"),
    addFixturePlayer(fixture, "Sixth"),
  ]);
  t.after(() => {
    extraPlayers.forEach((entry) => entry.socket.close());
  });

  const modeUpdated = onceWhere(
    fixture.owner,
    "settings_updated",
    (data) => data.gameMode === "teams",
  );
  fixture.owner.emit("update_game_mode", {
    roomCode: fixture.ownerData.roomCode,
    gameMode: "teams",
  });
  await modeUpdated;
  const round = await startRound(fixture);
  const clients = [
    { socket: fixture.owner, id: fixture.ownerData.playerId },
    { socket: fixture.guest, id: fixture.guestData.playerId },
    ...extraPlayers.map((entry) => ({ socket: entry.socket, id: entry.data.playerId })),
  ];
  const controller = clients.find((entry) => entry.id === round.controllerId);
  const psychic = clients.find((entry) => entry.id === round.psychicId);

  const disconnected = onceWhere(
    fixture.owner,
    "player_disconnected",
    (data) => data.playerId === required(controller).id,
  );
  required(controller).socket.close();
  await disconnected;

  const nextRound = onceWhere(fixture.owner, "round_start", (data) => data.roundNumber === 2);
  // Voluntary skipping is gone, so the turn only ends through the automatic timeout path.
  const live = required(getRoom(fixture.ownerData.roomCode));
  assert.equal(advanceExpiredPsychicTurn(fixture.gameServer.io, live, required(psychic).id), true);
  await nextRound;
  await new Promise((resolve) => setTimeout(resolve, 330));

  assert.equal(getRoom(fixture.ownerData.roomCode).currentRound.roundNumber, 2);
});

void test("an approved late player receives terminal state when removals end the match", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  t.after(() => third.socket.close());
  await startRound(fixture);

  const late = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => late.close());
  await once(late, "connect");
  const requestReceived = once(fixture.owner, "join_request");
  late.emit("join_room", { roomCode: fixture.ownerData.roomCode, displayName: "Late" });
  const request = await requestReceived;
  const accepted = once(late, "join_success");
  fixture.owner.emit("approve_join_request", {
    roomCode: fixture.ownerData.roomCode,
    requestId: request.requestId,
  });
  const acceptedData = await accepted;

  const firstRemoval = onceWhere(
    fixture.owner,
    "player_removed",
    (data) => data.playerId === fixture.guestData.playerId,
  );
  fixture.owner.emit("kick_player", {
    roomCode: fixture.ownerData.roomCode,
    playerId: fixture.guestData.playerId,
  });
  await firstRemoval;

  const terminal = once(late, "game_over");
  fixture.owner.emit("kick_player", {
    roomCode: fixture.ownerData.roomCode,
    playerId: third.data.playerId,
  });
  const finalState = await terminal;

  assert.ok("reason" in finalState);
  assert.equal(finalState.reason, "لا يوجد لاعبون كافيون");
  assert.equal(
    required(
      getRoom(fixture.ownerData.roomCode).players.find(
        (player) => player.id === acceptedData.playerId,
      ),
    ).awaitingNextRound,
    false,
  );
});

void test("spectator state never exposes the secret target before reveal", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const spectator = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => spectator.close());
  await once(spectator, "connect");
  const watching = once(spectator, "watch_success");
  spectator.emit("watch_room", { roomCode: fixture.ownerData.roomCode });
  const initial = await watching;
  assert.equal(initial.currentRound, null);

  let leakedTarget = false;
  spectator.on("target_reveal", () => {
    leakedTarget = true;
  });
  const round = await startRound(fixture);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(leakedTarget, false);

  const psychic = round.psychicId === fixture.ownerData.playerId ? fixture.owner : fixture.guest;
  const guesser = psychic === fixture.owner ? fixture.guest : fixture.owner;
  const clue = once(spectator, "clue_broadcast");
  psychic.emit("clue_submitted", { roomCode: fixture.ownerData.roomCode, clue: "public clue" });
  await clue;
  const reveal = once(spectator, "reveal_phase");
  guesser.emit("guess_submitted", {
    roomCode: fixture.ownerData.roomCode,
    angle: getRoom(fixture.ownerData.roomCode).currentRound.targetAngle,
  });
  const revealData = await reveal;
  assert.ok(Number.isFinite(revealData.targetAngle));
  assert.equal(leakedTarget, false);
});

void test("shares team guess previews only with active teammates and spectators", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const third = await addFixturePlayer(fixture, "Third");
  const fourth = await addFixturePlayer(fixture, "Fourth");
  const fifth = await addFixturePlayer(fixture, "Fifth");
  const sixth = await addFixturePlayer(fixture, "Sixth");
  t.after(() => {
    third.socket.close();
    fourth.socket.close();
    fifth.socket.close();
    sixth.socket.close();
  });

  const spectator = createClient(fixture.url, { transports: ["websocket"], forceNew: true });
  t.after(() => spectator.close());
  await once(spectator, "connect");
  const watching = once(spectator, "watch_success");
  spectator.emit("watch_room", { roomCode: fixture.ownerData.roomCode });
  await watching;

  const modeUpdated = onceWhere(
    fixture.owner,
    "settings_updated",
    (data) => data.gameMode === "teams",
  );
  fixture.owner.emit("update_game_mode", {
    roomCode: fixture.ownerData.roomCode,
    gameMode: "teams",
  });
  await modeUpdated;
  const round = await startRound(fixture);
  const clients = [
    { socket: fixture.owner, id: fixture.ownerData.playerId },
    { socket: fixture.guest, id: fixture.guestData.playerId },
    { socket: third.socket, id: third.data.playerId },
    { socket: fourth.socket, id: fourth.data.playerId },
    { socket: fifth.socket, id: fifth.data.playerId },
    { socket: sixth.socket, id: sixth.data.playerId },
  ];
  const room = getRoom(fixture.ownerData.roomCode);
  const psychic = clients.find((entry) => entry.id === round.psychicId);
  const controller = clients.find((entry) => entry.id === round.controllerId);
  const teammate = clients.find(
    (entry) =>
      entry.id !== round.controllerId &&
      entry.id !== round.psychicId &&
      room.players.find((player) => player.id === entry.id)?.teamId === round.activeTeamId,
  );
  const opponent = clients.find(
    (entry) => room.players.find((player) => player.id === entry.id)?.teamId !== round.activeTeamId,
  );
  const clue = once(required(controller).socket, "clue_broadcast");
  required(psychic).socket.emit("clue_submitted", { roomCode: room.code, clue: "preview clue" });
  await clue;

  let opponentSawPreview = false;
  required(opponent).socket.on("team_guess_preview", () => {
    opponentSawPreview = true;
  });
  let teammateSawInvalidPreview = false;
  required(teammate).socket.on("team_guess_preview", () => {
    teammateSawInvalidPreview = true;
  });
  required(opponent).socket.emit("guess_preview", {
    roomCode: room.code,
    angle: 80,
    roundNumber: round.roundNumber,
  });
  required(controller).socket.emit("guess_preview", {
    roomCode: room.code,
    angle: 81,
    roundNumber: round.roundNumber - 1,
  });
  required(controller).socket.emit("guess_preview", {
    roomCode: room.code,
    angle: 181,
    roundNumber: round.roundNumber,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(teammateSawInvalidPreview, false);
  required(teammate).socket.removeAllListeners("team_guess_preview");
  const teammatePreview = once(required(teammate).socket, "team_guess_preview");
  const spectatorPreview = once(spectator, "team_guess_preview");
  required(controller).socket.emit("guess_preview", {
    roomCode: room.code,
    angle: 123,
    roundNumber: round.roundNumber,
  });
  const [teamData, spectatorData] = await Promise.all([teammatePreview, spectatorPreview]);

  assert.equal(teamData.angle, 123);
  assert.equal(teamData.roundNumber, round.roundNumber);
  assert.deepEqual(spectatorData, teamData);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(opponentSawPreview, false);
});
