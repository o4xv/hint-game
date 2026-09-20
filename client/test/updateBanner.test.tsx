// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { UpdateBanner } from "../src/ui/UpdateBanner";
import { createSessionStore, initialSession } from "../src/session/store";

afterEach(cleanup);
it("defers the update action until the player has left the deciding reveal", () => {
  const store = createSessionStore({
    ...initialSession(),
    phase: "finished",
    currentScreen: "reveal",
  });
  const requestUpdate = vi.fn();
  const updates = {
    getSnapshot: () => true,
    subscribe: () => () => {
      /* static fixture */
    },
    requestUpdate,
  };
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send: vi.fn(), recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <UpdateBanner updates={updates} />
    </GameProvider>,
  );
  expect(screen.queryByRole("button", { name: "تحديث" })).toBeNull();
  act(() => {
    store.dispatch({ type: "navigate", screen: "winner" });
  });
  fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
  expect(requestUpdate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "إغلاق إشعار التحديث" }));
  expect(screen.queryByRole("button", { name: "تحديث" })).toBeNull();
});
