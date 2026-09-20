import test from "node:test";
import assert from "node:assert/strict";
import revealedFixture from "./fixtures/v1-revealed-60287c6.json" with { type: "json" };
import finishedFixture from "./fixtures/v1-finished-60287c6.json" with { type: "json" };
import abandonedFixture from "./fixtures/v1-abandoned-60287c6.json" with { type: "json" };
import { deserializeRoom, serializeRoom } from "../persistence.js";
import { getReconnectState } from "../roomManager.js";
import { required } from "./helpers.js";

for (const [name, fixture] of Object.entries({
  revealed: revealedFixture,
  finished: finishedFixture,
  abandoned: abandonedFixture,
})) {
  void test(`restores actual60287c6 v1 ${name} producer snapshot without losing scores, results or ratings`, () => {
    const restored = deserializeRoom(fixture, fixture.savedAt + 1000);
    assert.ok(restored);
    assert.equal(restored.status, fixture.status);
    assert.deepEqual(
      restored.players.map((player) => player.score),
      fixture.players.map((player) => player.score),
    );
    assert.deepEqual(restored.matchHistory, fixture.matchHistory);
    const reveal = required(restored.currentRound.revealData);
    assert.equal(reveal.psychicPoints, fixture.currentRound.revealData.psychicPoints);
    assert.equal(reveal.psychicBreakdown, null);
    assert.deepEqual(reveal.winner, fixture.currentRound.revealData.winner);
    assert.deepEqual(
      reveal.winners,
      fixture.currentRound.revealData.winner ? [fixture.currentRound.revealData.winner] : [],
    );
    assert.deepEqual(reveal.guesses, fixture.currentRound.revealData.guesses);
    assert.deepEqual(restored.currentRound.ratings, [
      { playerId: "guest", vote: "up", targetRegion: "all" },
    ]);
    const guestState = getReconnectState(restored, "guest");
    assert.equal(required(guestState.currentRound).hasRated, true);
    assert.equal(required(guestState.currentRound).myRatingVote, "up");
    assert.equal("psychicTargetAngle" in required(guestState.currentRound), false);
    if (name === "finished") {
      const final = required(restored.finalState);
      assert.ok("targetAngle" in final);
      assert.deepEqual(final.winners, [finishedFixture.finalState.winner]);
      assert.deepEqual(final.awards, finishedFixture.finalState.awards);
      assert.equal(final.matchRoundCount, 1);
    } else if (name === "abandoned") {
      const final = required(restored.finalState);
      assert.ok("reason" in final);
      assert.deepEqual(final.winners, []);
      assert.deepEqual(final.leaderboard, abandonedFixture.finalState.leaderboard);
      assert.equal(final.reason, abandonedFixture.finalState.reason);
    }
  });
}

void test("legacy defaults preserve supplied modern values and still reject malformed optional fields", () => {
  const restored = required(deserializeRoom(finishedFixture, finishedFixture.savedAt + 1000));
  restored.lastActivity = Date.now();
  const snapshot = serializeRoom(restored);
  const reveal = required(snapshot.currentRound.revealData);
  reveal.psychicBreakdown = {
    averagePoints: 3,
    twoPlayerBonus: 1,
    bullseyeBonus: 0,
    allMissPenalty: false,
  };
  reveal.winners = [];
  required(snapshot.currentRound.ratings[0]).targetRegion = "center";
  const modern = required(deserializeRoom(snapshot, snapshot.savedAt + 1000));
  assert.deepEqual(
    required(modern.currentRound.revealData).psychicBreakdown,
    reveal.psychicBreakdown,
  );
  assert.deepEqual(required(modern.currentRound.revealData).winners, []);
  assert.equal(required(modern.currentRound.ratings[0]).targetRegion, "center");
  for (const [field, value] of [
    ["psychicBreakdown", {}],
    ["winners", null],
  ] as const) {
    const malformed = structuredClone(snapshot);
    Reflect.set(required(malformed.currentRound.revealData), field, value);
    assert.equal(deserializeRoom(malformed, malformed.savedAt + 1000), null);
  }
  const malformedRating = structuredClone(snapshot);
  Reflect.set(required(malformedRating.currentRound.ratings[0]), "targetRegion", null);
  assert.equal(deserializeRoom(malformedRating, malformedRating.savedAt + 1000), null);
  for (const field of ["psychicBreakdown", "winners"]) {
    const malformed = structuredClone(snapshot);
    Reflect.deleteProperty(required(malformed.currentRound.revealData), field);
    assert.equal(deserializeRoom(malformed, malformed.savedAt + 1000), null, field);
  }
  const missingFinalWinners = structuredClone(snapshot);
  Reflect.deleteProperty(required(missingFinalWinners.finalState), "winners");
  assert.equal(deserializeRoom(missingFinalWinners, missingFinalWinners.savedAt + 1000), null);
  const missingRegion = structuredClone(snapshot);
  Reflect.deleteProperty(required(missingRegion.currentRound.ratings[0]), "targetRegion");
  assert.equal(deserializeRoom(missingRegion, missingRegion.savedAt + 1000), null);
});
