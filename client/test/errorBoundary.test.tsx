// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorBoundary } from "../src/ui/App";

const captureClientException = vi.fn();
vi.mock("../src/session/telemetry", () => ({
  captureClientException: (error: unknown) => {
    captureClientException(error);
  },
  initializeClientTelemetry: () => {
    /* Telemetry stays disabled in tests. */
  },
}));

let crash = true;

function Unstable() {
  if (crash) throw new Error("crash");
  return <p>المحتوى المستعاد</p>;
}

beforeEach(() => {
  crash = true;
  captureClientException.mockClear();
  // React reports every caught render error; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {
    /* Silenced on purpose. */
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBoundary(overrides: { recover?: () => Promise<boolean>; leave?: () => void } = {}) {
  const recover = overrides.recover ?? vi.fn(() => Promise.resolve(true));
  const leave = overrides.leave ?? vi.fn();
  render(
    <ErrorBoundary recover={recover} leave={leave}>
      <Unstable />
    </ErrorBoundary>,
  );
  return { recover, leave };
}

function deferredRecovery() {
  let settle: (value: boolean) => void = () => {
    /* Replaced as soon as the recovery starts. */
  };
  let fail: (error: unknown) => void = () => {
    /* Replaced as soon as the recovery starts. */
  };
  const recover = vi.fn(
    () =>
      new Promise<boolean>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
  );
  return {
    recover,
    settle: (value: boolean) => {
      settle(value);
    },
    fail: (error: unknown) => {
      fail(error);
    },
  };
}

/** Lets queued recovery callbacks and the React work they schedule finish.
 *  A bare assertion right after settling can pass because nothing has run yet. */
async function flushAsyncWork() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

it("reports the crash and recovers into the application once recovery succeeds", async () => {
  const recover = vi.fn(() => Promise.resolve(true));
  renderBoundary({ recover });
  expect(screen.getByRole("heading", { name: "حدث خطأ غير متوقع" })).toBeTruthy();
  expect(captureClientException).toHaveBeenCalledTimes(1);
  expect(captureClientException.mock.calls[0]?.[0]).toBeInstanceOf(Error);

  crash = false;
  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  await waitFor(() => {
    expect(screen.getByText("المحتوى المستعاد")).toBeTruthy();
  });
  expect(recover).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("heading", { name: "حدث خطأ غير متوقع" })).toBeNull();
});

it("keeps the fallback and explains the failure when recovery returns false", async () => {
  const recover = vi.fn(() => Promise.resolve(false));
  renderBoundary({ recover });

  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  await waitFor(() => {
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("تعذّرت استعادة المباراة");
  });

  // A failed recovery must not re-render the crashed subtree and must not report
  // the same crash a second time.
  expect(screen.queryByText("المحتوى المستعاد")).toBeNull();
  expect(screen.getByRole("heading", { name: "حدث خطأ غير متوقع" })).toBeTruthy();
  expect(captureClientException).toHaveBeenCalledTimes(1);
});

it("allows repeated attempts and recovers when a later attempt succeeds", async () => {
  const recover = vi
    .fn<() => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  renderBoundary({ recover });

  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  await waitFor(() => {
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  await waitFor(() => {
    expect(recover).toHaveBeenCalledTimes(2);
  });

  crash = false;
  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  await waitFor(() => {
    expect(screen.getByText("المحتوى المستعاد")).toBeTruthy();
  });
  expect(recover).toHaveBeenCalledTimes(3);
  expect(captureClientException).toHaveBeenCalledTimes(1);
});

it("does not stack recovery attempts while one is still running", async () => {
  const { recover, settle } = deferredRecovery();
  renderBoundary({ recover });

  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  const pending = screen.getByRole("button", { name: "جارٍ استعادة المباراة…" });
  fireEvent.click(pending);
  fireEvent.click(pending);
  expect(recover).toHaveBeenCalledTimes(1);

  crash = false;
  settle(true);
  await waitFor(() => {
    expect(screen.getByText("المحتوى المستعاد")).toBeTruthy();
  });
  expect(recover).toHaveBeenCalledTimes(1);
});

it("leaves the game from the fallback without attempting a recovery", async () => {
  const recover = vi.fn(() => Promise.resolve(true));
  const leave = vi.fn();
  renderBoundary({ recover, leave });

  crash = false;
  fireEvent.click(screen.getByRole("button", { name: "العودة للبداية" }));
  await waitFor(() => {
    expect(screen.getByText("المحتوى المستعاد")).toBeTruthy();
  });
  expect(leave).toHaveBeenCalledTimes(1);
  expect(recover).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "حدث خطأ غير متوقع" })).toBeNull();
});

it("treats a rejected recovery promise as a failed attempt", async () => {
  const recover = vi.fn(() => Promise.reject(new Error("offline")));
  renderBoundary({ recover });

  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  await waitFor(() => {
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("تعذّرت استعادة المباراة");
  });
  expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeTruthy();
});

// Leaving during recovery stops the controller, which settles the outstanding
// recovery request. That stale result must never bring the crash screen back.
for (const outcome of ["success", "false", "rejection"] as const) {
  it(`stays with the player after leaving while a pending recovery ends in ${outcome}`, async () => {
    const { recover, settle, fail } = deferredRecovery();
    const leave = vi.fn();
    renderBoundary({ recover, leave });

    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(screen.getByRole("button", { name: "جارٍ استعادة المباراة…" })).toBeTruthy();

    crash = false;
    fireEvent.click(screen.getByRole("button", { name: "العودة للبداية" }));
    expect(leave).toHaveBeenCalledTimes(1);
    await flushAsyncWork();
    expect(screen.getByText("المحتوى المستعاد")).toBeTruthy();

    if (outcome === "rejection") fail(new Error("offline"));
    else settle(outcome === "success");
    await flushAsyncWork();

    expect(screen.getByText("المحتوى المستعاد")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "حدث خطأ غير متوقع" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
  });
}
