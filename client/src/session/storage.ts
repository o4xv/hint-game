import type { createSessionStore } from "./store";

export function attachSessionPersistence(
  store: ReturnType<typeof createSessionStore>,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  let previous = store.getSnapshot();
  const unsubscribe = store.subscribe((action) => {
    const next = store.getSnapshot();
    const before = previous;
    previous = next;
    if (next.isSpectator || (action.type === "server" && action.event === "session_replaced"))
      return;
    const record = readRecord(storage);
    const stored = record && credentials(record);
    const now = Date.now();
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
        before.isOwner !== next.isOwner ||
        (next.connection === "connected" &&
          (!record?.lastActiveAt || now - record.lastActiveAt >= SESSION_REFRESH_MS))
      )
        writeSession(storage, next, now);
    } else if (isSavedSession(before) && stored && sameIdentity(stored, before)) {
      writeSession(storage, next);
    }
  });
  // A connected, quiet lobby or a long match must not expire just because no state changed.
  const refresh = setInterval(() => {
    const state = store.getSnapshot();
    if (state.connection !== "connected" || state.isSpectator || !isSavedSession(state)) return;
    const record = readRecord(storage);
    if (record && sameIdentity(record, state)) writeSession(storage, state);
  }, SESSION_REFRESH_MS);
  return () => {
    unsubscribe();
    clearInterval(refresh);
  };
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
export const SESSION_MAX_INACTIVE_MS = 30 * 60_000;
const SESSION_REFRESH_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;

type StoredSession = SavedSession & { lastActiveAt: number | null };

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

function readRecord(storage: Pick<Storage, "getItem">): StoredSession | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SESSION_KEY) ?? "null");
    if (!isSavedSession(value)) return null;
    const lastActiveAt = "lastActiveAt" in value ? value.lastActiveAt : null;
    return {
      roomCode: value.roomCode,
      playerId: value.playerId,
      reconnectToken: value.reconnectToken,
      displayName: value.displayName,
      isOwner: value.isOwner,
      lastActiveAt: typeof lastActiveAt === "number" ? lastActiveAt : null,
    };
  } catch {
    return null;
  }
}

function credentials(record: StoredSession): SavedSession {
  const { roomCode, playerId, reconnectToken, displayName, isOwner } = record;
  return { roomCode, playerId, reconnectToken, displayName, isOwner };
}

function isRecent(record: StoredSession, now: number) {
  const activeAt = record.lastActiveAt;
  return (
    activeAt !== null &&
    Number.isFinite(activeAt) &&
    activeAt > 0 &&
    activeAt <= now + CLOCK_SKEW_MS &&
    now - activeAt <= SESSION_MAX_INACTIVE_MS
  );
}

/** Storage may be unavailable or contain data from an interrupted/older session. */
export function readSession(
  storage: Pick<Storage, "getItem">,
  now = Date.now(),
): SavedSession | null {
  const record = readRecord(storage);
  return record && isRecent(record, now) ? credentials(record) : null;
}

/** A stale PWA session must not reopen its old room link or attempt recovery. */
export function restoreSession(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): { session: SavedSession | null; staleRoomCode: string | null } {
  const record = readRecord(storage);
  if (!record) return { session: null, staleRoomCode: null };
  if (isRecent(record, now)) return { session: credentials(record), staleRoomCode: null };
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    // A blocked storage area must not prevent a fresh visit.
  }
  return { session: null, staleRoomCode: record.roomCode };
}

export function writeSession(
  storage: Pick<Storage, "setItem" | "removeItem">,
  session: SessionToPersist,
  now = Date.now(),
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
    storage.setItem(SESSION_KEY, JSON.stringify({ ...saved, lastActiveAt: now }));
  } catch {
    // An unavailable storage area must not prevent playing in this tab.
  }
}
