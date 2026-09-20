import type { PublicPack } from "@hint/contracts";

function isPack(value: unknown): value is PublicPack {
  if (!value || typeof value !== "object") return false;
  const pack = value as Record<string, unknown>;
  return (
    typeof pack.id === "string" &&
    typeof pack.name === "string" &&
    typeof pack.description === "string" &&
    typeof pack.familySafe === "boolean" &&
    typeof pack.defaultEnabled === "boolean" &&
    typeof pack.cardCount === "number" &&
    Number.isFinite(pack.cardCount) &&
    pack.cardCount >= 0
  );
}

export function createPackLoader({
  url,
  fetchImpl,
  onPacks,
}: {
  url: string;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  onPacks: (packs: PublicPack[]) => void;
}) {
  let loaded = false;
  let stopped = false;
  let pending: Promise<void> | null = null;
  let request: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const isStopped = () => stopped;
  return {
    load(): Promise<void> {
      if (pending) return pending;
      if (loaded || stopped) return Promise.resolve();
      request = new AbortController();
      const current = request;
      timeout = setTimeout(() => {
        current.abort();
      }, 8000);
      pending = (async () => {
        try {
          const response = await fetchImpl(url, {
            cache: "no-store",
            credentials: "omit",
            signal: current.signal,
          });
          if (!response.ok) return;
          const body: unknown = await response.json();
          if (isStopped() || current.signal.aborted) return;
          if (
            body &&
            typeof body === "object" &&
            "packs" in body &&
            Array.isArray(body.packs) &&
            body.packs.every(isPack)
          ) {
            onPacks(body.packs);
            loaded = true;
          }
        } catch {
          /* A later connection can retry; built-in packs remain available. */
        } finally {
          clearTimeout(timeout);
          request = null;
          pending = null;
        }
      })();
      return pending;
    },
    stop() {
      stopped = true;
      request?.abort();
      clearTimeout(timeout);
    },
  };
}
