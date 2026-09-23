// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { PlayScene, Reveal } from "../src/ui/PlayScene";
import { createSessionStore, initialSession } from "../src/session/store";

vi.mock("../src/session/audio", () => ({
  playReveal: vi.fn(),
  playScore: vi.fn(),
  playTick: vi.fn(),
  playWinner: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeEach(() => {
  for (const key of [
    "hint_intro_seen",
    "hint_first_round_coach_v2_psychic",
    "hint_first_round_coach_v2_guesser",
    "hint_first_round_coach_v2_observer",
  ])
    localStorage.setItem(key, "1");
  // jsdom has no modal dialog implementation; the coach only needs the API to exist.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

function revealData() {
  return {
    targetAngle: 90,
    guesses: [
      { playerId: "one", displayName: "الأول", angle: 20, points: 0 },
      { playerId: "two", displayName: "الثاني", angle: 86, points: 3 },
      { playerId: "three", displayName: "الثالث", angle: 150, points: 0 },
    ],
    psychicPoints: 5,
    psychicBreakdown: null,
    updatedScores: [
      { playerId: "one", displayName: "الأول", totalScore: 10 },
      { playerId: "two", displayName: "الثاني", totalScore: 13 },
      { playerId: "three", displayName: "الثالث", totalScore: 4 },
    ],
    updatedTeams: [],
    gameMode: "individual" as const,
    activeTeamId: null,
    shouldPromptRating: false,
    winner: null,
    winners: [],
  };
}

function mount({
  playerId = "two",
  fresh = true,
  screen: currentScreen = "reveal",
}: { playerId?: string; fresh?: boolean; screen?: string } = {}) {
  const store = createSessionStore({
    ...initialSession(),
    connection: "connected",
    playerId,
    currentScreen: currentScreen as never,
    revealData: revealData(),
    revealFresh: fresh,
    phase: "playing",
    round: { ...initialSession().round, roundNumber: 4, psychicId: "one" },
  });
  const view = render(
    <GameProvider
      runtime={{
        store,
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <GameMenuProvider>{currentScreen === "reveal" ? <Reveal /> : <PlayScene />}</GameMenuProvider>
    </GameProvider>,
  );
  return { store, view };
}

const classes = (selector: string) => document.querySelector(selector)?.getAttribute("class") ?? "";

it("keeps the answer zone and the other needles back until their own stage", () => {
  vi.useFakeTimers();
  mount();
  // Stage 0: the guesser's own needle stays where they put it, and nothing else is shown.
  expect(classes(".dial-zones-reveal")).not.toContain("is-visible");
  expect(document.querySelector(".dial-zones-reveal")?.getAttribute("aria-hidden")).toBe("true");
  expect(document.querySelector('g[data-player-id="two"]')).toBeTruthy();
  expect(document.querySelector('g[data-player-id="three"]')).toBeNull();
  expect(classes(".reveal-closest")).not.toContain("is-visible");
  expect(classes(".reveal-score-card")).not.toContain("is-visible");
  expect(classes(".reveal-handoff")).not.toContain("is-visible");

  act(() => {
    vi.advanceTimersByTime(180);
  });
  expect(classes(".dial-zones-reveal")).toContain("is-visible");
  expect(document.querySelector('g[data-player-id="three"]')).toBeNull();

  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(document.querySelector('g[data-player-id="three"]')).toBeTruthy();
  expect(classes('g[data-player-id="three"]')).toContain("dial-needle-entry");
  expect(classes('g[data-player-id="two"]')).not.toContain("dial-needle-entry");

  act(() => {
    vi.advanceTimersByTime(320);
  });
  expect(classes(".reveal-closest")).toContain("is-visible");
  expect(classes(".reveal-score-card")).toContain("is-visible");
  expect(classes(".reveal-handoff")).not.toContain("is-visible");

  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(classes(".reveal-handoff")).toContain("is-visible");
  expect(document.querySelector(".reveal-handoff")?.hasAttribute("inert")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("never hides the target from the clue giver who already knows it", () => {
  vi.useFakeTimers();
  mount({ playerId: "one" });
  expect(classes(".dial-zones-reveal")).toContain("is-visible");
  expect(classes(".reveal-score-card")).not.toContain("is-visible");
  act(() => {
    vi.advanceTimersByTime(1200);
  });
  expect(classes(".reveal-score-card")).toContain("is-visible");
});

it("collapses the whole sequence to a short fade under reduced motion", () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  mount();
  act(() => {
    vi.advanceTimersByTime(150);
  });
  expect(classes(".reveal-closest")).toContain("is-visible");
  expect(classes(".reveal-score-card")).toContain("is-visible");
  expect(classes(".reveal-handoff")).toContain("is-visible");
  // Every needle is already there: nothing waits for a later stage.
  expect(document.querySelector('g[data-player-id="three"]')).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

it("settles a live reveal that recovery replaced, without replaying the stages", () => {
  vi.useFakeTimers();
  const { store } = mount();
  act(() => {
    vi.advanceTimersByTime(180);
  });
  act(() => {
    store.dispatch({
      type: "server",
      event: "reconnect_success",
      data: {
        roomCode: "AB12",
        playerId: "two",
        displayName: "الثاني",
        isOwner: false,
        status: "playing",
        redrawAvailable: true,
        winningScore: 20,
        psychicTimerEnabled: false,
        roomLocked: false,
        selectedPackIds: ["core"],
        readyState: initialSession().readyState,
        rematchState: initialSession().rematchState,
        awaitingNextRound: false,
        players: [],
        gameMode: "individual",
        teamCount: 2,
        teams: [],
        finalState: null,
        currentRound: {
          roundNumber: 4,
          psychicId: "one",
          card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
          clue: "شاي ساخن",
          status: "revealed",
          activeTeamId: null,
          controllerId: null,
          revealData: revealData(),
          redrawUsed: false,
          redrawAvailable: true,
          timerEndsAt: null,
          timerPhase: null,
          hasSubmitted: true,
          hasRated: false,
          myRatingVote: null,
          shouldPromptRating: false,
          myGuessAngle: 86,
        },
      },
    });
  });
  expect(store.getSnapshot().revealFresh).toBe(false);
  expect(classes(".reveal-closest")).toContain("is-visible");
  expect(classes(".reveal-score-card")).toContain("is-visible");
  expect(classes(".reveal-handoff")).toContain("is-visible");
});

it("keeps one dial mounted from the clue through the reveal and across a target move", () => {
  const store = createSessionStore({
    ...initialSession(),
    connection: "connected",
    playerId: "one",
    currentScreen: "game-psychic",
    phase: "playing",
    round: {
      ...initialSession().round,
      roundNumber: 4,
      psychicId: "one",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      targetRedraw: { supported: true, remaining: 3, usedThisRound: false, revision: 0 },
    },
  });
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <GameMenuProvider>
        <PlayScene />
      </GameMenuProvider>
    </GameProvider>,
  );
  const dial = document.querySelector(".dial-svg");
  expect(dial).toBeTruthy();

  act(() => {
    store.dispatch({
      type: "server",
      event: "target_redrawn",
      data: {
        requestId: "r",
        roundNumber: 4,
        cardId: "core-7",
        previousTargetRevision: 0,
        targetAngle: 30,
        targetRedraw: { supported: true, remaining: 2, usedThisRound: true, revision: 1 },
      },
    });
  });
  expect(document.querySelector(".dial-svg")).toBe(dial);
  expect(classes(".dial-zones-rotor")).toContain("dial-zones-rotor");
  expect(document.querySelector(".dial-zones-rotor")?.getAttribute("style")).toContain(
    "rotate(-60deg)",
  );

  act(() => {
    store.dispatch({
      type: "server",
      event: "reveal_phase",
      data: revealData(),
    });
  });
  // The same dial instance carries the guess, the move and the reveal.
  expect(document.querySelector(".dial-svg")).toBe(dial);
  expect(screen.getByText(/أقرب إجابة/)).toBeTruthy();
});
