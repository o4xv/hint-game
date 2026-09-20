import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { createGameServer } from "../index.js";
import {
  buildGameplayCapture,
  getTelemetryDistinctId,
  getTelemetryHealth,
  sanitizeTelemetryProperties,
  redactRequestUrl,
} from "../telemetry.js";

void test("redacts room routes from server error URLs", () => {
  assert.equal(redactRequestUrl("/api/room/ABCD/exists?source=client"), "/api/room/:code/exists");
});

void test("telemetry keeps approved match data and strips player content", () => {
  const properties = sanitizeTelemetryProperties({
    winningScore: 20,
    durationMs: 12_345,
    roundNumber: 4,
    cardId: "core-12",
    targetRegion: "inner-left",
    displayName: "Private name",
    roomCode: "ABCD",
    clue: "Private clue",
    reconnectToken: "secret",
    socketId: "socket-secret",
  });

  assert.equal(properties.winningScore, 20);
  assert.equal(properties.durationMs, 12_345);
  assert.equal(properties.cardId, "core-12");
  assert.equal(properties.displayName, undefined);
  assert.equal(properties.roomCode, undefined);
  assert.equal(properties.clue, undefined);
  assert.equal(properties.reconnectToken, undefined);
  assert.equal(properties.socketId, undefined);
});

void test("room identity consistently groups lifecycle and player actions", () => {
  const roomOwner = getTelemetryDistinctId({ roomId: "ROOM", playerId: "owner" });
  const roomGuest = getTelemetryDistinctId({ roomId: "ROOM", playerId: "guest" });
  const otherRoom = getTelemetryDistinctId({ roomId: "NEXT", playerId: "owner" });

  assert.equal(roomOwner, roomGuest);
  assert.notEqual(roomOwner, otherRoom);
  assert.equal(roomOwner.includes("ROOM"), false);
});

void test("game completion captures anonymous duration and score settings", () => {
  const capture = buildGameplayCapture("game_completed", {
    roomId: "ROOM",
    playerId: "owner",
    durationMs: 91_000,
    winningScore: 10,
    playerCount: 3,
    roundNumber: 5,
    gameMode: "individual",
    displayName: "Must not leave the server",
  });

  assert.equal(capture.event, "game_completed");
  assert.equal(capture.properties.durationMs, 91_000);
  assert.equal(capture.properties.winningScore, 10);
  assert.equal(capture.properties.displayName, undefined);
});

void test("health exposes configuration states without telemetry secrets", async () => {
  const gameServer = createGameServer({ startCleanup: false });
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", resolve));
  const { port } = gameServer.server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "http://localhost:5173", Accept: "application/json" },
    });
    const health = (await response.json()) as {
      status: string;
      telemetry: ReturnType<typeof getTelemetryHealth>;
    };
    assert.equal(health.status, "ok");
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.deepEqual(health.telemetry, getTelemetryHealth());
    assert.ok(["configured", "disabled"].includes(health.telemetry.posthog));
    assert.ok(["configured", "disabled"].includes(health.telemetry.sentry));
    assert.equal(JSON.stringify(health).includes("dsn"), false);
    assert.equal(JSON.stringify(health).includes("key"), false);
  } finally {
    await gameServer.io.close();
  }
});
