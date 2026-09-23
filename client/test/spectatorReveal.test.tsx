// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RevealData } from "@hint/contracts";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Spectator } from "../src/ui/PlayScene";
import { createSessionStore, initialSession, type SessionState } from "../src/session/store";

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

const winningReveal: RevealData = {
  targetAngle: 90,
  guesses: [{ playerId: "two", displayName: "الثاني", angle: 92, points: 3 }],
  psychicPoints: 3,
  psychicBreakdown: null,
  updatedScores: [{ playerId: "two", displayName: "الثاني", totalScore: 30 }],
  updatedTeams: [],
  gameMode: "individual",
  activeTeamId: null,
  shouldPromptRating: false,
  winner: { playerId: "two", displayName: "الثاني", score: 30 },
  winners: [{ playerId: "two", displayName: "الثاني", score: 30 }],
};

function mountSpectator(overrides: Partial<SessionState> = {}) {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    isSpectator: true,
    playerId: null,
    connection: "connected",
    phase: "finished",
    currentScreen: "spectator",
    players: [
      {
        id: "two",
        displayName: "الثاني",
        score: 30,
        isConnected: true,
        hasSubmitted: true,
        awaitingNextRound: false,
        teamId: null,
      },
    ],
    finalState: {
      ...winningReveal,
      winner: { playerId: "two", displayName: "الثاني", score: 30 },
      winners: [{ playerId: "two", displayName: "الثاني", score: 30 }],
      awards: [],
      matchRoundCount: 3,
    },
    ...overrides,
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
        <Spectator />
      </GameMenuProvider>
    </GameProvider>,
  );
  return store;
}

it("shows the winning round reveal to a spectator before the standings", () => {
  vi.useFakeTimers();
  const store = mountSpectator({ revealData: winningReveal, revealFresh: true });
  expect(document.querySelector(".reveal-screen")).not.toBeNull();
  expect(screen.queryByRole("heading", { name: "النتائج النهائية" })).toBeNull();

  act(() => {
    vi.advanceTimersByTime(1_200);
  });
  expect(document.querySelector(".reveal-score-card")?.className).toContain("is-visible");
  expect(screen.getByText("انتهت المباراة")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "عرض النتائج النهائية" }));
  expect(store.getSnapshot().currentScreen).toBe("winner");
});

it("opens restored finished matches on the standings without a reveal", () => {
  mountSpectator({ revealData: null });
  expect(screen.getByRole("heading", { name: "النتائج النهائية" })).toBeTruthy();
  expect(document.querySelector(".reveal-screen")).toBeNull();
});

it("settles a recovered winning reveal immediately", () => {
  vi.useFakeTimers();
  mountSpectator({ revealData: winningReveal, revealFresh: false });
  expect(document.querySelector(".reveal-score-card")?.className).toContain("is-visible");
  expect(document.querySelector(".reveal-closest")?.className).toContain("is-visible");
  expect(vi.getTimerCount()).toBe(0);
});
