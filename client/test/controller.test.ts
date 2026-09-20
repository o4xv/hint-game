import { describe, expect, it, vi, afterEach } from "vitest";
import type { IncomingEvent, IncomingPayloads, ServerToClientEvents } from "@hint/contracts";
import { createSessionController, type SessionTransport } from "../src/session/controller";
import { createSessionStore, initialSession } from "../src/session/store";
import { createServerReadiness } from "../src/session/readiness";

function transportFixture() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const connections = new Set<(connected: boolean) => void>();
  const sent: { event: IncomingEvent; payload: IncomingPayloads[IncomingEvent] }[] = [];
  const transport: SessionTransport = {
    connected: true,
    active: false,
    on(event, callback) {
      const set = handlers.get(event) ?? new Set();
      set.add(callback as (data: unknown) => void);
      handlers.set(event, set);
    },
    off(event, callback) {
      handlers.get(event)?.delete(callback as (data: unknown) => void);
    },
    onConnection(callback) {
      connections.add(callback);
      return () => {
        connections.delete(callback);
      };
    },
    emit(event, payload) {
      sent.push({ event, payload });
    },
    connect: vi.fn(),
  };
  return {
    transport,
    sent,
    connection(connected: boolean) {
      for (const listener of connections) listener(connected);
    },
    receive<Event extends keyof ServerToClientEvents>(
      event: Event,
      ...args: Parameters<ServerToClientEvents[Event]>
    ) {
      for (const handler of handlers.get(event) ?? []) handler(args[0]);
    },
    listenerCount: () =>
      [...handlers.values()].reduce((count, handlers) => count + handlers.size, connections.size),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session controller lifecycle", () => {
  it("owns readiness lifecycle and preserves snapshot recovery through connection notifications", async () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const store = createSessionStore({ ...initialSession(), roomCode: "ABCD", isSpectator: true });
    const addWindowListener = vi.fn();
    const removeWindowListener = vi.fn();
    const readiness = createServerReadiness({
      socket: { ...fixture.transport, disconnect: vi.fn() },
      healthUrl: "/health",
      fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
      isOnline: () => true,
      addWindowListener,
      removeWindowListener,
    });
    const controller = createSessionController({ transport: fixture.transport, store, readiness });
    controller.start();
    controller.start();
    expect(addWindowListener).toHaveBeenCalledTimes(2);
    const pending = controller.recover();
    fixture.connection(false);
    fixture.connection(true);
    expect(store.getSnapshot().connection).toBe("recovering");
    controller.stop();
    expect(removeWindowListener).toHaveBeenCalledTimes(2);
    expect(fixture.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });
  it("keeps recovery pending when the transport reconnects before the snapshot arrives", async () => {
    const fixture = transportFixture();
    const store = createSessionStore({ ...initialSession(), roomCode: "ABCD", isSpectator: true });
    const controller = createSessionController({ transport: fixture.transport, store });
    controller.start();
    const recovery = controller.recover();
    fixture.connection(false);
    fixture.connection(true);
    expect(store.getSnapshot().connection).toBe("recovering");
    expect(fixture.sent.filter((message) => message.event === "watch_room")).toHaveLength(2);
    controller.stop();
    await recovery;
  });
  it("does not restart an automatic socket reconnection on foreground recovery", async () => {
    const fixture = transportFixture();
    const connect = vi.fn();
    const transport = { ...fixture.transport, connect, connected: false, active: true };
    const store = createSessionStore({ ...initialSession(), roomCode: "ABCD", isSpectator: true });
    const controller = createSessionController({ transport, store });
    controller.start();
    const pending = controller.recover();
    expect(connect).not.toHaveBeenCalled();
    controller.stop();
    await pending;
  });
  it("ignores a late snapshot for a different room during recovery", async () => {
    const fixture = transportFixture();
    const store = createSessionStore({ ...initialSession(), roomCode: "ABCD", isSpectator: true });
    const controller = createSessionController({ transport: fixture.transport, store });
    controller.start();
    const recovery = controller.recover();
    fixture.receive("watch_success", {
      roomCode: "WXYZ",
      status: "waiting",
      redrawAvailable: true,
      winningScore: 20,
      players: [],
      gameMode: "individual",
      teamCount: 2,
      teams: [],
      currentRound: null,
      finalState: null,
      readyState: {
        playerIds: [],
        readyCount: 0,
        requiredCount: 0,
        paused: false,
        endsAt: null,
        remainingMs: null,
      },
    });
    expect(store.getSnapshot().roomCode).toBe("ABCD");
    controller.stop();
    await expect(recovery).resolves.toBe(false);
  });
  it("subscribes once and removes all listeners when stopped, including repeated mounts", () => {
    const fixture = transportFixture();
    const store = createSessionStore();
    const controller = createSessionController({ transport: fixture.transport, store });
    controller.start();
    const count = fixture.listenerCount();
    expect(count).toBeGreaterThan(20);
    controller.start();
    expect(fixture.listenerCount()).toBe(count);
    fixture.receive("ownership_transferred", { ownerId: "one" });
    for (let index = 0; index < 20; index++) {
      controller.stop();
      expect(fixture.listenerCount()).toBe(0);
      controller.start();
      expect(fixture.listenerCount()).toBe(count);
    }
    controller.stop();
    expect(fixture.listenerCount()).toBe(0);
  });

  it("deduplicates spectator recovery and resolves when a fresh watch snapshot arrives", async () => {
    const fixture = transportFixture();
    const store = createSessionStore({ ...initialSession(), roomCode: "ABCD", isSpectator: true });
    const controller = createSessionController({ transport: fixture.transport, store });
    controller.start();
    const first = controller.recover();
    const second = controller.recover();
    expect(second).toBe(first);
    expect(fixture.sent.map((message) => message.event)).toEqual(["watch_room"]);
    fixture.receive("watch_success", {
      roomCode: "ABCD",
      status: "waiting",
      redrawAvailable: true,
      winningScore: 20,
      players: [],
      gameMode: "individual",
      teamCount: 2,
      teams: [],
      currentRound: null,
      finalState: null,
      readyState: {
        playerIds: [],
        readyCount: 0,
        requiredCount: 0,
        paused: false,
        endsAt: null,
        remainingMs: null,
      },
    });
    await expect(first).resolves.toBe(true);
    controller.stop();
  });

  it("times out without erasing credentials and cancels the recovery timer on stop", async () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const store = createSessionStore({
      ...initialSession(),
      roomCode: "ABCD",
      playerId: "one",
      reconnectToken: "token",
    });
    const controller = createSessionController({ transport: fixture.transport, store });
    controller.start();
    const recovery = controller.recover();
    vi.advanceTimersByTime(10_000);
    await expect(recovery).resolves.toBe(false);
    expect(store.getSnapshot().reconnectToken).toBe("token");
    expect(store.getSnapshot().connection).toBe("unavailable");
    const next = controller.recover();
    controller.stop();
    await expect(next).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
