import { expect, it } from "vitest";
import { attachSessionPersistence, readSession, writeSession } from "../src/session/storage";
import { createSessionStore, initialSession } from "../src/session/store";

const saved = {
  roomCode: "ABCD",
  playerId: "one",
  reconnectToken: "token",
  displayName: "لاعب",
  isOwner: true,
};
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  writeSession(storage, saved);
  return storage;
}

it("does not erase another tab's player session when a spectator connects or leaves", () => {
  const storage = fixture();
  const store = createSessionStore({ ...initialSession(), roomCode: "ABCD", isSpectator: true });
  const stop = attachSessionPersistence(store, storage);
  store.dispatch({ type: "connection", status: "connected" });
  expect(readSession(storage)).toEqual(saved);
  store.dispatch({ type: "reset" });
  expect(readSession(storage)).toEqual(saved);
  stop();
});

it("persists acquired credentials and ownership changes, then stops writing after disposal", () => {
  const storage = fixture();
  const store = createSessionStore(initialSession());
  const stop = attachSessionPersistence(store, storage);
  const next = { ...saved, playerId: "new-player", reconnectToken: "new-secret" };
  store.dispatch({ type: "identity", data: next });
  expect(readSession(storage)).toEqual(next);
  store.dispatch({ type: "identity", data: { isOwner: false } });
  expect(readSession(storage)).toEqual({ ...next, isOwner: false });
  stop();
  store.dispatch({ type: "reset" });
  expect(readSession(storage)).toEqual({ ...next, isOwner: false });
});

it("keeps playing when the storage area is unavailable", () => {
  const denied = () => {
    throw new DOMException("Denied", "SecurityError");
  };
  const store = createSessionStore(initialSession());
  const stop = attachSessionPersistence(store, {
    getItem: denied,
    setItem: denied,
    removeItem: denied,
  });
  expect(() => {
    store.dispatch({ type: "identity", data: saved });
  }).not.toThrow();
  expect(store.getSnapshot().playerId).toBe(saved.playerId);
  expect(() => {
    store.dispatch({ type: "reset" });
  }).not.toThrow();
  stop();
});

it("preserves credentials when another tab takes over the same player", () => {
  const storage = fixture();
  const store = createSessionStore({ ...initialSession(), ...saved });
  const stop = attachSessionPersistence(store, storage);
  store.dispatch({ type: "server", event: "session_replaced", data: undefined });
  store.dispatch({ type: "connection", status: "connected" });
  expect(readSession(storage)).toEqual(saved);
  stop();
});

it("clears this player's credentials on reset but preserves a newer player's session", () => {
  const storage = fixture();
  const store = createSessionStore({ ...initialSession(), ...saved });
  const stop = attachSessionPersistence(store, storage);
  store.dispatch({ type: "reset" });
  expect(readSession(storage)).toBeNull();
  stop();
  const oldTab = createSessionStore({ ...initialSession(), ...saved });
  const stopOld = attachSessionPersistence(oldTab, storage);
  const newer = { ...saved, playerId: "two", reconnectToken: "new-token" };
  writeSession(storage, newer);
  oldTab.dispatch({ type: "connection", status: "offline" });
  oldTab.dispatch({ type: "reset" });
  expect(readSession(storage)).toEqual(newer);
  stopOld();
});
