// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Winner } from "../src/ui/Results";
import { createSessionStore, initialSession } from "../src/session/store";

beforeEach(() => {
  vi.stubGlobal(
    "navigator",
    Object.create(navigator, {
      share: { configurable: true, get: () => undefined },
      clipboard: { configurable: true, get: () => undefined },
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderResults(
  awards: NonNullable<ReturnType<typeof initialSession>["finalState"]>["awards"] = [],
) {
  const store = createSessionStore({
    ...initialSession(),
    finalState: {
      winner: null,
      winners: [],
      gameMode: "individual",
      updatedTeams: [],
      leaderboard: [{ playerId: "one", displayName: "عبدالله", totalScore: 7 }],
      awards,
      reason: "لا يوجد لاعبون كافيون",
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
        <Winner />
      </GameMenuProvider>
    </GameProvider>,
  );
}

it("puts rematching before the leaderboard and lists each award recipient only once", () => {
  renderResults([
    {
      type: "closest_guess",
      title: "أقرب تخمين",
      value: 0,
      playerIds: ["one", "one", "two"],
      players: [
        { playerId: "one", displayName: "عبدالله" },
        { playerId: "one", displayName: "عبدالله" },
        { playerId: "two", displayName: "عبدالرحمن" },
      ],
    },
  ]);
  const rematch = screen.getByRole("button", { name: "إعادة المباراة" });
  const leaderboard = screen.getByRole("region", { name: "النتيجة النهائية" });
  expect(
    rematch.compareDocumentPosition(leaderboard) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const awards = screen.getByText("جوائز المباراة").closest("details");
  expect(awards).not.toBeNull();
  if (!awards) throw new Error("Missing awards disclosure");
  fireEvent.click(screen.getByText("جوائز المباراة"));
  expect(within(awards).getAllByText("عبدالله")).toHaveLength(1);
  expect(within(awards).getByText("عبدالرحمن")).toBeTruthy();
});

it("shows the authoritative final leaderboard when a match ends early", () => {
  renderResults();
  expect(screen.getByText("عبدالله").closest(".winner-score-row")?.textContent).toContain("7");
  expect(screen.getByText("لا يوجد لاعبون كافيون")).toBeTruthy();
});

it("copies a useful result when native sharing is unavailable", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  renderResults();
  fireEvent.click(screen.getByRole("button", { name: "مشاركة النتيجة" }));
  await waitFor(() => {
    expect(writeText).toHaveBeenCalled();
  });
  expect(writeText.mock.calls[0]?.[0]).toContain("عبدالله: 7");
  expect(await screen.findByText("✓ تم نسخ النتيجة")).toBeTruthy();
});

it("offers selectable result text if sharing and clipboard access fail", async () => {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: vi.fn().mockRejectedValue(new Error("Unavailable")),
  });
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
    writeText: vi.fn().mockRejectedValue(new Error("Denied")),
  } as unknown as Clipboard);
  renderResults();
  fireEvent.click(screen.getByRole("button", { name: "مشاركة النتيجة" }));
  const text = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "نص النتيجة للمشاركة",
  });
  expect(text.readOnly).toBe(true);
  expect(text.value).toContain("عبدالله: 7");
});

it("keeps dismissal of the native share sheet silent", async () => {
  const share = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
  Object.defineProperty(navigator, "share", { configurable: true, value: share });
  const writeText = vi.fn();
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  renderResults();
  fireEvent.click(screen.getByRole("button", { name: "مشاركة النتيجة" }));
  await waitFor(() => {
    expect(share).toHaveBeenCalled();
  });
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).toBeNull();
});
