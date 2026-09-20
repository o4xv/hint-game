// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { Lobby } from "../src/ui/Lobby";
import { createSessionStore, initialSession, type SessionState } from "../src/session/store";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderLobby(overrides: Partial<SessionState> = {}) {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "owner",
    displayName: "المضيف",
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
      {
        id: "guest",
        displayName: "ضيف",
        score: 0,
        isConnected: true,
        hasSubmitted: false,
        awaitingNextRound: false,
        teamId: "team-1",
      },
    ],
    ...overrides,
  });
  const send = vi.fn();
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <Lobby />
    </GameProvider>,
  );
  return { store, send };
}

function cardFor(id: string) {
  const section = requiredSection();
  const card = section.querySelector(`[data-team-id="${id}"]`);
  if (!card) throw new Error(`missing team card ${id}`);
  return card as HTMLElement;
}

function requiredSection() {
  const heading = screen.getByRole("heading", { name: "الفرق", level: 2 });
  const section = heading.closest("section");
  if (!section) throw new Error("missing teams section");
  return section;
}

function startEditing(teamId: string) {
  const card = cardFor(teamId);
  fireEvent.click(within(card).getByRole("button", { name: "تعديل الاسم" }));
  return card;
}

function typeName(card: HTMLElement, value: string) {
  const input = within(card).getByLabelText(/اسم/, { selector: "input" });
  fireEvent.change(input, { target: { value } });
  return input;
}

it("lists participants and groups each team's name, members and connected count", () => {
  renderLobby();
  expect(screen.getByRole("heading", { name: "اللاعبون (2/12)" })).toBeTruthy();
  const stars = cardFor("team-2");
  expect(within(stars).getByText("النجوم")).toBeTruthy();
  expect(stars.textContent).toContain("0 أعضاء");
  expect(stars.textContent).toContain("0 متصل");
  const first = cardFor("team-1");
  expect(first.textContent).toContain("2 أعضاء");
  expect(first.textContent).toContain("2 متصل");
  expect(within(first).getByText("المضيف")).toBeTruthy();
  expect(within(first).getByText("ضيف")).toBeTruthy();
});

it("saves a trimmed name through the server and only confirms after the broadcast", () => {
  const { store, send } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "  الصقور  ");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(send).toHaveBeenCalledWith("rename_team", {
    roomCode: "AB12",
    teamId: "team-1",
    name: "الصقور",
  });
  expect(within(card).getByRole("button", { name: "جارٍ الحفظ…" })).toBeTruthy();

  act(() => {
    store.dispatch({
      type: "server",
      event: "settings_updated",
      data: {
        teams: [
          { id: "team-1", name: "الصقور", color: "#6C5CE7", score: 0 },
          { id: "team-2", name: "النجوم", color: "#00B894", score: 0 },
        ],
      },
    });
  });
  expect(within(cardFor("team-1")).getByText("الصقور")).toBeTruthy();
  expect(within(cardFor("team-1")).queryByRole("button", { name: "حفظ" })).toBeNull();
});

it("rejects duplicate and overlong names inline without sending", () => {
  const { send } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "النجوم");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(within(card).getByRole("alert").textContent).toContain("يوجد فريق بهذا الاسم.");
  expect(send).not.toHaveBeenCalled();

  typeName(card, "ا".repeat(25));
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(within(card).getByRole("alert").textContent).toContain("24 حرفاً");
  expect(send).not.toHaveBeenCalled();
});

it("explains a server rejection inline and keeps the editor open", () => {
  const { store, send } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "نجوم");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(send).toHaveBeenCalledTimes(1);

  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE" },
    });
  });
  expect(within(card).getByRole("alert").textContent).toContain("يوجد فريق بهذا الاسم.");
  expect(within(card).getByRole("button", { name: "حفظ" })).toBeTruthy();
});

it("asks for a retry after five seconds without a confirmation", () => {
  vi.useFakeTimers();
  const { send } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "نجوم");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(send).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(within(card).getByRole("status").textContent).toContain("لم يصل تأكيد الحفظ");
});

it("restores Save and Cancel after the timeout and lets the retry reach the server", () => {
  vi.useFakeTimers();
  const { send } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "الصقور");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  // A second click while the attempt is in flight must not queue another request.
  fireEvent.click(within(card).getByRole("button", { name: "جارٍ الحفظ…" }));
  expect(send).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(within(card).getByRole("status").textContent).toContain("لم يصل تأكيد الحفظ");
  // The message is only useful when the user can act on it: both controls work again.
  const retry = within(card).getByRole("button", { name: "حفظ" });
  const cancel = within(card).getByRole("button", { name: "إلغاء" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(cancel.hasAttribute("disabled")).toBe(false);
  // The draft survives so the retry is one tap, not a re-typed name.
  expect(within(card).getByLabelText("اسم الفريق ١").getAttribute("value")).toBe("الصقور");

  fireEvent.click(retry);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith("rename_team", {
    roomCode: "AB12",
    teamId: "team-1",
    name: "الصقور",
  });
  expect(within(card).getByRole("button", { name: "جارٍ الحفظ…" })).toBeTruthy();
  expect(within(card).queryByRole("status")).toBeNull();

  // A second unanswered attempt says plainly that the server itself may be out of date.
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(within(card).getByRole("status").textContent).toContain("فقد يحتاج الخادم إلى تحديث");
  fireEvent.click(within(card).getByRole("button", { name: "إلغاء" }));
  expect(within(card).getByRole("button", { name: "تعديل الاسم" })).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(2);
  expect(card.querySelector(".team-name")?.textContent).toBe("الفريق ١");
});

it("closes the editor when a delayed confirmation lands after the timeout", () => {
  vi.useFakeTimers();
  const { store } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "الصقور");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(within(card).getByRole("button", { name: "حفظ" })).toBeTruthy();

  act(() => {
    store.dispatch({
      type: "server",
      event: "settings_updated",
      data: {
        teams: [
          { id: "team-1", name: "الصقور", color: "#6C5CE7", score: 0 },
          { id: "team-2", name: "النجوم", color: "#00B894", score: 0 },
        ],
      },
    });
  });
  const renamed = cardFor("team-1");
  expect(within(renamed).getByText("الصقور")).toBeTruthy();
  expect(within(renamed).queryByRole("button", { name: "حفظ" })).toBeNull();
  expect(within(renamed).getByRole("button", { name: "تعديل الاسم" })).toBeTruthy();
});

it("ends a save that loses its connection and keeps the draft for a retry", async () => {
  const { store, send } = renderLobby();
  const card = startEditing("team-1");
  typeName(card, "الصقور");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(within(card).getByRole("button", { name: "جارٍ الحفظ…" })).toBeTruthy();

  act(() => {
    store.dispatch({ type: "connection", status: "offline" });
  });
  expect(store.getSnapshot().connection).toBe("offline");
  // The attempt ends on the next tick so the user can act on the message.
  await waitFor(() => {
    expect(within(card).getByRole("status").textContent).toContain("انقطع الاتصال");
  });
  expect(within(card).getByRole("button", { name: "حفظ" }).hasAttribute("disabled")).toBe(false);

  act(() => {
    store.dispatch({ type: "connection", status: "connected" });
  });
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(send).toHaveBeenCalledTimes(2);
});

it("warns before sending when the room has no server connection", () => {
  const { send } = renderLobby({ connection: "offline" });
  const card = startEditing("team-1");
  typeName(card, "الصقور");
  fireEvent.click(within(card).getByRole("button", { name: "حفظ" }));
  expect(send).not.toHaveBeenCalled();
  expect(within(card).getByRole("alert").textContent).toContain("لا يوجد اتصال بالخادم");
  expect(within(card).getByRole("button", { name: "حفظ" })).toBeTruthy();
});

it("does not show a previous attempt's rejection on another team", () => {
  const { store } = renderLobby();
  const first = startEditing("team-1");
  typeName(first, "الصقور");
  fireEvent.click(within(first).getByRole("button", { name: "حفظ" }));
  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE" },
    });
  });
  expect(within(first).getByRole("alert").textContent).toContain("يوجد فريق بهذا الاسم");

  fireEvent.click(within(first).getByRole("button", { name: "إلغاء" }));
  const second = startEditing("team-2");
  expect(within(second).queryByRole("alert")).toBeNull();
});
it("keeps a rejection on the team the server named while another team is editing", () => {
  const { store, send } = renderLobby();
  const first = startEditing("team-1");
  typeName(first, "الصقور");
  const second = startEditing("team-2");
  typeName(second, "النسور");
  expect(first.getAttribute("data-team-id")).toBe("team-1");
  expect(second.getAttribute("data-team-id")).toBe("team-2");

  // Both editors can be open at once; each save is its own attempt.
  fireEvent.click(within(first).getByRole("button", { name: "حفظ" }));
  fireEvent.click(within(second).getByRole("button", { name: "حفظ" }));
  expect(send).toHaveBeenCalledTimes(2);

  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE", teamId: "team-1" },
    });
  });
  expect(first.querySelector('[role="alert"]')?.textContent).toContain("يوجد فريق بهذا الاسم.");
  // The untouched attempt keeps its own progress instead of borrowing the other answer.
  expect(within(second).queryByRole("alert")).toBeNull();
  expect(within(second).getByRole("button", { name: "جارٍ الحفظ…" })).toBeTruthy();

  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "NOT_OWNER", teamId: "team-2" },
    });
  });
  expect(second.querySelector('[role="alert"]')?.textContent ?? second.textContent).toContain(
    "صاحب الغرفة وحده",
  );
  // Each card keeps its own answer, and neither borrows the other's text.
  expect(first.querySelector('[role="alert"]')?.textContent).toContain("يوجد فريق بهذا الاسم.");
  expect(first.querySelector('[role="alert"]')?.textContent ?? "").not.toContain(
    "صاحب الغرفة وحده",
  );
  expect(within(first).getByRole("button", { name: "حفظ" }).hasAttribute("disabled")).toBe(false);
  expect(within(second).getByRole("button", { name: "حفظ" }).hasAttribute("disabled")).toBe(false);
});

it("keeps a late rejection on its own team after that editor timed out", () => {
  vi.useFakeTimers();
  const { store } = renderLobby();
  const first = startEditing("team-1");
  typeName(first, "الصقور");
  fireEvent.click(within(first).getByRole("button", { name: "حفظ" }));
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(within(first).getByRole("status").textContent).toContain("لم يصل تأكيد الحفظ");

  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE", teamId: "team-1" },
    });
  });
  // The answer belongs to the attempt that is still on screen, so the user learns why.
  expect(within(first).getByRole("alert").textContent).toContain("يوجد فريق بهذا الاسم.");
  const second = startEditing("team-2");
  expect(within(second).queryByRole("alert")).toBeNull();
});

it("ignores an uncorrelated rejection for a team that is not waiting", () => {
  const { store } = renderLobby();
  const first = startEditing("team-1");
  typeName(first, "الصقور");
  const second = startEditing("team-2");
  // No attempt is in flight in either editor, which is the only signal an older server gives.
  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE" },
    });
  });
  expect(within(first).queryByRole("alert")).toBeNull();
  expect(within(second).queryByRole("alert")).toBeNull();

  // While an attempt is waiting, the same ambiguous answer is shown where it is needed.
  fireEvent.click(within(first).getByRole("button", { name: "حفظ" }));
  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "rename_team", code: "TEAM_NAME_DUPLICATE" },
    });
  });
  expect(within(first).getByRole("alert").textContent).toContain("يوجد فريق بهذا الاسم.");
  expect(within(second).queryByRole("alert")).toBeNull();
});

it("names the team that is short when the match cannot start", () => {
  renderLobby({
    players: [
      ...["المضيف", "ضيف", "لاعب3"].map((displayName, index) => ({
        id: `team-one-${index}`,
        displayName,
        score: 0,
        isConnected: true,
        hasSubmitted: false,
        awaitingNextRound: false,
        teamId: "team-1",
      })),
      {
        id: "lonely",
        displayName: "لاعب4",
        score: 0,
        isConnected: true,
        hasSubmitted: false,
        awaitingNextRound: false,
        teamId: "team-2",
      },
    ],
  });
  expect(screen.getByRole("button", { name: "فريق النجوم يحتاج لاعباً إضافياً" })).toBeTruthy();
  expect(document.querySelector(".lobby-start-reason")?.textContent).toContain(
    "فريق النجوم يحتاج لاعباً إضافياً",
  );
});

it("hides the rename control from players who are not the host", () => {
  renderLobby({ isOwner: false, playerId: "guest" });
  expect(screen.queryByRole("button", { name: "تعديل الاسم" })).toBeNull();
  expect(cardFor("team-2").textContent).toContain("النجوم");
});
