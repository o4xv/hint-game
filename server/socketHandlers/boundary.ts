import { parseIncoming, type ParsedIncoming } from "@hint/contracts/schemas";
import type { IncomingEvent } from "@hint/contracts";
import type { GameSocket } from "../types.js";
import { getRoom } from "../roomManager.js";
import { captureException } from "../telemetry.js";

const REQUEST_ID_MAX_LENGTH = 128;

/**
 * A correlated action cannot trust an unparsed payload, but a request id that already looks
 * like a bounded identifier is safe to echo so the requesting client can match the rejection
 * to the action it is waiting on.
 */
function extractRequestId(event: IncomingEvent, payload: unknown): string | undefined {
  if (event !== "redraw_target") return undefined;
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>).requestId;
  if (typeof value !== "string" || value.length === 0 || value.length > REQUEST_ID_MAX_LENGTH)
    return undefined;
  return value;
}

/** Socket payloads remain unknown until this event-specific schema succeeds. */
export function onAction<K extends IncomingEvent>(
  socket: GameSocket,
  event: K,
  handler: (payload: ParsedIncoming<K>) => void | Promise<void>,
): void {
  // Socket.IO's reserved-event conditional does not distribute generic event keys.
  const subscribe: (name: IncomingEvent, listener: (payload: unknown) => void) => GameSocket =
    socket.on.bind(socket);
  subscribe(event, (payload: unknown) => {
    const parsed = parseIncoming(event, payload);
    if (!parsed.success) {
      const requestId = extractRequestId(event, payload);
      socket.emit("action_error", {
        event,
        code: "INVALID_PAYLOAD",
        ...(requestId ? { requestId } : {}),
      });
      if (event === "guess_submitted") {
        const context = parseIncoming("watch_room", payload);
        const roundNumber = context.success
          ? (getRoom(context.data.roomCode)?.currentRound.roundNumber ?? null)
          : null;
        socket.emit("guess_rejected", { roundNumber, reason: "INVALID_ANGLE" });
      }
      const invalidName = parsed.error.issues.some((issue) => issue.path[0] === "displayName");
      const invalidScore = parsed.error.issues.some((issue) => issue.path[0] === "winningScore");
      if (event === "create_room" || event === "join_room" || event === "reconnect_player")
        socket.emit("join_error", {
          message: invalidName
            ? "الاسم يحتوي على أحرف غير مسموحة"
            : event === "create_room" && invalidScore
              ? "خيار هدف الفوز غير صالح"
              : "بيانات غير صالحة",
          ...(event === "reconnect_player" ? { code: "INVALID_RECONNECT" } : {}),
        });
      if (event === "watch_room") socket.emit("watch_error", { message: "الغرفة غير موجودة" });
      return;
    }
    const data = parsed.data;
    if ("roomCode" in data && "roundNumber" in data && data.roundNumber !== undefined) {
      const room = getRoom(data.roomCode);
      if (room && room.currentRound.roundNumber !== data.roundNumber) {
        socket.emit("action_error", {
          event,
          code: "STALE_ROUND",
          ...("requestId" in data && typeof data.requestId === "string"
            ? { requestId: data.requestId }
            : {}),
        });
        return;
      }
    }
    try {
      const result = handler(data);
      if (result instanceof Promise)
        void result.catch((error: unknown) => {
          captureException(error);
        });
    } catch (error) {
      captureException(error);
    }
  });
}
