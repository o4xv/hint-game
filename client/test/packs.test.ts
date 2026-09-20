import { afterEach, expect, it, vi } from "vitest";
import { createPackLoader } from "../src/session/packs";

afterEach(() => {
  vi.useRealTimers();
});

it("uses a fresh request after a timeout and deduplicates concurrent loads", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const received = vi.fn();
  const pack = {
    id: "classic",
    name: "Classic",
    description: "",
    familySafe: true,
    defaultEnabled: true,
    cardCount: 10,
  };
  const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal;
    if (!signal) throw new Error("Missing cancellation");
    signals.push(signal);
    if (signals.length === 1)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    return Promise.resolve(new Response(JSON.stringify({ packs: [pack] })));
  });
  const loader = createPackLoader({ url: "/api/card-packs", fetchImpl, onPacks: received });
  const first = loader.load();
  expect(loader.load()).toBe(first);
  await vi.advanceTimersByTimeAsync(8000);
  await first;
  expect(signals[0]?.aborted).toBe(true);
  await loader.load();
  expect(signals[1]?.aborted).toBe(false);
  expect(received).toHaveBeenCalledWith([pack]);
  await loader.load();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  loader.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels an outstanding request and ignores completion after stop", async () => {
  let resolve: (value: Response) => void = () => {
    /* assigned below */
  };
  const received = vi.fn();
  const loader = createPackLoader({
    url: "/api/card-packs",
    fetchImpl: () =>
      new Promise<Response>((settle) => {
        resolve = settle;
      }),
    onPacks: received,
  });
  const pending = loader.load();
  loader.stop();
  resolve(new Response(JSON.stringify({ packs: [] })));
  await pending;
  expect(received).not.toHaveBeenCalled();
});
