import { RoomTimerScheduler, type Clock } from "../timerScheduler.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoom, deleteRoom, setRoomTimer, clearRoomTimer } from "../roomManager.js";

void test("late timer callbacks cannot act on a different round or after cancellation", (t) => {
  const room = createRoom("TIME", "owner", "socket", "Owner", 20);
  room.status = "playing";
  room.currentRound.roundNumber = 1;
  const callbacks: (() => void)[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    callbacks.push(callback);
    return original(() => {
      /* Deliberately inert timer/transport fixture. */
    }, delay);
  });
  t.after(() => deleteRoom(room.code));
  let mutations = 0;
  setRoomTimer(
    room,
    () => {
      mutations++;
    },
    60000,
    "psychic",
  );
  room.currentRound.roundNumber = 2;
  callbacks[0]?.();
  assert.equal(mutations, 0);
  setRoomTimer(
    room,
    () => {
      mutations++;
    },
    60000,
    "psychic",
  );
  clearRoomTimer(room);
  callbacks[1]?.();
  assert.equal(mutations, 0);
});

void test("room removal and duplicate callbacks cannot advance a match", (t) => {
  const room = createRoom("TIM2", "owner", "socket", "Owner", 20);
  room.status = "playing";
  const callbacks: (() => void)[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    callbacks.push(callback);
    return original(() => {
      /* Deliberately inert timer/transport fixture. */
    }, delay);
  });
  t.after(() => deleteRoom(room.code));
  let mutations = 0;
  setRoomTimer(
    room,
    () => {
      mutations++;
    },
    60000,
  );
  callbacks[0]?.();
  callbacks[0]?.();
  assert.equal(mutations, 1);
  setRoomTimer(
    room,
    () => {
      mutations++;
    },
    60000,
  );
  deleteRoom(room.code);
  createRoom(room.code, "replacement", "socket2", "Replacement", 20);
  callbacks[1]?.();
  assert.equal(mutations, 1);
});

void test("an injected clock freezes exact remaining time and rejects changed phase callbacks", (t) => {
  const room = createRoom("CLK1", "owner", "socket", "Owner", 20);
  t.after(() => deleteRoom(room.code));
  let now = 1000;
  let callback = () => {
    /* Filled by the injected scheduler. */
  };
  const clock: Clock = {
    now: () => now,
    schedule: (action, delay) => {
      callback = action;
      return setTimeout(() => {
        /* Deliberately controlled by the test. */
      }, delay);
    },
    cancel: (handle) => {
      clearTimeout(handle);
    },
  };
  const scheduler = new RoomTimerScheduler((code) => (code === room.code ? room : null), clock);
  t.after(() => {
    scheduler.clear(room);
  });
  let mutations = 0;
  assert.equal(
    scheduler.schedule(
      room,
      () => {
        mutations++;
      },
      60000,
      "psychic",
    ),
    61000,
  );
  now = 1400;
  assert.equal(scheduler.pause(room), 59600);
  now = 3000;
  callback();
  assert.equal(mutations, 0);
  assert.equal(
    scheduler.schedule(
      room,
      () => {
        mutations++;
      },
      59600,
      "psychic",
    ),
    62600,
  );
  room.currentRound.status = "guessing";
  callback();
  assert.equal(mutations, 0);
  assert.equal(room.timer, null);
  assert.equal(room.timerDescriptor, null);
});
