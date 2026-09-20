import { afterEach, expect, it, vi } from "vitest";
import { createServerReadiness } from "../src/session/readiness";

afterEach(() => {
  vi.useRealTimers();
});

function fixture(fetchImpl: (url: string, init: RequestInit) => Promise<Pick<Response, "ok">>) {
  return createServerReadiness({
    socket: {
      connected: false,
      active: true,
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
    healthUrl: "/health",
    fetchImpl,
    isOnline: () => true,
    addWindowListener: vi.fn(),
    removeWindowListener: vi.fn(),
    wakeDelayMs: 10,
    probeRetryMs: 20,
    unavailableAfterMs: 100,
  });
}

it("retries a temporary HTTP failure while the server is waking", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
  const readiness = fixture(fetchImpl);
  readiness.start();
  await vi.advanceTimersByTimeAsync(21);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  readiness.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a late probe rejection after the wake deadline", async () => {
  vi.useFakeTimers();
  let rejectProbe: (error: Error) => void = vi.fn();
  const fetchImpl = vi.fn(
    () =>
      new Promise<Pick<Response, "ok">>((_resolve, reject) => {
        rejectProbe = reject;
      }),
  );
  const readiness = fixture(fetchImpl);
  readiness.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(readiness.getStatus()).toBe("unavailable");
  rejectProbe(new Error("Late network failure"));
  await vi.advanceTimersByTimeAsync(40);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  readiness.stop();
});
