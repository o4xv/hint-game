export const SERVER_READINESS = Object.freeze({
  CONNECTING: "connecting",
  WAKING: "waking",
  READY: "ready",
  OFFLINE: "offline",
  UNAVAILABLE: "unavailable",
} as const);

export type ReadinessStatus = (typeof SERVER_READINESS)[keyof typeof SERVER_READINESS];
type Timer = ReturnType<typeof setTimeout>;
interface ReadinessOptions {
  socket: {
    readonly connected: boolean;
    readonly active: boolean;
    connect(): unknown;
    disconnect(): unknown;
  };
  healthUrl: string;
  fetchImpl: (url: string, init: RequestInit) => Promise<Pick<Response, "ok">>;
  isOnline: () => boolean;
  addWindowListener: (event: "online" | "offline", listener: () => void) => void;
  removeWindowListener: (event: "online" | "offline", listener: () => void) => void;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer | null) => void;
  wakeDelayMs?: number;
  unavailableAfterMs?: number;
  probeRetryMs?: number;
}

export function createServerReadiness({
  socket,
  healthUrl,
  fetchImpl,
  isOnline,
  addWindowListener,
  removeWindowListener,
  setTimer = setTimeout,
  clearTimer = (timer) => {
    if (timer !== null) clearTimeout(timer);
  },
  wakeDelayMs = 1_500,
  unavailableAfterMs = 60_000,
  probeRetryMs = 3_000,
}: ReadinessOptions) {
  let status: ReadinessStatus = socket.connected
    ? SERVER_READINESS.READY
    : SERVER_READINESS.CONNECTING;
  let started = false;
  let attemptId = 0;
  let wakeTimer: Timer | null = null;
  let unavailableTimer: Timer | null = null;
  let retryTimer: Timer | null = null;
  let probeController: AbortController | null = null;
  const listeners = new Set<(status: ReadinessStatus) => void>();

  function emit(nextStatus: ReadinessStatus) {
    if (status === nextStatus) return;
    status = nextStatus;
    listeners.forEach((listener) => {
      listener(status);
    });
  }

  function clearAttempt({ abortProbe = true } = {}) {
    clearTimer(wakeTimer);
    clearTimer(unavailableTimer);
    clearTimer(retryTimer);
    wakeTimer = null;
    unavailableTimer = null;
    retryTimer = null;
    if (abortProbe) probeController?.abort();
    probeController = null;
  }

  function runHealthProbe(activeAttempt: number) {
    if (activeAttempt !== attemptId || !isOnline() || socket.connected) return;
    probeController?.abort();
    probeController = new AbortController();

    Promise.resolve(
      fetchImpl(healthUrl, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: probeController.signal,
      }),
    )
      .then((response) => {
        if (activeAttempt !== attemptId || !isOnline() || socket.connected) return;
        if (!response.ok) {
          retryTimer = setTimer(() => {
            runHealthProbe(activeAttempt);
          }, probeRetryMs);
          return;
        }
        if (!socket.active) socket.connect();
      })
      .catch((error: unknown) => {
        if (
          (error instanceof Error && error.name === "AbortError") ||
          activeAttempt !== attemptId ||
          !isOnline()
        )
          return;
        retryTimer = setTimer(() => {
          runHealthProbe(activeAttempt);
        }, probeRetryMs);
      });
  }

  function beginAttempt({ forceConnect = false } = {}) {
    attemptId += 1;
    const activeAttempt = attemptId;
    clearAttempt();

    if (!isOnline()) {
      emit(SERVER_READINESS.OFFLINE);
      return;
    }
    if (socket.connected) {
      emit(SERVER_READINESS.READY);
      return;
    }

    emit(SERVER_READINESS.CONNECTING);
    if (forceConnect || !socket.active) socket.connect();
    runHealthProbe(activeAttempt);
    wakeTimer = setTimer(() => {
      if (activeAttempt === attemptId && !socket.connected && isOnline()) {
        emit(SERVER_READINESS.WAKING);
      }
    }, wakeDelayMs);
    unavailableTimer = setTimer(() => {
      if (activeAttempt !== attemptId || socket.connected || !isOnline()) return;
      attemptId += 1;
      clearAttempt();
      emit(SERVER_READINESS.UNAVAILABLE);
    }, unavailableAfterMs);
  }

  function onConnect() {
    attemptId += 1;
    clearAttempt();
    emit(SERVER_READINESS.READY);
  }

  function onDisconnect() {
    if (!started) return;
    beginAttempt();
  }

  function onOnline() {
    if (started) beginAttempt();
  }

  function onOffline() {
    attemptId += 1;
    clearAttempt();
    socket.disconnect();
    emit(SERVER_READINESS.OFFLINE);
  }

  function start() {
    if (started) return;
    started = true;
    addWindowListener("online", onOnline);
    addWindowListener("offline", onOffline);
    beginAttempt({ forceConnect: true });
  }

  function stop() {
    if (!started) return;
    started = false;
    attemptId += 1;
    clearAttempt();
    removeWindowListener("online", onOnline);
    removeWindowListener("offline", onOffline);
  }

  function subscribe(listener: (status: ReadinessStatus) => void, { immediate = true } = {}) {
    listeners.add(listener);
    if (immediate) listener(status);
    return () => listeners.delete(listener);
  }

  function waitUntilReady({ timeoutMs = unavailableAfterMs + 1_000 } = {}) {
    if (status === SERVER_READINESS.READY) return Promise.resolve(true);
    if (status === SERVER_READINESS.OFFLINE || status === SERVER_READINESS.UNAVAILABLE) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: Timer | null = null;
      const unsubscribe = subscribe(
        (nextStatus) => {
          if (settled) return;
          if (nextStatus === SERVER_READINESS.READY) finish(true);
          else if (
            nextStatus === SERVER_READINESS.OFFLINE ||
            nextStatus === SERVER_READINESS.UNAVAILABLE
          )
            finish(false);
        },
        { immediate: false },
      );
      function finish(ready: boolean) {
        if (settled) return;
        settled = true;
        clearTimer(timeout);
        unsubscribe();
        resolve(ready);
      }
      timeout = setTimer(() => {
        finish(false);
      }, timeoutMs);
    });
  }

  return {
    start,
    stop,
    connectionChanged(connected: boolean) {
      if (!started) return;
      if (connected) onConnect();
      else onDisconnect();
    },
    retry: () => {
      beginAttempt({ forceConnect: true });
    },
    subscribe,
    waitUntilReady,
    getStatus: () => status,
  };
}
