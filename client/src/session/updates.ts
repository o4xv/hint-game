interface Worker extends EventTarget {
  readonly state: string;
}
interface Registration extends EventTarget {
  readonly waiting: { postMessage(message: { type: "SKIP_WAITING" }): void } | null;
  readonly installing: Worker | null;
  update(): Promise<unknown>;
}
export function createPwaUpdates({
  register,
  container,
  page,
  document,
  hasController,
  isVisible,
  reload,
}: {
  register: () => Promise<Registration | null>;
  container: EventTarget;
  page: EventTarget;
  document: EventTarget;
  hasController: () => boolean;
  isVisible: () => boolean;
  reload: () => void;
}) {
  let registration: Registration | null = null;
  let available = false;
  let requested = false;
  let reloaded = false;
  let controlled = hasController();
  let activatedElsewhere = false;
  let generation = 0;
  let started = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const cleanup: (() => void)[] = [];
  function listen(target: EventTarget, event: string, listener: () => void) {
    target.addEventListener(event, listener);
    cleanup.push(() => {
      target.removeEventListener(event, listener);
    });
  }
  function publish(next: boolean) {
    if (next === available) return;
    available = next;
    for (const listener of listeners) listener();
  }
  function notify() {
    publish(activatedElsewhere || Boolean(registration?.waiting && hasController()));
  }
  function observeWorker() {
    const worker = registration?.installing;
    if (worker)
      listen(worker, "statechange", () => {
        // installed can arrive before registration.waiting reflects that worker.
        if (worker.state === "installed" && hasController()) publish(true);
        else notify();
      });
    notify();
  }
  function check() {
    if (isVisible())
      void registration?.update().catch(() => {
        /* Retry on the next foreground/online event. */
      });
  }
  return {
    getSnapshot: () => available,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (started) return;
      started = true;
      const current = ++generation;
      try {
        const result = await register();
        if (current !== generation || !result) return;
        registration = result;
        listen(result, "updatefound", observeWorker);
        listen(container, "controllerchange", () => {
          if (requested && !reloaded) {
            reloaded = true;
            reload();
          } else if (controlled && !registration?.waiting) {
            activatedElsewhere = true;
          }
          controlled = hasController();
          notify();
        });
        listen(document, "visibilitychange", check);
        listen(page, "online", check);
        interval = setInterval(check, 30 * 60 * 1000);
        observeWorker();
      } catch {
        /* The online game remains usable if installation is unavailable. */
      }
    },
    requestUpdate() {
      if (reloaded || requested) return;
      if (activatedElsewhere) {
        reloaded = true;
        reload();
        return;
      }
      if (!registration?.waiting) return;
      requested = true;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    },
    stop() {
      generation++;
      started = false;
      clearInterval(interval);
      for (const release of cleanup.splice(0)) release();
      registration = null;
      requested = false;
      reloaded = false;
      activatedElsewhere = false;
      controlled = hasController();
      notify();
    },
  };
}
