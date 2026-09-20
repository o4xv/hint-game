import type { Room, TimeoutHandle, TimerKind } from "./types.js";

export interface Clock {
  now(): number;
  schedule(callback: () => void, delayMs: number): TimeoutHandle;
  cancel(handle: TimeoutHandle): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => {
    clearTimeout(handle);
  },
};

/** One active timer per room; cancellation invalidates even callbacks already queued. */
export class RoomTimerScheduler {
  private readonly pending = new WeakMap<Room, object>();
  constructor(
    private readonly currentRoom: (code: string) => Room | null,
    private readonly clock: Clock = systemClock,
  ) {}

  clear(room: Room): void {
    this.pending.delete(room);
    if (room.timer) this.clock.cancel(room.timer);
    room.timer = null;
    room.timerEndsAt = null;
    room.timerDescriptor = null;
  }

  schedule(room: Room, callback: () => void, delayMs: number, kind: TimerKind): number {
    this.clear(room);
    const token = {};
    const roundNumber = room.currentRound.roundNumber;
    const phase = room.currentRound.status;
    const status = room.status;
    const endsAt = this.clock.now() + delayMs;
    room.timerEndsAt = endsAt;
    room.timerDescriptor = { kind, endsAt };
    this.pending.set(room, token);
    room.timer = this.clock.schedule(() => {
      if (this.pending.get(room) !== token) return;
      this.clear(room);
      if (
        this.currentRoom(room.code) !== room ||
        room.currentRound.roundNumber !== roundNumber ||
        room.currentRound.status !== phase ||
        room.status !== status
      )
        return;
      callback();
    }, delayMs);
    return endsAt;
  }

  pause(room: Room): number | null {
    const remaining =
      room.timerEndsAt === null ? null : Math.max(0, room.timerEndsAt - this.clock.now());
    this.clear(room);
    return remaining;
  }
}
