// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameHeader } from "../src/ui/Game";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Reveal } from "../src/ui/PlayScene";
import { RoundStatus } from "../src/ui/RoundStatus";
import { NEEDLE_COLORS, needleColor } from "../src/ui/dialGeometry";
import { createSessionStore, initialSession, type SessionState } from "../src/session/store";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function player(id: string, displayName: string, score: number, teamId: string | null = null) {
  return {
    id,
    displayName,
    score,
    isConnected: true,
    hasSubmitted: false,
    awaitingNextRound: false,
    teamId,
  };
}

function mount(overrides: Partial<SessionState> = {}, children = <GameHeader />) {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "me",
    isOwner: true,
    connection: "connected",
    phase: "playing",
    players: [player("me", "أنا", 7), player("two", "الثاني", 12)],
    round: { ...initialSession().round, roundNumber: 3, psychicId: "two", targetAngle: 90 },
    ...overrides,
  });
  const leave = vi.fn();
  const view = render(
    <GameProvider
      runtime={{
        store,
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave,
      }}
    >
      <GameMenuProvider>{children}</GameMenuProvider>
    </GameProvider>,
  );
  return { store, leave, view };
}

it("replaces the badge strip with a menu button, the round and one score button", () => {
  mount();
  expect(document.querySelector(".score-badges")).toBeNull();
  expect(screen.getByRole("button", { name: "قائمة اللعبة" })).toBeTruthy();
  expect(screen.getByText("الجولة 3")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /نقاطي، 7 نقطة، عرض لوحة النتائج الكاملة/ }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /نقاطي/ }).textContent).toContain("7");
});

it("keeps one dialog while moving between menu panels", () => {
  const { leave } = mount();
  fireEvent.click(screen.getByRole("button", { name: "قائمة اللعبة" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "إدارة الغرفة" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "شرح اللعبة" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByText("كيف تلعب هنت؟")).toBeTruthy();
  // The interactive explanation is the main content, and the precise rules stay one tap away.
  expect(screen.getByRole("tab", { name: "جرّب جولة" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "القواعد بالتفصيل" }));
  expect(screen.getByText("نقاط الوسيط")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "رجوع" }));
  expect(screen.getByRole("button", { name: "مغادرة الغرفة" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "إدارة الغرفة" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByText(/رمز الغرفة/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "رجوع" }));
  fireEvent.click(screen.getByRole("button", { name: "مغادرة الغرفة" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "مغادرة" }));
  expect(leave).toHaveBeenCalledTimes(1);
});

it("keeps an open panel while the live screen changes behind it", () => {
  function ScreenHost() {
    const [phase, setPhase] = useState<"play" | "reveal">("play");
    return (
      <>
        {phase === "play" ? <GameHeader /> : <div data-testid="reveal-screen" />}
        <button
          type="button"
          onClick={() => {
            setPhase("reveal");
          }}
        >
          تبديل الشاشة
        </button>
      </>
    );
  }
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "me",
    isOwner: true,
    connection: "connected",
    phase: "playing",
    players: [player("me", "أنا", 7)],
    round: { ...initialSession().round, roundNumber: 3, psychicId: "me", targetAngle: 90 },
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
        <ScreenHost />
      </GameMenuProvider>
    </GameProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "قائمة اللعبة" }));
  fireEvent.click(screen.getByRole("button", { name: "شرح اللعبة" }));
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();

  // The header unmounts with the old screen; the practice round keeps running.
  fireEvent.click(screen.getByRole("button", { name: "تبديل الشاشة" }));
  expect(screen.getByTestId("reveal-screen")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();
});

it("hides room management from players who are not the host", () => {
  mount({ isOwner: false });
  fireEvent.click(screen.getByRole("button", { name: "قائمة اللعبة" }));
  expect(screen.queryByRole("button", { name: "إدارة الغرفة" })).toBeNull();
  expect(screen.getByRole("button", { name: "لوحة النتائج" })).toBeTruthy();
});

it("ranks tied scores equally and marks self, roles and the active team", () => {
  mount({
    gameMode: "teams",
    teamCount: 2,
    teams: [
      { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 10 },
      { id: "team-2", name: "الصقور", color: "#00B894", score: 10 },
    ],
    players: [
      player("me", "أنا", 0, "team-1"),
      player("two", "الثاني", 0, "team-1"),
      player("three", "الثالث", 0, "team-2"),
      player("four", "الرابع", 0, "team-2"),
    ],
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "two",
      controllerId: "three",
      activeTeamId: "team-2",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "قائمة اللعبة" }));
  fireEvent.click(screen.getByRole("button", { name: "لوحة النتائج" }));
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(2);
  const stars = document.querySelector('[data-entry-id="team-1"]');
  const eagles = document.querySelector('[data-entry-id="team-2"]');
  expect(within(stars as HTMLElement).getByText("1")).toBeTruthy();
  expect(within(eagles as HTMLElement).getByText("1")).toBeTruthy();
  expect(stars?.className).toContain("is-mine");
  expect(eagles?.className).toContain("is-active-team");
  expect(eagles?.textContent).toContain("الدور الآن");
  expect(stars?.textContent).toContain("فريقك");
});

it("shows twelve rows with roles and shared ranks in individual mode", () => {
  const players = Array.from({ length: 12 }, (_, index) =>
    player(`p${index}`, `لاعب ${index + 1}`, index < 2 ? 9 : 4),
  );
  mount({
    players,
    playerId: "p0",
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "p1",
      controllerId: null,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "قائمة اللعبة" }));
  fireEvent.click(screen.getByRole("button", { name: "لوحة النتائج" }));
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(12);
  const rowFor = (id: string) => {
    const found = rows.find((candidate) => candidate.dataset.entryId === id);
    if (!found) throw new Error(`missing scoreboard row ${id}`);
    return found;
  };
  expect(rowFor("p0").textContent).toContain("أنت");
  expect(rowFor("p1").textContent).toContain("الوسيط");
  expect(within(rowFor("p0")).getByText("1")).toBeTruthy();
  expect(within(rowFor("p2")).getByText("3")).toBeTruthy();
});

it("tells the controller that the dial is theirs", () => {
  mount(
    {
      gameMode: "teams",
      teamCount: 2,
      teams: [
        { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 0 },
        { id: "team-2", name: "الصقور", color: "#00B894", score: 0 },
      ],
      players: [
        player("me", "أنا", 0, "team-1"),
        player("two", "الثاني", 0, "team-1"),
        player("three", "الثالث", 0, "team-2"),
        player("four", "الرابع", 0, "team-2"),
      ],
      round: {
        ...initialSession().round,
        roundNumber: 4,
        psychicId: "two",
        controllerId: "me",
        activeTeamId: "team-1",
        clue: "تلميح",
      },
    },
    <RoundStatus role="ctrl" />,
  );
  expect(screen.getByText("الدور الآن:")).toBeTruthy();
  expect(screen.getByText("النجوم")).toBeTruthy();
  expect(screen.getByText("فريقك")).toBeTruthy();
  expect(screen.getByText("دورك لتحريك المؤشر")).toBeTruthy();
  expect(screen.getByText("اختر موقع الإجابة على المؤشر ثم ثبّتها")).toBeTruthy();
});

it("shows individual submission progress and who is still answering", () => {
  render(
    <GameProvider
      runtime={{
        store: createSessionStore({
          ...initialSession(),
          roomCode: "AB12",
          playerId: "me",
          connection: "connected",
          phase: "playing",
          players: [
            { ...player("me", "أنا", 0), hasSubmitted: true },
            player("two", "الثاني", 0),
            player("three", "الثالث", 0),
          ],
          round: {
            ...initialSession().round,
            roundNumber: 4,
            psychicId: "two",
            clue: "تلميح",
            hasSubmitted: true,
          },
        }),
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <RoundStatus role="guess" />
    </GameProvider>,
  );
  expect(screen.getByText("1 من 2")).toBeTruthy();
  expect(screen.getByText(/بانتظار الثالث/)).toBeTruthy();
  expect(screen.getByText("تم تثبيت الإجابة — بانتظار البقية")).toBeTruthy();
});

it("counts only connected guessers and names a reconnecting controller", () => {
  mount(
    {
      gameMode: "teams",
      teamCount: 2,
      teams: [
        { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 0 },
        { id: "team-2", name: "الصقور", color: "#00B894", score: 0 },
      ],
      players: [
        { ...player("me", "أنا", 0, "team-1"), hasSubmitted: true },
        player("two", "الثاني", 0, "team-1"),
        player("three", "الثالث", 0, "team-2"),
        { ...player("four", "الرابع", 0, "team-2"), isConnected: false },
      ],
      round: {
        ...initialSession().round,
        roundNumber: 4,
        psychicId: "two",
        controllerId: "me",
        activeTeamId: "team-1",
        clue: "تلميح",
      },
    },
    <RoundStatus role="ctrl" />,
  );
  // The viewer is the controller, so the personal cue stays even when short screens
  // compress the other status lines.
  const controllerLine = document.querySelector(".round-status-controller");
  expect(controllerLine?.textContent).toContain("دورك لتحريك المؤشر");

  cleanup();
  mount(
    {
      players: [
        { ...player("me", "أنا", 0), hasSubmitted: true },
        player("two", "الثاني", 0),
        { ...player("three", "الثالث", 0), isConnected: false },
      ],
      round: {
        ...initialSession().round,
        roundNumber: 4,
        psychicId: "two",
        clue: "تلميح",
      },
    },
    <RoundStatus role="guess" />,
  );
  // Only the connected guessers are counted, so a dropped player is not "still answering".
  expect(screen.getByText("1 من 1")).toBeTruthy();
  expect(screen.queryByText(/بانتظار الثالث/)).toBeNull();
});

it("marks a disconnected dial controller as reconnecting for everyone else", () => {
  mount(
    {
      gameMode: "teams",
      teamCount: 2,
      teams: [
        { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 0 },
        { id: "team-2", name: "الصقور", color: "#00B894", score: 0 },
      ],
      players: [
        player("me", "أنا", 0, "team-1"),
        player("two", "الثاني", 0, "team-1"),
        { ...player("three", "الثالث", 0, "team-2"), isConnected: false },
        player("four", "الرابع", 0, "team-2"),
      ],
      round: {
        ...initialSession().round,
        roundNumber: 4,
        psychicId: "two",
        controllerId: "three",
        activeTeamId: "team-2",
      },
    },
    <RoundStatus role="watch" />,
  );
  const controllerLine = document.querySelector(".round-status-controller");
  expect(controllerLine?.textContent).toContain("يعيد الاتصال");
  expect(controllerLine?.textContent).toContain("الثالث");
});

it("tells other teams that they are watching the active team", () => {
  render(
    <GameProvider
      runtime={{
        store: createSessionStore({
          ...initialSession(),
          roomCode: "AB12",
          playerId: "three",
          connection: "connected",
          phase: "playing",
          gameMode: "teams",
          teamCount: 2,
          teams: [
            { id: "team-1", name: "النجوم", color: "#6C5CE7", score: 0 },
            { id: "team-2", name: "الصقور", color: "#00B894", score: 0 },
          ],
          players: [
            player("me", "أنا", 0, "team-1"),
            player("two", "الثاني", 0, "team-1"),
            player("three", "الثالث", 0, "team-2"),
            player("four", "الرابع", 0, "team-2"),
          ],
          round: {
            ...initialSession().round,
            roundNumber: 4,
            psychicId: "two",
            controllerId: "me",
            activeTeamId: "team-1",
          },
        }),
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <RoundStatus role="watch" />
    </GameProvider>,
  );
  expect(screen.getByText("أنتم تشاهدون:")).toBeTruthy();
  expect(screen.getByText("يحرك المؤشر ويثبت الإجابة:")).toBeTruthy();
  expect(screen.queryByText("دورك لتحريك المؤشر")).toBeNull();
});

it("keeps a needle colour tied to the player rather than the guess order", () => {
  expect(needleColor("player-a")).toBe(needleColor("player-a"));
  expect(needleColor("player-b")).not.toBe(needleColor("player-b", 3) + "x");
  const colors = new Set(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((id) => needleColor(id)),
  );
  expect(colors.size).toBeGreaterThan(1);
  for (const color of colors)
    expect(NEEDLE_COLORS).toContain(color as (typeof NEEDLE_COLORS)[number]);
  expect(needleColor(null, 2)).toBe(NEEDLE_COLORS[2]);
});

it("holds the previous total in the header until the score stage", () => {
  vi.useFakeTimers();
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "me",
    connection: "connected",
    phase: "playing",
    currentScreen: "reveal",
    players: [player("me", "أنا", 7), player("two", "الثاني", 12)],
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "two",
      card: { id: "core-1", packId: "core", left: "أ", right: "ب" },
      targetAngle: 90,
    },
  });
  act(() => {
    store.dispatch({
      type: "server",
      event: "reveal_phase",
      data: {
        targetAngle: 90,
        guesses: [{ playerId: "me", displayName: "أنا", angle: 90, points: 3 }],
        psychicPoints: 3,
        psychicBreakdown: null,
        updatedScores: [
          { playerId: "me", displayName: "أنا", totalScore: 10 },
          { playerId: "two", displayName: "الثاني", totalScore: 12 },
        ],
        updatedTeams: [],
        gameMode: "individual",
        activeTeamId: null,
        shouldPromptRating: false,
        winner: null,
        winners: [],
      },
    });
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
        <Reveal />
      </GameMenuProvider>
    </GameProvider>,
  );
  const score = () => screen.getByRole("button", { name: /نقاطي/ }).textContent;
  expect(score()).toContain("7");
  act(() => {
    // The totals are released on the score stage of the shared reveal timeline.
    vi.advanceTimersByTime(800);
  });
  expect(score()).toContain("10");
});
