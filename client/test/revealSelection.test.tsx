// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Reveal } from "../src/ui/PlayScene";
import { createSessionStore, initialSession, type SessionState } from "../src/session/store";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function guess(playerId: string, displayName: string, angle: number | null, points: number) {
  return { playerId, displayName, angle, points };
}

function baseReveal() {
  return {
    targetAngle: 90,
    guesses: [
      guess("one", "الأول", 20, 0),
      guess("two", "الثاني", 86, 3),
      guess("three", "الثالث", 150, 0),
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

function mount(overrides: Partial<SessionState> = {}) {
  const store = createSessionStore({
    ...initialSession(),
    connection: "connected",
    playerId: "two",
    revealFresh: false,
    round: { ...initialSession().round, roundNumber: 4, psychicId: "one" },
    revealData: baseReveal(),
    ...overrides,
  });
  const view = render(
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
  return { store, view };
}

function dimmedNeedles() {
  return document.querySelectorAll("g.is-dimmed").length;
}

it("starts on the local player's guess and dims the other needles", () => {
  mount();
  const mine = screen.getByRole("button", { name: /الثاني/ });
  expect(mine.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: /الأول/ }).getAttribute("aria-pressed")).toBe("false");
  expect(dimmedNeedles()).toBe(2);
});

it("moves the highlight when another row is chosen and clears it with show all", () => {
  mount();
  const other = screen.getByRole("button", { name: /الثالث/ });
  fireEvent.click(other);
  expect(other.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelectorAll("g.is-dimmed").length).toBe(2);
  expect(document.querySelector('g[data-player-id="one"]')?.getAttribute("class")).toContain(
    "is-dimmed",
  );

  const showAll = screen.getByRole("button", { name: "عرض كل الإجابات" });
  fireEvent.click(showAll);
  expect(dimmedNeedles()).toBe(0);
  expect(screen.queryByRole("button", { name: "عرض كل الإجابات" })).toBeNull();
  expect(screen.getByRole("button", { name: /الثاني/ }).getAttribute("aria-pressed")).toBe("false");
});

it("shows every needle when the local player did not submit", () => {
  mount({
    playerId: "three",
    revealData: {
      ...baseReveal(),
      guesses: [
        guess("one", "الأول", 20, 0),
        guess("two", "الثاني", 86, 3),
        guess("three", "الثالث", null, 0),
      ],
    },
  });
  expect(dimmedNeedles()).toBe(0);
  expect(screen.queryByRole("button", { name: "عرض كل الإجابات" })).toBeNull();
  const absent = screen.getByRole("button", { name: /الثالث/ });
  expect(absent.getAttribute("aria-label")).toContain("لم يجب");
  fireEvent.click(absent);
  expect(dimmedNeedles()).toBe(2);
});

it("keeps team results non-selectable", () => {
  mount({
    gameMode: "teams",
    teams: [
      { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 9 },
      { id: "team-2", name: "الصقور", color: "#00B894", score: 6 },
    ],
    revealData: {
      ...baseReveal(),
      guesses: [{ playerId: "one", teamId: "team-1", displayName: "النجوم", angle: 86, points: 3 }],
      updatedTeams: [
        { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 9 },
        { id: "team-2", name: "الصقور", color: "#00B894", score: 6 },
      ],
      updatedScores: [],
      gameMode: "teams" as const,
      activeTeamId: "team-1",
    },
  });
  const card = document.querySelector(".reveal-score-card");
  expect(card).not.toBeNull();
  expect(within(card as HTMLElement).queryAllByRole("button")).toHaveLength(0);
  expect(document.querySelectorAll("g.is-dimmed").length).toBe(0);
});
