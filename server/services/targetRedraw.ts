import { TARGET_REDRAWS_PER_MATCH, type TargetRedrawState } from "@hint/contracts";
import type { Room } from "../types.js";

/**
 * The identity that owns this turn's answer-position allowance: the clue giver in individual
 * mode, the active team in team mode. The allowance never follows a socket or a browser tab.
 */
export function targetRedrawOwner(room: Room): string | null {
  return room.gameMode === "teams" ? room.currentRound.activeTeamId : room.currentRound.psychicId;
}

export function targetRedrawsUsed(room: Room, ownerId: string | null): number {
  if (!ownerId) return 0;
  const counters =
    room.gameMode === "teams" ? room.targetRedrawsUsedByTeam : room.targetRedrawsUsedByPlayer;
  return counters[ownerId] ?? 0;
}

/** Spends exactly one use for the owning player or team. */
export function spendTargetRedraw(room: Room, ownerId: string, used: number): void {
  const counters =
    room.gameMode === "teams" ? room.targetRedrawsUsedByTeam : room.targetRedrawsUsedByPlayer;
  counters[ownerId] = used + 1;
}

/**
 * Public allowance metadata for the current turn. It carries no target angle, and an older
 * server simply omits the whole object so the client can explain that the feature is missing.
 */
export function targetRedrawState(room: Room): TargetRedrawState {
  const used = targetRedrawsUsed(room, targetRedrawOwner(room));
  return {
    supported: true,
    remaining: Math.max(0, TARGET_REDRAWS_PER_MATCH - used),
    usedThisRound: room.currentRound.targetRevision > 0,
    revision: room.currentRound.targetRevision,
  };
}

/**
 * A clue names the revision it was written for. The card id cannot catch a stale clue on its
 * own because a position change keeps the card, so this is the only guard against a clue
 * prepared for the previous position.
 */
export function targetRevisionIssue(
  room: Room,
  revision: number | undefined,
  { requireContext = false }: { requireContext?: boolean } = {},
): string | null {
  if (typeof revision === "number") {
    return room.currentRound.targetRevision === revision ? null : "STALE_TARGET";
  }
  // Clients that predate the feature cannot know a revision; while the target has not moved
  // their clue is still valid, afterwards it must never be accepted without context.
  if (room.currentRound.targetRevision > 0) return "UPDATE_REQUIRED";
  if (requireContext && room.currentRound.status === "waiting") return "TARGET_CONTEXT_REQUIRED";
  return null;
}
