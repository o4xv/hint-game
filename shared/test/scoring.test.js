import test from "node:test";
import assert from "node:assert/strict";
import { SCORING, pointsForGuess } from "../dist/index.js";

// The server scores rounds and the in-app practice round both call pointsForGuess, so these
// boundaries are the single contract that decides what "closer to the target" is worth.
test("the shared scoring bands reward each distance exactly once", () => {
  assert.equal(pointsForGuess(90, 90), 3);
  assert.equal(pointsForGuess(90, 90 + SCORING.BULLSEYE), 3, "the inner edge still scores 3");
  assert.equal(pointsForGuess(90, 90 + SCORING.BULLSEYE + 0.01), 2);
  assert.equal(pointsForGuess(90, 90 + SCORING.MIDDLE), 2, "the middle edge still scores 2");
  assert.equal(pointsForGuess(90, 90 + SCORING.MIDDLE + 0.01), 1);
  assert.equal(pointsForGuess(90, 90 + SCORING.OUTER), 1, "the outer edge still scores 1");
  assert.equal(pointsForGuess(90, 90 + SCORING.OUTER + 0.01), 0);
});

test("distance decides the score, whichever side the guess falls on", () => {
  assert.equal(pointsForGuess(90 - 5, 90), pointsForGuess(90 + 5, 90));
  assert.equal(pointsForGuess(12, 96), pointsForGuess(180, 96));
  assert.equal(pointsForGuess(0, 180), 0, "the far end of the scale scores nothing");
});
