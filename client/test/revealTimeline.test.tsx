// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Dial } from "../src/ui/Dial";
import { pointOnDial } from "../src/ui/dialGeometry";
import { PlayScene, Reveal } from "../src/ui/PlayScene";
import { createSessionStore, initialSession } from "../src/session/store";
import { playReveal, playScore } from "../src/session/audio";

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
  result = "revealed",
}: {
  playerId?: string;
  fresh?: boolean;
  screen?: string;
  /** `playing` mounts the scene mid-turn, before any result has arrived for it. */
  result?: "revealed" | "playing";
} = {}) {
  const store = createSessionStore({
    ...initialSession(),
    connection: "connected",
    playerId,
    currentScreen: currentScreen as never,
    revealData: result === "revealed" ? revealData() : null,
    revealFresh: result === "revealed" && fresh,
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

it("starts a fresh reveal at stage zero on a scene that was already playing", () => {
  vi.useFakeTimers();
  const { store } = mount({ screen: "game-player", result: "playing" });
  // The scene is mounted mid-turn: nothing of the result exists yet, and the dial is live.
  const dial = document.querySelector(".dial-svg");
  expect(dial).toBeTruthy();
  expect(document.querySelector(".reveal-score-card")).toBeNull();

  act(() => {
    store.dispatch({ type: "server", event: "reveal_phase", data: revealData() });
  });
  const handoff = () => document.querySelector(".reveal-handoff");
  // Stage zero: the same dial, the answer zone still hidden, no scores and no controls.
  expect(document.querySelector(".dial-svg")).toBe(dial);
  expect(classes(".dial-zones-reveal")).not.toContain("is-visible");
  expect(document.querySelector('g[data-player-id="two"]')).toBeTruthy();
  expect(document.querySelector('g[data-player-id="three"]')).toBeNull();
  expect(classes(".reveal-closest")).not.toContain("is-visible");
  expect(classes(".reveal-score-card")).not.toContain("is-visible");
  expect(classes(".reveal-handoff")).not.toContain("is-visible");
  expect(handoff()?.hasAttribute("inert")).toBe(true);
  expect(handoff()?.getAttribute("aria-hidden")).toBe("true");
  expect(playReveal).not.toHaveBeenCalled();
  expect(playScore).not.toHaveBeenCalled();

  // The stages still arrive on the shared timeline: the reset does not stall the sequence.
  act(() => {
    vi.advanceTimersByTime(180);
  });
  expect(playReveal).toHaveBeenCalledTimes(1);
  expect(classes(".dial-zones-reveal")).toContain("is-visible");
  expect(classes(".reveal-score-card")).not.toContain("is-visible");
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(document.querySelector('g[data-player-id="three"]')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(320);
  });
  expect(classes(".reveal-score-card")).toContain("is-visible");
  expect(playScore).toHaveBeenCalledTimes(1);
  expect(handoff()?.hasAttribute("inert")).toBe(true);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(classes(".reveal-handoff")).toContain("is-visible");
  expect(handoff()?.hasAttribute("inert")).toBe(false);
});

it("keeps a duplicate reveal after recovery settled and never fresh again", () => {
  vi.useFakeTimers();
  const { store } = mount({ fresh: false });
  // The player has already moved on to the final results and newer readiness has arrived.
  act(() => {
    store.dispatch({
      type: "server",
      event: "round_ready_updated",
      data: {
        playerIds: ["two"],
        readyCount: 1,
        requiredCount: 3,
        endsAt: null,
        paused: true,
        remainingMs: 30_000,
      },
    });
    store.dispatch({ type: "navigate", screen: "winner" });
  });
  // The mounted dial's initial settle runs once; afterwards nothing is waiting.
  act(() => {
    vi.advanceTimersByTime(0);
  });
  expect(vi.getTimerCount()).toBe(0);
  const ready = store.getSnapshot().readyState;
  const scores = store.getSnapshot().preRevealScores;

  act(() => {
    store.dispatch({ type: "server", event: "reveal_phase", data: revealData() });
  });
  const state = store.getSnapshot();
  expect(state.revealFresh).toBe(false);
  expect(state.currentScreen).toBe("winner");
  expect(state.readyState).toEqual(ready);
  expect(state.preRevealScores).toEqual(scores);
  // A restored result is already settled, and a duplicate neither animates nor plays a cue.
  expect(classes(".reveal-closest")).toContain("is-visible");
  expect(classes(".reveal-score-card")).toContain("is-visible");
  expect(classes(".reveal-handoff")).toContain("is-visible");
  expect(playReveal).not.toHaveBeenCalled();
  expect(playScore).not.toHaveBeenCalled();
  // No stage timer was armed: a duplicate never restarts the sequence.
  expect(vi.getTimerCount()).toBe(0);
});

it("sweeps only for a newly confirmed move and settles immediately on recovery", () => {
  vi.useFakeTimers();
  const view = render(<Dial targetAngle={150} animateTarget moveToken={2} />);
  expect(document.querySelector(".dial-zones-rotor")?.getAttribute("style")).toContain(
    "rotate(60deg)",
  );

  // A rising token is a confirmed change: it sweeps, then pulses as it lands.
  view.rerender(<Dial targetAngle={30} animateTarget moveToken={3} />);
  expect(classes(".dial-zone-labels")).toContain("is-moving");
  act(() => {
    vi.advanceTimersByTime(0);
  });
  expect(classes(".dial-zones-rotor")).toContain("is-moving");
  expect(classes(".dial-zone-labels")).toContain("is-moving");
  act(() => {
    vi.advanceTimersByTime(450);
  });
  expect(classes(".dial-zones-rotor")).toContain("is-landing");
  act(() => {
    vi.advanceTimersByTime(150);
  });
  expect(classes(".dial-zones-rotor")).not.toContain("is-moving");
  expect(classes(".dial-zones-rotor")).not.toContain("is-landing");

  // Recovery drops the token back to zero and restores the authoritative position at once.
  view.rerender(<Dial targetAngle={150} animateTarget moveToken={0} />);
  act(() => {
    vi.advanceTimersByTime(0);
  });
  expect(document.querySelector(".dial-zones-rotor")?.getAttribute("style")).toContain(
    "rotate(60deg)",
  );
  expect(classes(".dial-zones-rotor")).not.toContain("is-moving");
  expect(classes(".dial-zone-labels")).not.toContain("is-moving");
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  // No sweep, no hidden numbers and no landing pulse: the reset is not a move.
  expect(classes(".dial-zones-rotor")).not.toContain("is-moving");
  expect(classes(".dial-zones-rotor")).not.toContain("is-landing");
  expect(classes(".dial-zone-labels")).not.toContain("is-moving");
});

it("centers scoring numbers in the visible band when the target nears either endpoint", () => {
  const view = render(<Dial targetAngle={12} />);
  const yellowLabels = () =>
    [...document.querySelectorAll(".dial-zone-label")].filter((label) => label.textContent === "2");
  expect(yellowLabels()).toHaveLength(2);
  expect(Number(yellowLabels()[0]?.getAttribute("x"))).toBeCloseTo(pointOnDial(3, 129.6).x);

  view.rerender(<Dial targetAngle={168} />);
  expect(yellowLabels()).toHaveLength(2);
  expect(Number(yellowLabels()[1]?.getAttribute("x"))).toBeCloseTo(pointOnDial(177, 129.6).x);
});
