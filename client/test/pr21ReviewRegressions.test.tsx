// @vitest-environment jsdom
/**
 * The two reproductions from the independent PR #21 review, kept as permanent regressions:
 * the practice round must score every player against the card that is on the dial, and a
 * rename rejection must never appear on a team the server did not blame.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PracticeWalkthrough } from "../src/ui/Tutorial";
import { Lobby } from "../src/ui/Lobby";
import { GameProvider } from "../src/ui/GameContext";
import { createSessionStore, initialSession } from "../src/session/store";

afterEach(cleanup);

it("review: free-play other-player score matches the active target", () => {
  render(<PracticeWalkthrough />);
  fireEvent.click(screen.getByRole("button", { name: "التالي" }));
  fireEvent.click(screen.getByRole("button", { name: "جرّب التخمين" }));
  fireEvent.click(screen.getByRole("button", { name: "اكشف الهدف" }));
  fireEvent.click(screen.getByRole("button", { name: "جرّب بنفسك" }));
  fireEvent.click(screen.getByRole("button", { name: "تأكيد الإجابة" }));
  const ahmad = screen.getAllByText("أحمد").find((element) => element.closest("li"));
  const row = ahmad?.closest("li");
  // The active free card's target is 152, Ahmad's angle 158: distance 6 earns 3.
  expect(row?.textContent).toContain("3 نقاط");
});

it("review: a rejected rename does not display an error on an untouched team", () => {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "owner",
    isOwner: true,
    currentScreen: "lobby",
    connection: "connected",
    gameMode: "teams",
    teamCount: 2,
    teams: [
      { id: "team-1", name: "الفريق ١", color: "#6C5CE7", score: 0 },
      { id: "team-2", name: "النجوم", color: "#00B894", score: 0 },
    ],
    players: [
      {
        id: "owner",
        displayName: "المضيف",
        score: 0,
        isConnected: true,
        hasSubmitted: false,
        awaitingNextRound: false,
        teamId: "team-1",
      },
    ],
  });
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <Lobby />
    </GameProvider>,
  );
  const first = document.querySelector('[data-team-id="team-1"]');
  const second = document.querySelector('[data-team-id="team-2"]');
  if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement))
    throw new Error("missing team cards");
  fireEvent.click(within(first).getByRole("button", { name: "تعديل الاسم" }));
  fireEvent.change(within(first).getByLabelText(/اسم/), { target: { value: "الصقور" } });
  fireEvent.click(within(first).getByRole("button", { name: "حفظ" }));
  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE", teamId: "team-1" },
    });
  });
  expect(within(first).getByRole("alert")).toBeTruthy();
  expect(within(second).queryByRole("alert")).toBeNull();
});
