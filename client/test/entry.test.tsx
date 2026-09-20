// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { Entry } from "../src/ui/Entry";
import { createSessionStore, initialSession } from "../src/session/store";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("allows an explicit retry after an unanswered request and cleans up the deadline", () => {
  vi.useFakeTimers();
  const store = createSessionStore({ ...initialSession(), connection: "connected" });
  const send = vi.fn();
  const view = render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <Entry />
    </GameProvider>,
  );
  fireEvent.change(screen.getByLabelText("اسم اللاعب"), { target: { value: "اسم محفوظ" } });
  fireEvent.change(screen.getByLabelText("كود الغرفة"), { target: { value: "ABCD" } });
  fireEvent.click(screen.getByRole("button", { name: "انضم" }));
  act(() => {
    vi.advanceTimersByTime(15_000);
  });
  expect(screen.getByRole("alert").textContent).toContain("حاول مرة أخرى");
  expect(screen.getByLabelText<HTMLInputElement>("اسم اللاعب").value).toBe("اسم محفوظ");
  expect(screen.getByLabelText<HTMLInputElement>("كود الغرفة").value).toBe("ABCD");
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "انضم" }));
  expect(send).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert").textContent).toBe("");
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("allows retrying an interrupted entry request without losing the entered name", () => {
  const store = createSessionStore({ ...initialSession(), connection: "connected" });
  const send = vi.fn();
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <Entry />
    </GameProvider>,
  );
  fireEvent.change(screen.getByLabelText("اسم اللاعب"), { target: { value: "اسم محفوظ" } });
  fireEvent.click(screen.getByRole("button", { name: "إنشاء غرفة" }));
  act(() => {
    store.dispatch({ type: "connection", status: "offline" });
  });
  act(() => {
    store.dispatch({ type: "connection", status: "connected" });
  });
  expect(screen.getByLabelText<HTMLInputElement>("اسم اللاعب").value).toBe("اسم محفوظ");
  expect(screen.getByRole("button", { name: "إنشاء غرفة" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "إنشاء غرفة" }));
  expect(send).toHaveBeenCalledTimes(2);
});

it("retains Arabic entry drafts through unrelated session changes and sends the entered identity", () => {
  const store = createSessionStore({ ...initialSession(), connection: "connected" });
  const send = vi.fn();
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <Entry />
    </GameProvider>,
  );
  const input = screen.getByLabelText("اسم اللاعب");
  fireEvent.change(input, { target: { value: "عبدالله الطويل" } });
  act(() => {
    store.dispatch({
      type: "server",
      event: "player_joined",
      data: { players: [], redrawAvailable: true },
    });
  });
  expect((input as HTMLInputElement).value).toBe("عبدالله الطويل");
  fireEvent.click(screen.getByRole("button", { name: "إنشاء غرفة" }));
  expect(send).toHaveBeenCalledWith("create_room", {
    displayName: "عبدالله الطويل",
    winningScore: 20,
    selectedPackIds: ["core", "daily-life", "entertainment"],
  });
  expect(store.getSnapshot().displayName).toBe("عبدالله الطويل");
});

it("prevents entering while offline and re-enables the unchanged draft after recovery", () => {
  const store = createSessionStore({ ...initialSession(), connection: "offline" });
  const send = vi.fn();
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <Entry />
    </GameProvider>,
  );
  fireEvent.change(screen.getByLabelText("اسم اللاعب"), { target: { value: "اسم" } });
  expect(screen.getByRole("button", { name: "إنشاء غرفة" }).hasAttribute("disabled")).toBe(true);
  act(() => {
    store.dispatch({ type: "connection", status: "connected" });
  });
  expect(screen.getByRole("button", { name: "إنشاء غرفة" }).hasAttribute("disabled")).toBe(false);
});
