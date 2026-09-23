import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@hint/contracts";
import { inject } from "@vercel/analytics";
import { createSessionStore, initialSession } from "./session/store";
import { restoreSession, attachSessionPersistence } from "./session/storage";
import { createSessionController } from "./session/controller";
import { createSocketTransport } from "./session/transport";
import { createServerReadiness } from "./session/readiness";
import { createPwaUpdates } from "./session/updates";
import { createPackLoader } from "./session/packs";
import { redactRoomUrl } from "./session/privacy";
import { initializeClientTelemetry, captureClientException } from "./session/telemetry";
import { App, ErrorBoundary } from "./ui/App";
import { GameProvider, type GameRuntime } from "./ui/GameContext";
import {
  initAudio,
  playCreateRoom,
  playGuessLock,
  playHintSubmit,
  playJoinRoom,
  playNewRound,
  playPlayerJoin,
} from "./session/audio";
import "./styles/react.css";

const serverEnv: unknown = import.meta.env.VITE_SERVER_URL;
const serverUrl =
  typeof serverEnv === "string" && serverEnv
    ? serverEnv
    : `${window.location.protocol}//${window.location.hostname}:3001`;
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(serverUrl, {
  autoConnect: false,
  // Same-turn replacement changes the card for everyone, so the server only offers it
  // while every live participant advertises this capability.
  // A position change only alters the clue giver's own secret, so this capability is per
  // connection and never blocks anyone else.
  auth: { cardRedrawV1: true, targetRedrawV1: true },
  transports: ["websocket", "polling"],
  reconnectionAttempts: 12,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 15000,
});
let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  /* Playing still works without persistent storage. */
}
const restored = storage ? restoreSession(storage) : { session: null, staleRoomCode: null };
const saved = restored.session;
const watch = /^\/watch\/([A-Za-z0-9]{4})\/?$/.exec(window.location.pathname)?.[1]?.toUpperCase();
const roomRoute = /^\/room\/([A-Za-z0-9]{4})\/?$/
  .exec(window.location.pathname)?.[1]
  ?.toUpperCase();
const staleRoomRoute = Boolean(roomRoute && roomRoute === restored.staleRoomCode);
if (staleRoomRoute) window.history.replaceState({}, "", "/");
const route =
  (staleRoomRoute ? null : roomRoute) ?? new URLSearchParams(window.location.search).get("join");
const joinCode = route && /^[A-Za-z0-9]{4}$/.test(route) ? route.toUpperCase() : null;
const store = createSessionStore({
  ...initialSession(),
  ...(watch ? { roomCode: watch, isSpectator: true } : (saved ?? {})),
  joinCode: saved ? null : joinCode,
  currentScreen: watch ? "spectator" : saved ? "lobby" : joinCode ? "home" : "landing",
});
const readiness = createServerReadiness({
  socket,
  healthUrl: `${serverUrl}/health`,
  fetchImpl: (url, init) => fetch(url, init),
  isOnline: () => navigator.onLine,
  addWindowListener: (event, callback) => {
    window.addEventListener(event, callback);
  },
  removeWindowListener: (event, callback) => {
    window.removeEventListener(event, callback);
  },
});
const controller = createSessionController({
  readiness,
  transport: createSocketTransport(socket),
  store,
  lifecycle: { page: window, document },
  onEvent(action) {
    switch (action.event) {
      case "room_created":
        playCreateRoom();
        break;
      case "join_success":
        playJoinRoom();
        break;
      case "player_joined":
        playPlayerJoin();
        break;
      case "round_start":
        playNewRound();
        break;
      case "clue_broadcast":
        playHintSubmit();
        break;
      case "guess_accepted":
        playGuessLock();
        break;
    }
  },
});
const updates =
  "serviceWorker" in navigator
    ? createPwaUpdates({
        register: () => navigator.serviceWorker.register("/service-worker.js"),
        container: navigator.serviceWorker,
        page: window,
        document,
        hasController: () => Boolean(navigator.serviceWorker.controller),
        isVisible: () => document.visibilityState === "visible",
        reload: () => {
          window.location.reload();
        },
      })
    : null;
const runtime: GameRuntime = {
  updates,
  store,
  controller,
  retry() {
    void controller.retry();
  },
  leave() {
    const state = store.getSnapshot();
    if (state.roomCode) controller.send("leave_room", { roomCode: state.roomCode });
    controller.stop();
    socket.disconnect();
    store.dispatch({ type: "reset" });
    window.history.replaceState({}, "", "/");
    controller.start();
  },
};

const releaseSessionPersistence = storage ? attachSessionPersistence(store, storage) : null;
let previousRoomCode = store.getSnapshot().roomCode;
const releasePersistence = store.subscribe((action) => {
  const state = store.getSnapshot();
  if (
    action.type === "reset" &&
    previousRoomCode &&
    window.location.pathname.startsWith("/room/")
  ) {
    window.history.replaceState({}, "", "/");
  }
  previousRoomCode = state.roomCode;
  if (state.roomCode && state.currentScreen !== "home" && state.currentScreen !== "landing") {
    const path = `/${state.isSpectator ? "watch" : "room"}/${state.roomCode}`;
    if (window.location.pathname !== path) window.history.replaceState({}, "", path);
  }
});
const packs = createPackLoader({
  url: `${serverUrl}/api/card-packs`,
  fetchImpl: (url, init) => fetch(url, init),
  onPacks: (data) => {
    store.dispatch({ type: "card-packs", data });
  },
});
const releaseReadiness = readiness.subscribe((status) => {
  if (status === "ready") void packs.load();
});
initializeClientTelemetry();
inject({
  beforeSend: (event) => ({ ...event, url: redactRoomUrl(event.url) ?? window.location.origin }),
});
const releaseAudio = initAudio();
const container = document.getElementById("app");
if (!container) throw new Error("Missing application mount");
const root = createRoot(container);
root.render(
  <StrictMode>
    <GameProvider runtime={runtime}>
      <ErrorBoundary recover={controller.recover} leave={runtime.leave}>
        <App />
      </ErrorBoundary>
    </GameProvider>
  </StrictMode>,
);
controller.start();
void updates?.start();
const unhandled = (event: PromiseRejectionEvent) => {
  captureClientException(event.reason);
};
window.addEventListener("unhandledrejection", unhandled);
if (import.meta.env.DEV) {
  const testWindow = window as Window & { __hintTest?: unknown };
  testWindow.__hintTest = { getState: store.getSnapshot, socket, serverReadiness: readiness };
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    controller.stop();
    socket.disconnect();
    releasePersistence();
    releaseSessionPersistence?.();
    releaseReadiness();
    releaseAudio();
    packs.stop();
    updates?.stop();
    root.unmount();
    window.removeEventListener("unhandledrejection", unhandled);
  });
