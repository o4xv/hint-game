// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Reveal, Winner } from "../src/ui/Results";
import { Guessing } from "../src/ui/Game";
import { createSessionStore, initialSession } from "../src/session/store";
import { playReveal, playScore, playTick, playWinner } from "../src/session/audio";

vi.mock("../src/session/audio", () => ({
  playReveal: vi.fn(),
  playScore: vi.fn(),
  playTick: vi.fn(),
  playWinner: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function revealData() {
  return {
    targetAngle: 90,
    guesses: [{ playerId: "one", displayName: "لاعب", angle: 90, points: 3 }],
    psychicPoints: 4,
    psychicBreakdown: null,
    updatedScores: [],
    updatedTeams: [],
    gameMode: "individual" as const,
    activeTeamId: null,
    shouldPromptRating: false,
    winner: null,
    winners: [],
  };
}

/** `restored` mounts an already-revealed round, the way a reconnect snapshot arrives. */
function mount(children: ReactNode, { restored = false } = {}) {
  const state = initialSession();
  const store = createSessionStore({
    ...state,
    connection: "connected",
    ...(restored ? { revealData: revealData(), revealFresh: false } : {}),
  });
  if (!restored) {
    store.dispatch({
      type: "server",
      event: "reveal_phase",
      data: revealData(),
    });
  }
  return {
    store,
    ...render(
      <StrictMode>
        <GameProvider
          runtime={{
            store,
            controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
            leave: vi.fn(),
          }}
        >
          <GameMenuProvider>{children}</GameMenuProvider>
        </GameProvider>
      </StrictMode>,
    ),
  };
}

it("plays reveal and score once through StrictMode and unrelated readiness updates", () => {
  vi.useFakeTimers();
  const { store } = mount(<Reveal />);
  act(() => {
    vi.advanceTimersByTime(520);
  });
  expect(playReveal).toHaveBeenCalledTimes(1);
  expect(playScore).toHaveBeenCalledExactlyOnceWith(3);
  act(() => {
    store.dispatch({ type: "connection", status: "recovering" });
    vi.advanceTimersByTime(2000);
  });
  expect(playReveal).toHaveBeenCalledTimes(1);
  expect(playScore).toHaveBeenCalledTimes(1);
});

it("cancels the pending score cue when leaving the reveal", () => {
  vi.useFakeTimers();
  const view = mount(<Reveal />);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(playReveal).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(playScore).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("opens a restored result settled and silent", () => {
  vi.useFakeTimers();
  mount(<Reveal />, { restored: true });
  act(() => {
    vi.advanceTimersByTime(1_200);
  });
  expect(playReveal).not.toHaveBeenCalled();
  expect(playScore).not.toHaveBeenCalled();
  const closest = document.querySelector(".reveal-closest");
  expect(closest?.className).toContain("is-visible");
  expect(document.querySelector(".reveal-score-card")?.className).toContain("is-visible");
});

it("settles the whole reveal within roughly one second", () => {
  vi.useFakeTimers();
  mount(<Reveal />);
  const card = document.querySelector(".reveal-score-card");
  const closest = document.querySelector(".reveal-closest");
  expect(closest?.className).not.toContain("is-visible");
  expect(card?.className).not.toContain("is-visible");
  act(() => {
    vi.advanceTimersByTime(280);
  });
  expect(document.querySelector(".reveal-closest")?.className).toContain("is-visible");
  expect(document.querySelector(".reveal-score-card")?.className).not.toContain("is-visible");
  act(() => {
    vi.advanceTimersByTime(670);
  });
  expect(document.querySelector(".reveal-score-card")?.className).toContain("is-visible");
  expect(vi.getTimerCount()).toBe(0);
});

it("plays the winner cue once when the results screen opens", () => {
  vi.useFakeTimers();
  mount(<Winner />);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(playWinner).toHaveBeenCalledTimes(1);
});

it("connects the playable dial to the tick sound", () => {
  localStorage.setItem("hint_first_round_coach_v2_guesser", "1");
  mount(<Guessing />);
  fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
  expect(playTick).toHaveBeenCalledTimes(1);
  localStorage.removeItem("hint_first_round_coach_v2_guesser");
});
