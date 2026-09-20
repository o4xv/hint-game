import { required } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePoints,
  calculatePsychicPoints,
  checkWinner,
  getNextPsychic,
  drawCard,
  drawCardForTarget,
  generateTargetAngle,
  getTargetRegion,
  calculateAwards,
} from "../gameEngine.js";
import { cards, publicCards, publicPacks, validatePackIds } from "../data/cards.js";
import { getRecoveryDelay } from "../socketHandlers/roundLogic.js";

void test("scores exact boundaries for all scoring zones", () => {
  assert.equal(calculatePoints(90, 90), 3);
  assert.equal(calculatePoints(96, 90), 3);
  assert.equal(calculatePoints(106, 90), 2);
  assert.equal(calculatePoints(114, 90), 1);
  assert.equal(calculatePoints(114.01, 90), 0);
});

void test("rounds psychic points and selects the highest eligible winner", () => {
  assert.equal(calculatePsychicPoints([3, 2, 0]), 2);
  const winner = checkWinner(
    [
      { id: "a", score: 10 },
      { id: "b", score: 12 },
      { id: "c", score: 12 },
    ],
    10,
  );
  assert.ok(winner);
  assert.equal(winner.id, "b");
});

void test("never returns a removed player from the psychic queue", () => {
  const room = {
    players: [
      { id: "a", isConnected: true },
      { id: "c", isConnected: true },
    ],
    currentRound: {
      psychicOrder: ["a", "b", "c"],
      psychicIndex: 1,
    },
  };

  assert.notEqual(getNextPsychic(room), "b");
});

void test("ships only the three family-safe card packs without exposing editorial metadata", () => {
  assert.deepEqual(
    publicPacks.map((pack) => pack.cardCount),
    [60, 50, 45],
  );
  assert.deepEqual(
    publicPacks.map((pack) => pack.id),
    ["core", "daily-life", "entertainment"],
  );
  assert.equal(cards.length, 155);
  assert.ok(cards.every((item) => item.editorial.anchors.length === 5));
  const endpointPairs = cards.map((item) => `${item.left}|${item.right}`);
  assert.equal(new Set(endpointPairs).size, endpointPairs.length, "no repeated endpoint pair");
  const endpoints = cards.flatMap((item) => [item.left, item.right]);
  assert.equal(new Set(endpoints).size, endpoints.length, "no reused endpoint word");
  assert.ok(
    cards.every(
      (item) =>
        item.editorial.suitability.length === 5 &&
        item.editorial.suitability.every(
          (score) => Number.isInteger(score) && score >= 1 && score <= 5,
        ),
    ),
  );
  assert.ok(publicCards.every((item) => !("editorial" in item)));
  assert.equal(validatePackIds(["core", "friends"]), null);
  assert.equal(validatePackIds(["unknown"]), null);
});

void test("draws without repeats until the selected deck is exhausted", () => {
  const deck = cards.slice(0, 4);
  const used: string[] = [];
  const drawn = Array.from({ length: 4 }, () => drawCard(deck, used).id);
  assert.equal(new Set(drawn).size, 4);
  assert.equal(used.length, 4);
});

void test("maps target angles to five editorial regions without changing target bounds", () => {
  assert.equal(required(getTargetRegion(6)).id, "far-left");
  assert.equal(required(getTargetRegion(36)).id, "far-left");
  assert.equal(required(getTargetRegion(36.01)).id, "inner-left");
  assert.equal(required(getTargetRegion(90)).id, "center");
  assert.equal(required(getTargetRegion(144.01)).id, "far-right");
  assert.equal(getTargetRegion(-1), null);
  assert.equal(getTargetRegion(Number.NaN), null);
  for (let index = 0; index < 1_000; index++) {
    const angle = generateTargetAngle();
    assert.ok(angle >= 6 && angle < 174);
  }
});

void test("weights cards for the target region while keeping every card eligible", () => {
  const strong = { id: "strong", editorial: { suitability: [3, 5, 3, 3, 3] } };
  const weak = { id: "weak", editorial: { suitability: [3, 1, 3, 3, 3] } };

  assert.equal(required(drawCardForTarget([strong, weak], [], 54, () => 0.5)).id, "strong");
  assert.equal(required(drawCardForTarget([strong, weak], [], 54, () => 0.99)).id, "weak");
});

void test("target-aware drawing preserves no-repeat behavior and resets an exhausted deck", () => {
  const deck = cards.slice(0, 3);
  const used: string[] = [];
  const firstCycle = Array.from(
    { length: 3 },
    () => required(drawCardForTarget(deck, used, 54, () => 0)).id,
  );
  assert.equal(new Set(firstCycle).size, 3);
  assert.equal(used.length, 3);
  const lastDrawn = used[used.length - 1];
  const next = required(drawCardForTarget(deck, used, 54, () => 0));
  assert.notEqual(next.id, lastDrawn, "the same card does not repeat across a reset");
  assert.equal(used.length, 2, "the most recent card stays as history");
});

void test("an exhausted deck keeps other packs' history and skips the previous card", () => {
  const deck = cards.slice(0, 2);
  const used = ["friends-1", required(deck[1]).id, required(deck[0]).id];
  const next = required(drawCardForTarget(deck, used, 54, () => 0));
  assert.equal(used[0], "friends-1", "history from an unselected pack survives");
  assert.notEqual(next.id, required(deck[0]).id, "the previous card stays out of the pool");
});

void test("a single-card deck still returns a card when it is exhausted", () => {
  const deck = [required(cards[0])];
  const used = [required(cards[0]).id];
  const next = required(drawCardForTarget(deck, used, 54, () => 0));
  assert.equal(next.id, required(cards[0]).id, "no alternative exists, so the card repeats");
});

void test("calculates tied awards and requires two rounds for averages", () => {
  const players = [
    { id: "a", displayName: "A" },
    { id: "b", displayName: "B" },
  ];
  const oneRound = [
    { roundNumber: 1, psychicId: "a", psychicPoints: 2, guesses: [{ playerId: "b", distance: 4 }] },
  ];
  assert.deepEqual(
    calculateAwards(oneRound, players).map((item) => item.type),
    ["closest_guess", "largest_miss"],
  );
  const twoRounds = [
    ...oneRound,
    { roundNumber: 2, psychicId: "a", psychicPoints: 3, guesses: [{ playerId: "b", distance: 4 }] },
  ];
  assert.ok(
    calculateAwards(twoRounds, players).some((item) => item.type === "best_guessing_average"),
  );
  assert.ok(
    calculateAwards(twoRounds, players).some((item) => item.type === "best_psychic_average"),
  );
});

void test("restored expired timers receive at least fifteen seconds", () => {
  assert.equal(getRecoveryDelay(1_000, 2_000), 15_000);
  assert.equal(getRecoveryDelay(25_000, 2_000), 23_000);
});
