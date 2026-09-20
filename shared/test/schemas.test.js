import assert from "node:assert/strict";
import { test } from "node:test";
import { incomingSchemas, parseIncoming } from "../dist/schemas.js";

const room = { roomCode: "ABCD" };
const fixtures = {
  create_room: { displayName: "عبدالله" },
  join_room: { ...room, displayName: "سارة" },
  reconnect_player: { ...room, reconnectToken: "a-valid-token" },
  leave_room: room,
  cancel_join_request: { ...room, requestId: "request-1" },
  update_settings: { ...room, winningScore: 20 },
  update_packs: { ...room, selectedPackIds: ["core"] },
  update_game_mode: { ...room, gameMode: "teams" },
  update_team_count: { ...room, teamCount: 2 },
  assign_team: { ...room, playerId: "player-1", teamId: "team-1" },
  rename_team: { ...room, teamId: "team-1", name: "النجوم" },
  toggle_psychic_timer: room,
  set_room_lock: { ...room, locked: true },
  approve_join_request: { ...room, requestId: "request-1" },
  reject_join_request: { ...room, requestId: "request-1" },
  transfer_ownership: { ...room, playerId: "player-1" },
  kick_player: { ...room, playerId: "player-1" },
  start_game: room,
  watch_room: room,
  clue_submitted: { ...room, clue: "قهوة" },
  skip_round: room,
  redraw_card: { ...room, cardId: "core-1" },
  guess_submitted: { ...room, angle: 90 },
  guess_preview: { ...room, angle: 90, roundNumber: 1 },
  next_round: room,
  round_ready: room,
  set_round_pause: { ...room, roundNumber: 1, paused: true },
  card_rating: { ...room, vote: "up" },
  send_reaction: { ...room, reaction: "👍" },
  vote_rematch: room,
  rematch: room,
};

test("every application event has a schema and a valid baseline fixture", () => {
  assert.deepEqual(Object.keys(incomingSchemas).sort(), Object.keys(fixtures).sort());
  for (const [event, payload] of Object.entries(fixtures)) {
    assert.equal(parseIncoming(event, payload).success, true, event);
  }
});

for (const [event, fixture] of Object.entries(fixtures)) {
  test(`${event} rejects malformed outer values and strips unknown keys`, () => {
    for (const input of [undefined, null, [], "", 1, true]) {
      assert.equal(parseIncoming(event, input).success, false, `${event}: ${input}`);
    }
    const parsed = parseIncoming(event, { ...fixture, secret: "do not retain" });
    assert.equal(parsed.success, true);
    assert.equal("secret" in parsed.data, false);
  });
}

test("preserves legitimate defaults and normalizes bounded room codes and numeric settings", () => {
  assert.equal(parseIncoming("create_room", { displayName: "اسم" }).data.winningScore, 20);
  assert.equal(parseIncoming("round_ready", room).data.ready, true);
  assert.equal(parseIncoming("vote_rematch", room).data.vote, true);
  assert.equal(
    parseIncoming("join_room", { roomCode: " abcd ", displayName: "اسم" }).data.roomCode,
    "ABCD",
  );
  assert.equal(
    parseIncoming("update_settings", { ...room, winningScore: "30" }).data.winningScore,
    30,
  );
  assert.equal(parseIncoming("update_team_count", { ...room, teamCount: "3" }).data.teamCount, 3);
  assert.equal(parseIncoming("guess_submitted", { ...room, angle: "90.5" }).data.angle, 90.5);
});

test("bounded wire names and clues preserve downstream truncation", () => {
  for (const [event, key] of [
    ["create_room", "displayName"],
    ["clue_submitted", "clue"],
  ]) {
    assert.equal(parseIncoming(event, { ...room, [key]: "ع".repeat(256) }).success, true);
    assert.equal(parseIncoming(event, { ...room, [key]: "ع".repeat(257) }).success, false);
    for (const value of ["", "   ", null, 22, {}, "<b>اسم</b>"]) {
      assert.equal(parseIncoming(event, { ...room, [key]: value }).success, false);
    }
  }
});

test("rejects invalid enums, missing required fields, oversized IDs and pack lists", () => {
  const invalid = [
    ["update_game_mode", { ...room, gameMode: "solo" }],
    ["card_rating", { ...room, vote: "yes" }],
    ["send_reaction", { ...room, reaction: "❌" }],
    ["assign_team", { ...room, playerId: "p", teamId: "team-5" }],
    ["reconnect_player", { ...room, reconnectToken: "x".repeat(257) }],
    ["kick_player", { ...room, playerId: "x".repeat(129) }],
    ["update_packs", { ...room, selectedPackIds: Array(33).fill("core") }],
    ["update_packs", { ...room, selectedPackIds: ["x".repeat(65)] }],
    ["update_packs", { ...room, selectedPackIds: [] }],
    ["update_packs", { ...room, selectedPackIds: [1] }],
    ["set_room_lock", room],
    ["set_round_pause", { ...room, paused: true }],
    ["join_room", { ...room }],
    ["start_game", { roomCode: "ABCDE" }],
    ["start_game", { roomCode: "A<>B" }],
  ];
  for (const [event, input] of invalid)
    assert.equal(parseIncoming(event, input).success, false, event);
});

test("numeric boundaries reject nonfinite values and type coercion traps", () => {
  for (const angle of [NaN, Infinity, -Infinity, -1, 181, null, true, [], {}, "", " "]) {
    assert.equal(
      parseIncoming("guess_submitted", { ...room, angle }).success,
      false,
      String(angle),
    );
  }
  for (const angle of [0, 180])
    assert.equal(parseIncoming("guess_submitted", { ...room, angle }).success, true);
  for (const winningScore of [0, 15, 100, null, true, Infinity]) {
    assert.equal(parseIncoming("update_settings", { ...room, winningScore }).success, false);
  }
  for (const teamCount of [1, 5, 2.5, null]) {
    assert.equal(parseIncoming("update_team_count", { ...room, teamCount }).success, false);
  }
  for (const roundNumber of [-1, 0, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      parseIncoming("guess_preview", { ...room, angle: 90, roundNumber }).success,
      false,
    );
  }
  for (const ready of ["false", 0, null])
    assert.equal(parseIncoming("round_ready", { ...room, ready }).success, false);
});
