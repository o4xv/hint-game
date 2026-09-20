import test from "node:test";
import assert from "node:assert/strict";
import { createServerReadiness, SERVER_READINESS } from "../src/session/readiness.ts";

class FakeSocket {
  constructor() {
    this.connected = false;
    this.active = false;
    this.handlers = new Map();
    this.connectCalls = 0;
    this.disconnectCalls = 0;
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emitLocal(event) {
    this.handlers.get(event)?.forEach((handler) => handler());
  }

  connect() {
    this.connectCalls += 1;
    this.active = true;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.active = false;
    if (this.connected) {
      this.connected = false;
      this.emitLocal("disconnect");
    }
  }

  becomeConnected() {
    this.connected = true;
    this.emitLocal("connect");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixture({ online = true, wakeDelayMs = 8, unavailableAfterMs = 30, fetchImpl } = {}) {
  const socket = new FakeSocket();
  const windowHandlers = new Map();
  let onlineValue = online;
  const readiness = createServerReadiness({
    socket,
    healthUrl: "https://example.test/health",
    fetchImpl: fetchImpl || (() => new Promise(() => {})),
    isOnline: () => onlineValue,
    addWindowListener: (event, handler) => windowHandlers.set(event, handler),
    removeWindowListener: (event) => windowHandlers.delete(event),
    wakeDelayMs,
    unavailableAfterMs,
    probeRetryMs: 5,
  });
  return {
    socket,
    readiness,
    setOnline(value) {
      onlineValue = value;
      windowHandlers.get(value ? "online" : "offline")?.();
    },
  };
}

test("moves through offline, connecting, waking, and ready states", async () => {
  const { readiness, socket, setOnline } = fixture({ online: false });
  readiness.start();
  assert.equal(readiness.getStatus(), SERVER_READINESS.OFFLINE);

  setOnline(true);
  assert.equal(readiness.getStatus(), SERVER_READINESS.CONNECTING);
  await delay(12);
  assert.equal(readiness.getStatus(), SERVER_READINESS.WAKING);

  socket.becomeConnected();
  readiness.connectionChanged(true);
  assert.equal(readiness.getStatus(), SERVER_READINESS.READY);
  readiness.stop();
});

test("declares the server unavailable after the bounded wake window", async () => {
  const { readiness } = fixture({ wakeDelayMs: 3, unavailableAfterMs: 14 });
  readiness.start();
  await delay(18);
  assert.equal(readiness.getStatus(), SERVER_READINESS.UNAVAILABLE);
  assert.equal(await readiness.waitUntilReady(), false);
  readiness.stop();
});

test("start is idempotent and retry cancels the previous health probe", () => {
  const signals = [];
  const { readiness, socket } = fixture({
    fetchImpl: (_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    },
  });
  readiness.start();
  readiness.start();
  assert.equal(socket.connectCalls, 1);
  assert.equal(signals.length, 1);

  readiness.retry();
  assert.equal(signals[0].aborted, true);
  assert.equal(socket.connectCalls, 2);
  assert.equal(signals.length, 2);
  readiness.stop();
});

test("waitUntilReady resolves when the socket connects", async () => {
  const { readiness, socket } = fixture();
  readiness.start();
  const waiting = readiness.waitUntilReady({ timeoutMs: 50 });
  socket.becomeConnected();
  readiness.connectionChanged(true);
  assert.equal(await waiting, true);
  readiness.stop();
});

test("does not compete with Socket.IO while automatic reconnection is active", () => {
  const { readiness, socket } = fixture();
  readiness.start();
  assert.equal(socket.connectCalls, 1);
  socket.connected = false;
  socket.active = true;
  socket.emitLocal("disconnect");
  readiness.connectionChanged(false);
  assert.equal(socket.connectCalls, 1);
  readiness.stop();
});
