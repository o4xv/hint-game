import type { createSessionStore } from "./store";

export function attachSessionPersistence(
  store: ReturnType<typeof createSessionStore>,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  let previous = store.getSnapshot();
  return store.subscribe((action) => {
    const next = store.getSnapshot();
    const before = previous;
    previous = next;
    if (next.isSpectator || (action.type === "server" && action.event === "session_replaced"))
      return;
    const stored = readSession(storage);
    if (isSavedSession(next)) {
      const acquired =
        action.type === "server" &&
        ["room_created", "join_success", "reconnect_success"].includes(action.event);
      if (!acquired && isSavedSession(before) && stored && !sameIdentity(stored, before)) return;
      if (
        acquired ||
        !isSavedSession(before) ||
        !sameIdentity(before, next) ||
        before.displayName !== next.displayName ||
        before.isOwner !== next.isOwner
      )
        writeSession(storage, next);
    } else if (isSavedSession(before) && stored && sameIdentity(stored, before)) {
      writeSession(storage, next);
    }
  });
}

function sameIdentity(first: SavedSession, second: SavedSession) {
  return (
    first.roomCode === second.roomCode &&
    first.playerId === second.playerId &&
    first.reconnectToken === second.reconnectToken
  );
}

export interface SavedSession {
  roomCode: string;
  playerId: string;
  reconnectToken: string;
  displayName: string | null;
  isOwner: boolean;
}

type SessionToPersist = {
  [Key in keyof SavedSession]: SavedSession[Key] | null;
};

const SESSION_KEY = "hint_session";

function isSavedSession(value: unknown): value is SavedSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.roomCode === "string" &&
    /^[A-Z0-9]{4}$/.test(session.roomCode) &&
    typeof session.playerId === "string" &&
    session.playerId.length > 0 &&
    session.playerId.length <= 256 &&
    typeof session.reconnectToken === "string" &&
    session.reconnectToken.length > 0 &&
    session.reconnectToken.length <= 512 &&
    (session.displayName === null ||
      (typeof session.displayName === "string" && session.displayName.length <= 256)) &&
    typeof session.isOwner === "boolean"
  );
}

/** Storage may be unavailable or contain data from an interrupted/older session. */
export function readSession(storage: Pick<Storage, "getItem">): SavedSession | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SESSION_KEY) ?? "null");
    if (!isSavedSession(value)) return null;
    return {
      roomCode: value.roomCode,
      playerId: value.playerId,
      reconnectToken: value.reconnectToken,
      displayName: value.displayName,
      isOwner: value.isOwner,
    };
  } catch {
    return null;
  }
}

export function writeSession(
  storage: Pick<Storage, "setItem" | "removeItem">,
  session: SessionToPersist,
): void {
  try {
    if (!isSavedSession(session)) {
      storage.removeItem(SESSION_KEY);
      return;
    }
    const saved: SavedSession = {
      roomCode: session.roomCode,
      playerId: session.playerId,
      reconnectToken: session.reconnectToken,
      displayName: session.displayName,
      isOwner: session.isOwner,
    };
    storage.setItem(SESSION_KEY, JSON.stringify(saved));
  } catch {
    // An unavailable storage area must not prevent playing in this tab.
  }
}
