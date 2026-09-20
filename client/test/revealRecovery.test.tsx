// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReconnectSuccessPayload, RevealData } from "@hint/contracts";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Reveal } from "../src/ui/Results";
import { createSessionStore, initialSession } from "../src/session/store";

vi.mock("../src/session/audio", () => ({
  playReveal: vi.fn(),
  playScore: vi.fn(),
  playWinner: vi.fn(),
  playTick: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const cardA = { id: "core-1", packId: "core", left: "A", right: "B" };
const cardB = { id: "core-2", packId: "core", left: "C", right: "D" };
const result: RevealData = {
  targetAngle: 90,
  guesses: [{ playerId: "guest", displayName: "Guest", angle: 90, points: 3 }],
  psychicPoints: 4,
  psychicBreakdown: null,
  updatedScores: [{ playerId: "guest", displayName: "Guest", totalScore: 3 }],
  updatedTeams: [],
  gameMode: "individual",
  activeTeamId: null,
  shouldPromptRating: false,
  winner: null,
  winners: [],
};

function makeStore(liveReveal = false) {
  const initial = initialSession();
  return createSessionStore({
    ...initial,
    roomCode: "AB12",
    playerId: "psychic",
    displayName: "Psychic",
    isOwner: true,
    connection: "connected",
    phase: "playing",
    currentScreen: liveReveal ? "reveal" : "game-psychic",
    clueDraft: liveReveal ? "" : "old-card clue",
    revealData: liveReveal ? result : null,
    revealFresh: liveReveal,
    round: {
      ...initial.round,
      roundNumber: 3,
      psychicId: "psychic",
      card: cardA,
      targetAngle: 90,
      myAngle: 35,
      previewAngle: 35,
      clue: liveReveal ? "accepted clue" : null,
      redrawAvailable: true,
    },
  });
}

function snapshot(revealed: boolean, changedCard = false): ReconnectSuccessPayload {
  const initial = initialSession();
  return {
    roomCode: "AB12",
    playerId: "psychic",
    displayName: "Psychic",
    isOwner: true,
    status: "playing",
    redrawAvailable: true,
    winningScore: 20,
    psychicTimerEnabled: false,
    roomLocked: false,
    selectedPackIds: ["core"],
    readyState: initial.readyState,
    rematchState: initial.rematchState,
    awaitingNextRound: false,
    players: [],
    gameMode: "individual",
    teamCount: 2,
    teams: [],
    finalState: null,
    currentRound: {
      roundNumber: 3,
      psychicId: "psychic",
      card: changedCard ? cardB : cardA,
      clue: revealed ? "accepted clue" : null,
      status: revealed ? "revealed" : "waiting",
      activeTeamId: null,
      controllerId: null,
      revealData: revealed ? result : null,
      redrawUsed: changedCard,
      redrawAvailable: true,
      timerEndsAt: null,
      timerPhase: null,
      hasSubmitted: false,
      hasRated: false,
      myRatingVote: null,
      shouldPromptRating: false,
      myGuessAngle: null,
      psychicTargetAngle: 90,
    },
  };
}

function renderReveal(store: ReturnType<typeof makeStore>) {
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <GameMenuProvider>
        <Reveal />
      </GameMenuProvider>
    </GameProvider>,
  );
}

it("settles the existing reveal when recovery arrives before its scores stage", () => {
  vi.useFakeTimers();
  const store = makeStore(true);
  renderReveal(store);
  act(() => {
    vi.advanceTimersByTime(100);
  });
  act(() => {
    store.dispatch({ type: "server", event: "reconnect_success", data: snapshot(true) });
  });
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(document.querySelector(".reveal-score-card")?.className).toContain("is-visible");
  expect(document.querySelector(".reveal-closest")?.className).toContain("is-visible");
  expect(vi.getTimerCount()).toBe(0);
});

it("settles a spectator reveal when a watch snapshot replaces the live event", () => {
  vi.useFakeTimers();
  const store = makeStore(true);
  store.dispatch({ type: "navigate", screen: "spectator" });
  renderReveal(store);
  act(() => {
    vi.advanceTimersByTime(100);
  });
  act(() => {
    store.dispatch({
      type: "server",
      event: "watch_success",
      data: {
        roomCode: "AB12",
        status: "playing",
        redrawAvailable: true,
        winningScore: 20,
        players: [],
        gameMode: "individual",
        teamCount: 2,
        teams: [],
        currentRound: {
          roundNumber: 3,
          psychicId: "psychic",
          card: cardA,
          clue: "accepted clue",
          status: "revealed",
          activeTeamId: null,
          controllerId: null,
          previewAngle: null,
          redrawUsed: false,
          redrawAvailable: true,
          revealData: result,
        },
        readyState: initialSession().readyState,
        finalState: null,
      },
    });
  });
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(document.querySelector(".reveal-score-card")?.className).toContain("is-visible");
});

it("clears a discarded card's draft when recovery discovers a missed redraw", () => {
  const store = makeStore();
  store.dispatch({ type: "server", event: "reconnect_success", data: snapshot(false, true) });
  const next = store.getSnapshot();
  expect(next.round.card?.id).toBe(cardB.id);
  expect(next.clueDraft).toBe("");
  expect(next.round.myAngle).toBe(90);
  expect(next.round.previewAngle).toBeNull();
});

it("keeps the draft and dial state when the recovered card is unchanged", () => {
  const store = makeStore();
  store.dispatch({ type: "server", event: "reconnect_success", data: snapshot(false) });
  const next = store.getSnapshot();
  expect(next.round.card?.id).toBe(cardA.id);
  expect(next.clueDraft).toBe("old-card clue");
  expect(next.round.myAngle).toBe(35);
});

it("ignores a duplicate redraw once a clue on the replacement card has arrived", () => {
  const store = makeStore();
  const redraw = {
    roundNumber: 3,
    previousCardId: cardA.id,
    card: cardB,
    redrawUsed: true as const,
  };
  store.dispatch({ type: "server", event: "card_redrawn", data: redraw });
  store.dispatch({
    type: "server",
    event: "clue_broadcast",
    data: { clue: "new accepted clue", psychicName: "Psychic" },
  });
  store.dispatch({ type: "server", event: "card_redrawn", data: redraw });
  expect(store.getSnapshot().round.clue).toBe("new accepted clue");
  expect(store.getSnapshot().round.card?.id).toBe(cardB.id);
});

it("ignores a redraw that does not match the card this client holds", () => {
  const store = makeStore();
  store.dispatch({
    type: "server",
    event: "card_redrawn",
    data: { roundNumber: 3, previousCardId: cardB.id, card: cardA, redrawUsed: true },
  });
  expect(store.getSnapshot().round.card?.id).toBe(cardA.id);
  expect(store.getSnapshot().round.redrawUsed).toBe(false);
});

it("resets the local practice dial when a live replacement lands", () => {
  const store = makeStore();
  store.dispatch({ type: "draft", angle: 120 });
  expect(store.getSnapshot().round.myAngle).toBe(120);
  store.dispatch({
    type: "server",
    event: "card_redrawn",
    data: { roundNumber: 3, previousCardId: cardA.id, card: cardB, redrawUsed: true },
  });
  const next = store.getSnapshot();
  expect(next.round.card?.id).toBe(cardB.id);
  expect(next.round.myAngle).toBe(90);
  expect(next.round.previewAngle).toBeNull();
  expect(next.clueDraft).toBe("");
});
