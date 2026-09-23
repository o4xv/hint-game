import { present } from "./invariants.js";
import type { Award, HistoryRound, Room } from "./types.js";
import { SCORING } from "./config/gameConfig.js";
import { pointsForGuess } from "@hint/contracts";

export const SCORING_ZONES = SCORING;

export const TARGET_REGIONS = Object.freeze([
  Object.freeze({ id: "far-left", anchor: 10, maxAngle: 36 }),
  Object.freeze({ id: "inner-left", anchor: 30, maxAngle: 72 }),
  Object.freeze({ id: "center", anchor: 50, maxAngle: 108 }),
  Object.freeze({ id: "inner-right", anchor: 70, maxAngle: 144 }),
  Object.freeze({ id: "far-right", anchor: 90, maxAngle: 180 }),
]);

const SUITABILITY_WEIGHTS = Object.freeze([0, 1, 2, 4, 7, 10]);

export function getTargetRegion(targetAngle: unknown) {
  const angle = Number(targetAngle);
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) return null;
  const index = TARGET_REGIONS.findIndex((region) => angle <= region.maxAngle);
  const region = TARGET_REGIONS[index];
  return region ? { ...region, index } : null;
}

export function calculatePoints(guessAngle: number, targetAngle: number) {
  // The shared implementation is what the in-app practice round shows, so the explanation
  // of the scoring bands cannot drift from what the server awards.
  return pointsForGuess(guessAngle, targetAngle);
}

export function calculatePsychicPoints(playerScores: number[]) {
  if (playerScores.length === 0) return 0;
  const avg = playerScores.reduce((a, b) => a + b, 0) / playerScores.length;
  return Math.round(avg);
}

export function generateTargetAngle() {
  return Math.random() * 168 + 6;
}

/** Generated targets stay inside this band, including replacements of historical edge targets. */
export const TARGET_MIN_ANGLE = 6;
export const TARGET_MAX_ANGLE = 174;
/** An answer-position change must move the target at least this far. */
export const TARGET_REDRAW_MIN_SEPARATION = 45;

/**
 * Picks the replacement position for a target change. The eligible positions are the two
 * intervals at least `TARGET_REDRAW_MIN_SEPARATION` away from the previous one, sampled by
 * their combined length so a longer side is proportionally more likely. The draw is a single
 * uniform sample rather than a rejection loop, so it always terminates immediately.
 */
export function generateReplacementTargetAngle(
  previousAngle: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(previousAngle) || previousAngle < 0 || previousAngle > 180) {
    throw new TypeError("Previous target angle must be a finite number between 0 and 180");
  }
  const leftLow = TARGET_MIN_ANGLE;
  const leftHigh = previousAngle - TARGET_REDRAW_MIN_SEPARATION;
  const rightLow = previousAngle + TARGET_REDRAW_MIN_SEPARATION;
  const rightHigh = TARGET_MAX_ANGLE;
  const leftLength = Math.max(0, leftHigh - leftLow);
  const rightLength = Math.max(0, rightHigh - rightLow);
  const totalLength = leftLength + rightLength;
  // Any angle inside 0-180 leaves at least one eligible interval, so this is a guard only.
  if (totalLength <= 0) throw new RangeError("No eligible replacement position for this target");

  // Clamp a misbehaving random source instead of retrying, and keep the draw below the
  // exclusive upper bound so the sample never lands outside the two intervals.
  const raw = random();
  const sample = (Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0) * totalLength;
  const offset = Math.min(sample, totalLength - Number.EPSILON * totalLength);
  return offset < leftLength ? leftLow + offset : rightLow + (offset - leftLength);
}

export function buildPsychicQueue(playerIds: string[]) {
  const queue = [...playerIds];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [present(queue[j]), present(queue[i])];
  }
  return queue;
}

export function getNextPsychic(room: {
  players: { id: string; isConnected: boolean; awaitingNextRound?: boolean }[];
  currentRound: Pick<Room["currentRound"], "psychicOrder" | "psychicIndex">;
}) {
  const connectedIds = room.players
    .filter((p) => p.isConnected && !p.awaitingNextRound)
    .map((p) => p.id);
  if (connectedIds.length === 0) return null;

  const round = room.currentRound;
  const connected = new Set(connectedIds);
  const completed = round.psychicOrder
    .slice(0, round.psychicIndex)
    .filter((id) => connected.has(id));
  const pending = round.psychicOrder.slice(round.psychicIndex).filter((id) => connected.has(id));
  const known = new Set([...completed, ...pending]);

  round.psychicOrder = [...completed, ...pending, ...connectedIds.filter((id) => !known.has(id))];
  round.psychicIndex = completed.length;

  if (round.psychicIndex >= round.psychicOrder.length) {
    const lastPsychic = round.psychicOrder[round.psychicOrder.length - 1];
    const newOrder = buildPsychicQueue(connectedIds);
    if (newOrder.length > 1 && newOrder[0] === lastPsychic) {
      [newOrder[0], newOrder[1]] = [present(newOrder[1]), present(newOrder[0])];
    }
    round.psychicOrder = newOrder;
    round.psychicIndex = 0;
  }

  return round.psychicOrder[round.psychicIndex++];
}

export function drawCard<T extends { id: string }>(allCards: T[], usedCardIds: string[]) {
  if (!allCards.length) throw new Error("Cannot draw an empty deck");
  const available = allCards.filter((c) => !usedCardIds.includes(c.id));
  if (available.length === 0) {
    usedCardIds.length = 0;
    const card = present(allCards[Math.floor(Math.random() * allCards.length)]);
    usedCardIds.push(card.id);
    return card;
  }
  const card = present(available[Math.floor(Math.random() * available.length)]);
  usedCardIds.push(card.id);
  return card;
}

export function drawCardForTarget<T extends { id: string; editorial?: { suitability: number[] } }>(
  allCards: T[],
  usedCardIds: string[],
  targetAngle: number,
  random = Math.random,
) {
  const region = getTargetRegion(targetAngle);
  if (!region) throw new TypeError("Target angle must be between 0 and 180");

  let available = allCards.filter((card) => !usedCardIds.includes(card.id));
  if (available.length === 0) {
    // The selected deck is exhausted: reset only the selected packs' history, keep the
    // entries of unselected packs, and hold the most recent card out of the pool so it
    // cannot repeat while an alternative exists.
    const selectedIds = new Set(allCards.map((card) => card.id));
    const lastDrawn = usedCardIds[usedCardIds.length - 1];
    const retained = usedCardIds.filter(
      (id) => !selectedIds.has(id) || (id === lastDrawn && allCards.length > 1),
    );
    usedCardIds.length = 0;
    usedCardIds.push(...retained);
    available = allCards.filter((card) => !usedCardIds.includes(card.id));
    // A single-card deck has no alternative, so the repeat is allowed there.
    if (available.length === 0 && allCards.length > 1) {
      usedCardIds.length = 0;
      available = [...allCards];
    }
  }
  if (available.length === 0) return null;

  const weighted = available.map((card) => {
    const rawScore = Number(card.editorial?.suitability[region.index]);
    const score = Number.isInteger(rawScore) && rawScore >= 1 && rawScore <= 5 ? rawScore : 3;
    return { card, weight: present(SUITABILITY_WEIGHTS[score]) };
  });
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = Math.max(0, Math.min(0.999999999, random() || 0)) * totalWeight;
  let selected = present(weighted[weighted.length - 1]).card;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor < 0) {
      selected = entry.card;
      break;
    }
  }

  usedCardIds.push(selected.id);
  return selected;
}

export function checkWinner<T extends { score: number }>(players: T[], winningScore: number) {
  return getWinners(players, winningScore)[0] ?? null;
}

export function getWinners<T extends { score: number }>(players: T[], winningScore: number) {
  const eligible = players.filter((player) => player.score >= winningScore);
  if (!eligible.length) return [];
  const topScore = Math.max(...eligible.map((player) => player.score));
  return eligible.filter((player) => player.score === topScore);
}

function award(
  type: Award["type"],
  title: string,
  entries: { playerId: string }[],
  value: number | null = null,
) {
  return { type, title, playerIds: entries.map((entry) => entry.playerId), value };
}

export function calculateAwards(
  matchHistory: HistoryRound[],
  players: { id: string; displayName: string }[],
) {
  const names = new Map(players.map((player) => [player.id, player.displayName]));
  const guesses = matchHistory
    .flatMap((round) =>
      round.guesses.map((guess) => ({
        ...guess,
        roundNumber: round.roundNumber,
        distance: guess.distance,
      })),
    )
    .filter((guess) => Number.isFinite(guess.distance));
  const awards = [];

  if (guesses.length) {
    const closestDistance = Math.min(...guesses.map((guess) => guess.distance));
    const closest = guesses.filter((guess) => guess.distance === closestDistance);
    awards.push(award("closest_guess", "أقرب تخمين", closest, closestDistance));

    const largestDistance = Math.max(...guesses.map((guess) => guess.distance));
    const largest = guesses.filter((guess) => guess.distance === largestDistance);
    awards.push(award("largest_miss", "أبعد محاولة", largest, largestDistance));
  }

  const guessesByPlayer = new Map<string, number[]>();
  for (const guess of guesses) {
    const list = guessesByPlayer.get(guess.playerId) ?? [];
    list.push(guess.distance);
    guessesByPlayer.set(guess.playerId, list);
  }
  const guessAverages = [...guessesByPlayer]
    .filter(([, values]) => values.length >= 2)
    .map(([playerId, values]) => ({
      playerId,
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
    }));
  if (guessAverages.length) {
    const best = Math.min(...guessAverages.map((entry) => entry.average));
    awards.push(
      award(
        "best_guessing_average",
        "أدق مخمّن",
        guessAverages.filter((entry) => entry.average === best),
        Math.round(best * 10) / 10,
      ),
    );
  }

  const psychicByPlayer = new Map<string, number[]>();
  for (const round of matchHistory) {
    if (!round.psychicId || round.psychicPoints === null || !Number.isFinite(round.psychicPoints))
      continue;
    const values = psychicByPlayer.get(round.psychicId) ?? [];
    values.push(round.psychicPoints);
    psychicByPlayer.set(round.psychicId, values);
  }
  const psychicAverages = [...psychicByPlayer]
    .filter(([, values]) => values.length >= 2)
    .map(([playerId, values]) => ({
      playerId,
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
    }));
  if (psychicAverages.length) {
    const best = Math.max(...psychicAverages.map((entry) => entry.average));
    awards.push(
      award(
        "best_psychic_average",
        "أفضل وسيط",
        psychicAverages.filter((entry) => entry.average === best),
        Math.round(best * 10) / 10,
      ),
    );
  }

  return awards.map((item) => ({
    ...item,
    players: item.playerIds.map((playerId) => ({
      playerId,
      displayName: names.get(playerId) ?? "لاعب",
    })),
  }));
}
