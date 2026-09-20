import { describe, expect, it } from "vitest";
import { readSession, writeSession } from "../src/session/storage";

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
    writeSession(storage, { ...saved, ...{ targetAngle: 50 } });
    expect(memory.get("hint_session")).toBe(JSON.stringify(saved));
    expect(readSession(storage)).toEqual(saved);
    writeSession(storage, { ...saved, reconnectToken: null });
    expect(memory.has("hint_session")).toBe(false);
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
