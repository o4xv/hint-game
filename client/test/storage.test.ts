import { describe, expect, it } from "vitest";
import {
  readSession,
  restoreSession,
  SESSION_MAX_INACTIVE_MS,
  writeSession,
} from "../src/session/storage";

const saved = {
  roomCode: "ABCD",
  playerId: "one",
  reconnectToken: "token",
  displayName: "اسم",
  isOwner: true,
};

describe("session storage boundary", () => {
  it("round trips established credentials and persists no extra game state", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    writeSession(storage, { ...saved, ...{ targetAngle: 50 } }, 1_000_000);
    expect(memory.get("hint_session")).toBe(JSON.stringify({ ...saved, lastActiveAt: 1_000_000 }));
    expect(readSession(storage, 1_000_000)).toEqual(saved);
    writeSession(storage, { ...saved, reconnectToken: null });
    expect(memory.has("hint_session")).toBe(false);
  });

  it("starts fresh after inactivity and removes the stale room link's credentials", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    const startedAt = 1_000_000;
    writeSession(storage, saved, startedAt);
    expect(restoreSession(storage, startedAt + SESSION_MAX_INACTIVE_MS)).toEqual({
      session: saved,
      staleRoomCode: null,
    });
    expect(restoreSession(storage, startedAt + SESSION_MAX_INACTIVE_MS + 1)).toEqual({
      session: null,
      staleRoomCode: "ABCD",
    });
    expect(memory.has("hint_session")).toBe(false);
  });

  it("does not resume an untimestamped legacy session or one dated far in the future", () => {
    const removed: string[] = [];
    const storage = {
      getItem: () => JSON.stringify(saved),
      removeItem: (key: string) => {
        removed.push(key);
      },
    };
    expect(restoreSession(storage, 1_000_000).staleRoomCode).toBe("ABCD");
    expect(removed).toEqual(["hint_session"]);
    expect(
      restoreSession(
        { ...storage, getItem: () => JSON.stringify({ ...saved, lastActiveAt: null }) },
        1_000_000,
      ).staleRoomCode,
    ).toBe("ABCD");
    expect(
      readSession(
        { getItem: () => JSON.stringify({ ...saved, lastActiveAt: 1_060_001 }) },
        1_000_000,
      ),
    ).toBeNull();
  });

  it("rejects corrupt and incorrectly shaped credentials", () => {
    for (const value of [
      null,
      [],
      {},
      { ...saved, roomCode: "../x" },
      { ...saved, isOwner: "true" },
      { ...saved, playerId: "" },
      { ...saved, reconnectToken: "x".repeat(513) },
    ]) {
      expect(readSession({ getItem: () => JSON.stringify(value) })).toBeNull();
    }
    expect(readSession({ getItem: () => "{" })).toBeNull();
  });

  it("survives denied reads and writes", () => {
    const fail = () => {
      throw new Error("Storage blocked");
    };
    expect(readSession({ getItem: fail })).toBeNull();
    expect(() => {
      writeSession({ setItem: fail, removeItem: fail }, saved);
    }).not.toThrow();
    expect(() => {
      writeSession({ setItem: fail, removeItem: fail }, { ...saved, playerId: null });
    }).not.toThrow();
  });
});
