import test from "node:test";
import assert from "node:assert/strict";
import { addPlayer, createRoom, deleteRoom } from "../roomManager.js";
import { calculateRoundScore, scoreAfterSkip } from "../services/scoring.js";
import { required } from "./helpers.js";

for (const [points, psychicPoints] of [
  [[3], 4],
  [[0], 0],
  [[3, 3, 3], 5],
  [[0, 0], -1],
  [[1, 2], 2],
] as const) {
  void test(`pure individual scoring preserves bonuses and penalties for ${points.join(",")}`, (t) => {
    const room = createRoom("SCOR", "psychic", "socket", "Psychic", 20);
    t.after(() => deleteRoom(room.code));
    room.currentRound.psychicId = "psychic";
    for (const [index, score] of points.entries()) {
      const player = required(addPlayer(room, `p${index}`, `s${index}`, `Player ${index}`));
      room.currentRound.guesses.push({ playerId: player.id, angle: 90, points: score });
    }
    const before = structuredClone({ ...room, timer: null });
    const result = calculateRoundScore(room);
    assert.equal(result.psychicPoints, psychicPoints);
    assert.deepEqual(
      result.updatedScores.map((p) => p.totalScore),
      [psychicPoints, ...points],
    );
    assert.deepEqual(room, before);
  });
}

void test("team scoring updates only the active team and keeps skip floor", (t) => {
  const room = createRoom("SCOT", "psychic", "socket", "Psychic", 20);
  t.after(() => deleteRoom(room.code));
  room.gameMode = "teams";
  room.currentRound.psychicId = "psychic";
  room.currentRound.controllerId = "controller";
  room.currentRound.activeTeamId = "team-1";
  required(addPlayer(room, "controller", "s2", "Controller")).teamId = "team-1";
  room.currentRound.guesses.push({ playerId: "controller", angle: 90, points: 3 });
  const result = calculateRoundScore(room);
  assert.deepEqual(
    result.updatedTeams.map((team) => team.score),
    [3, 0],
  );
  assert.equal(result.psychicPoints, null);
  assert.ok(room.players.every((player) => player.score === 0));
  assert.ok(room.teams.every((team) => team.score === 0));
  assert.equal(scoreAfterSkip(-999), -999);
  assert.equal(scoreAfterSkip(0), -1);
});
