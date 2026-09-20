export interface PageLifecycle {
  page: EventTarget;
  document: EventTarget & { readonly visibilityState: string };
}

/** A hidden iPhone page can outlive its socket and every local countdown. */
export function attachSessionLifecycle(
  { page, document }: PageLifecycle,
  recover: () => Promise<boolean>,
  now: () => number = Date.now,
): () => void {
  let hiddenAt: number | null = document.visibilityState === "hidden" ? now() : null;
  function visibilityChanged() {
    if (document.visibilityState === "hidden") {
      hiddenAt ??= now();
      return;
    }
    const awayFor = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (awayFor >= 3_000) void recover();
  }
  function restored(event: Event) {
    if ("persisted" in event && event.persisted === true) void recover();
  }
  function online() {
    void recover();
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  page.addEventListener("pageshow", restored);
  page.addEventListener("online", online);
  return () => {
    document.removeEventListener("visibilitychange", visibilityChanged);
    page.removeEventListener("pageshow", restored);
    page.removeEventListener("online", online);
  };
}
