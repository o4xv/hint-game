import type { IncomingEvent, IncomingPayloads, ServerToClientEvents } from "@hint/contracts";
import type { createSessionStore, SessionAction, ServerAction } from "./store";
import { attachSessionLifecycle, type PageLifecycle } from "./lifecycle";
import type { createServerReadiness } from "./readiness";

export interface SessionTransport {
  readonly connected: boolean;
  readonly active: boolean;
  on<Event extends keyof ServerToClientEvents>(
    event: Event,
    callback: ServerToClientEvents[Event],
  ): void;
  off<Event extends keyof ServerToClientEvents>(
    event: Event,
    callback: ServerToClientEvents[Event],
  ): void;
  onConnection(callback: (connected: boolean) => void): () => void;
  emit<Event extends IncomingEvent>(event: Event, payload: IncomingPayloads[Event]): void;
  connect(): void;
}

const events = {
  room_created: true,
  join_success: true,
  join_error: true,
  join_pending: true,
  reconnect_success: true,
  watch_success: true,
  watch_error: true,
  session_replaced: true,
  room_closed: true,
  join_request: true,
  join_request_removed: true,
  join_request_resolved: true,
  player_joined: true,
  player_removed: true,
  player_disconnected: true,
  ownership_transferred: true,
  kicked_from_room: true,
  settings_updated: true,
  game_start_error: true,
  game_started: true,
  rematch_started: true,
  round_start: true,
  target_reveal: true,
  clue_broadcast: true,
  timer_start: true,
  guess_accepted: true,
  guess_rejected: true,
  card_redrawn: true,
  target_redrawn: true,
  player_guessed: true,
  team_guess_preview: true,
  round_skipped: true,
  reveal_phase: true,
  game_over: true,
  round_ready_updated: true,
  card_rating_recorded: true,
  reaction_received: true,
  rematch_vote_updated: true,
  action_error: true,
} satisfies Record<keyof ServerToClientEvents, true>;

export function createSessionController({
  transport,
  store,
  lifecycle,
  onEvent,
  readiness,
}: {
  transport: SessionTransport;
  store: ReturnType<typeof createSessionStore>;
  lifecycle?: PageLifecycle;
  onEvent?: (action: ServerAction) => void;
  readiness?: ReturnType<typeof createServerReadiness>;
}) {
  let started = false;
  let cleanup: (() => void)[] = [];
  let recovery: {
    promise: Promise<boolean>;
    resolve: (success: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    roomCode: string;
    spectator: boolean;
    sent: boolean;
  } | null = null;

  function finishRecovery(success: boolean) {
    if (!recovery) return;
    const pending = recovery;
    recovery = null;
    clearTimeout(pending.timer);
    pending.resolve(success);
  }

  function sendRecovery() {
    if (!recovery || recovery.sent || !transport.connected) return;
    recovery.sent = true;
    if (recovery.spectator) {
      transport.emit("watch_room", { roomCode: recovery.roomCode });
    } else {
      const token = store.getSnapshot().reconnectToken;
      if (!token) {
        finishRecovery(false);
        return;
      }
      transport.emit("reconnect_player", { roomCode: recovery.roomCode, reconnectToken: token });
    }
  }

  function recover(): Promise<boolean> {
    if (recovery) return recovery.promise;
    const state = store.getSnapshot();
    if (!started || !state.roomCode || (!state.isSpectator && !state.reconnectToken))
      return Promise.resolve(false);
    let resolve: (success: boolean) => void = () => {
      /* assigned synchronously by Promise */
    };
    const promise = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    recovery = {
      promise,
      resolve,
      roomCode: state.roomCode,
      spectator: state.isSpectator,
      sent: false,
      timer: setTimeout(() => {
        store.dispatch({ type: "connection", status: "unavailable" });
        finishRecovery(false);
      }, 10_000),
    };
    store.dispatch({ type: "connection", status: "recovering" });
    if (transport.connected) sendRecovery();
    else if (!transport.active) transport.connect();
    return promise;
  }

  function bind(event: keyof ServerToClientEvents) {
    const callback = ((data: Parameters<ServerToClientEvents[typeof event]>[0]) => {
      // The transport pairs each typed event with its payload; preserve that pair as a reducer action.
      const action = { type: "server", event, data } as Extract<SessionAction, { type: "server" }>;
      if (action.event === "reconnect_success" || action.event === "watch_success") {
        const expectedRoom = recovery?.roomCode ?? store.getSnapshot().roomCode;
        if (expectedRoom && action.data.roomCode !== expectedRoom) return;
      }
      store.dispatch(action);
      onEvent?.(action);
      if (action.event === "reconnect_success" || action.event === "watch_success") {
        if (
          recovery?.roomCode === action.data.roomCode &&
          recovery.spectator === (action.event === "watch_success")
        ) {
          store.dispatch({ type: "connection", status: "connected" });
          finishRecovery(true);
        }
      }
      if (action.event === "join_error" && recovery && !recovery.spectator) {
        if (
          ["INVALID_RECONNECT", "ROOM_NOT_FOUND", "SESSION_EXPIRED"].includes(
            action.data.code ?? "",
          )
        ) {
          store.dispatch({ type: "reset" });
        }
        finishRecovery(false);
      }
      if (action.event === "watch_error" && recovery?.spectator) finishRecovery(false);
      if (
        action.event === "session_replaced" ||
        action.event === "room_closed" ||
        action.event === "kicked_from_room"
      )
        finishRecovery(false);
    }) as ServerToClientEvents[typeof event];
    transport.on(event, callback);
    cleanup.push(() => {
      transport.off(event, callback);
    });
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (readiness) {
        cleanup.push(
          readiness.subscribe((status) => {
            if (status !== "ready" || store.getSnapshot().connection !== "recovering")
              store.dispatch({
                type: "connection",
                status: status === "ready" ? "connected" : status,
              });
          }),
        );
        cleanup.push(readiness.stop);
      }
      if (lifecycle) cleanup.push(attachSessionLifecycle(lifecycle, recover));
      for (const event of Object.keys(events) as (keyof ServerToClientEvents)[]) bind(event);
      cleanup.push(
        transport.onConnection((connected) => {
          store.dispatch({
            type: "connection",
            status: connected ? (recovery ? "recovering" : "connected") : "connecting",
          });
          if (connected) {
            if (recovery) sendRecovery();
            else void recover();
          } else if (recovery) recovery.sent = false;
          readiness?.connectionChanged(connected);
        }),
      );
      readiness?.start();
    },
    stop() {
      if (!started) return;
      started = false;
      for (const release of cleanup) release();
      cleanup = [];
      finishRecovery(false);
    },
    recover,
    retry() {
      readiness?.retry();
      return recover();
    },
    send<Event extends IncomingEvent>(event: Event, payload: IncomingPayloads[Event]) {
      if (!started) return;
      transport.emit(event, payload);
    },
  };
}
