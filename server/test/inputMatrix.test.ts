import test from "node:test";
import assert from "node:assert/strict";
import { incomingSchemas } from "@hint/contracts/schemas";
import type { IncomingEvent } from "@hint/contracts";
import type { GameSocket } from "../types.js";
import { onAction } from "../socketHandlers/boundary.js";
import { createRoom, deleteRoom } from "../roomManager.js";
import { serializeRoom } from "../persistence.js";
import { required } from "./helpers.js";

const room = { roomCode: "MTRX" };
const valid = {
  create_room: { displayName: "Owner", winningScore: 20 },
  join_room: { ...room, displayName: "Guest" },
  reconnect_player: { ...room, reconnectToken: "token" },
  leave_room: room,
  cancel_join_request: { ...room, requestId: "request" },
  update_settings: { ...room, winningScore: 20 },
  update_packs: { ...room, selectedPackIds: ["core"] },
  update_game_mode: { ...room, gameMode: "teams" },
  update_team_count: { ...room, teamCount: 2 },
  assign_team: { ...room, playerId: "guest", teamId: "team-1" },
  rename_team: { ...room, teamId: "team-1", name: "النجوم" },
  toggle_psychic_timer: room,
  set_room_lock: { ...room, locked: true },
  approve_join_request: { ...room, requestId: "request" },
  reject_join_request: { ...room, requestId: "request" },
  transfer_ownership: { ...room, playerId: "guest" },
  kick_player: { ...room, playerId: "guest" },
  start_game: room,
  watch_room: room,
  clue_submitted: { ...room, clue: "clue", roundNumber: 1 },
  skip_round: { ...room, roundNumber: 1 },
  redraw_card: { ...room, roundNumber: 1, cardId: "core-1" },
  guess_submitted: { ...room, angle: 90, roundNumber: 1 },
  guess_preview: { ...room, angle: 90, roundNumber: 1 },
  next_round: { ...room, roundNumber: 1 },
  round_ready: { ...room, ready: true, roundNumber: 1 },
  set_round_pause: { ...room, paused: true, roundNumber: 1 },
  card_rating: { ...room, vote: "up", roundNumber: 1 },
  send_reaction: { ...room, reaction: "👍", roundNumber: 1 },
  vote_rematch: { ...room, vote: true },
  rematch: room,
} satisfies Record<IncomingEvent, object>;

function harness(event: IncomingEvent) {
  let listener: ((payload: unknown) => void) | undefined;
  const emitted: { event: string; data: unknown }[] = [];
  const socket = {
    on: (_event: string, callback: (payload: unknown) => void) => {
      listener = callback;
    },
    emit: (name: string, data: unknown) => {
      emitted.push({ event: name, data });
    },
  } as unknown as GameSocket;
  const accepted: unknown[] = [];
  onAction(socket, event, (data) => {
    accepted.push(data);
  });
  return {
    send: (payload: unknown) => {
      required(listener)(payload);
    },
    emitted,
    accepted,
  };
}

for (const event of Object.keys(incomingSchemas) as IncomingEvent[]) {
  void test(`${event}: valid input passes; malformed, missing, null, type, oversized, enum and numeric boundaries are rejected`, () => {
    const h = harness(event);
    h.send(valid[event]);
    assert.equal(h.accepted.length, 1);
    const invalid: unknown[] = [
      undefined,
      null,
      false,
      4,
      "wrong",
      [],
      {},
      {
        ...valid[event],
        ...("roomCode" in valid[event]
          ? { roomCode: "A".repeat(5000) }
          : { displayName: "A".repeat(5000) }),
      },
    ];
    for (const [key, value] of Object.entries(valid[event])) {
      invalid.push({ ...valid[event], [key]: null }, { ...valid[event], [key]: {} });
      if (typeof value === "number")
        invalid.push(
          ...[NaN, Infinity, -Infinity, -1, 1e30, "NaN", "Infinity"].map((bad) => ({
            ...valid[event],
            [key]: bad,
          })),
        );
      if (typeof value === "boolean")
        invalid.push({ ...valid[event], [key]: "false" }, { ...valid[event], [key]: 1 });
      if (["vote", "reaction", "gameMode", "teamId"].includes(key))
        invalid.push({ ...valid[event], [key]: "invalid-enum" });
      if (Array.isArray(value))
        invalid.push(
          { ...valid[event], [key]: [] },
          { ...valid[event], [key]: Array.from({ length: 100 }, () => "core") },
        );
    }
    // create_room intentionally treats a null winning score as its legacy default.
    for (const payload of invalid) {
      if (
        event === "create_room" &&
        typeof payload === "object" &&
        payload !== null &&
        "winningScore" in payload &&
        payload.winningScore === null
      )
        continue;
      h.send(payload);
      assert.equal(h.accepted.length, 1, JSON.stringify({ event, payload }));
      assert.deepEqual(
        h.emitted.at(-1)?.event === "action_error"
          ? h.emitted.at(-1)?.data
          : [...h.emitted].reverse().find((e) => e.event === "action_error")?.data,
        { event, code: "INVALID_PAYLOAD" },
      );
    }
  });
}

void test("every round action rejects stale context before calling mutation handlers", (t) => {
  const state = createRoom("MTRX", "owner", "socket", "Owner", 20);
  state.status = "playing";
  state.currentRound.roundNumber = 2;
  t.after(() => deleteRoom(state.code));
  for (const event of Object.keys(valid) as IncomingEvent[]) {
    if (!("roundNumber" in valid[event])) continue;
    const h = harness(event);
    const before = serializeRoom(state);
    h.send(valid[event]);
    assert.equal(h.accepted.length, 0, event);
    assert.deepEqual(h.emitted, [{ event: "action_error", data: { event, code: "STALE_ROUND" } }]);
    const after = serializeRoom(state);
    assert.deepEqual({ ...after, savedAt: 0 }, { ...before, savedAt: 0 });
  }
});

void test("legacy validation errors keep their domain messages and current guess round", (t) => {
  const state = createRoom("MTRX", "owner", "socket", "Owner", 20);
  state.currentRound.roundNumber = 4;
  t.after(() => deleteRoom(state.code));
  const name = harness("create_room");
  name.send({ displayName: "<script>", winningScore: 20 });
  assert.deepEqual(name.emitted.at(-1), {
    event: "join_error",
    data: { message: "الاسم يحتوي على أحرف غير مسموحة" },
  });
  const score = harness("create_room");
  score.send({ displayName: "Owner", winningScore: 11 });
  assert.deepEqual(score.emitted.at(-1), {
    event: "join_error",
    data: { message: "خيار هدف الفوز غير صالح" },
  });
  const guess = harness("guess_submitted");
  guess.send({ roomCode: "MTRX", angle: 999 });
  assert.deepEqual(guess.emitted.at(-1), {
    event: "guess_rejected",
    data: { roundNumber: 4, reason: "INVALID_ANGLE" },
  });
});
