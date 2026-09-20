import { describe, expect, it } from "vitest";
import { createSessionStore, initialSession, sessionReducer } from "../src/session/store";
import { readSession, writeSession } from "../src/session/storage";
import type { ReconnectSuccessPayload } from "@hint/contracts";

const player = {
  id: "one",
  displayName: "الأول",
  score: 0,
  isConnected: true,
  hasSubmitted: false,
  awaitingNextRound: false,
  teamId: null,
};
const roundStart = {
  roundNumber: 1,
  psychicId: "two",
  card: { id: "core-1", packId: "core", left: "بارد", right: "حار" },
  players: [player],
  gameMode: "individual" as const,
  teamCount: 2,
  teams: [],
  activeTeamId: null,
  controllerId: null,
  redrawUsed: false,
  redrawAvailable: true,
};
describe("session transitions", () => {
  it("keeps snapshot identity stable until a real change and unsubscribes listeners", () => {
    const store = createSessionStore();
    const snapshot = store.getSnapshot();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: "navigate", screen: "landing" });
    expect(store.getSnapshot()).toBe(snapshot);
    store.dispatch({ type: "navigate", screen: "home" });
    expect(calls).toBe(1);
    off();
    store.dispatch({ type: "navigate", screen: "landing" });
    expect(calls).toBe(1);
    expect(snapshot.currentScreen).toBe("landing");
  });
  it("clears stale targets and guesses on round change but preserves drafts on unrelated updates", () => {
    const store = createSessionStore({ ...initialSession(), playerId: "one" });
    store.dispatch({ type: "server", event: "round_start", data: roundStart });
    store.dispatch({ type: "draft", angle: 63, clue: "شاي" });
    store.dispatch({
      type: "server",
      event: "player_joined",
      data: { players: [player], redrawAvailable: true },
    });
    expect(store.getSnapshot().round.myAngle).toBe(63);
    expect(store.getSnapshot().clueDraft).toBe("شاي");
    store.dispatch({
      type: "server",
      event: "round_start",
      data: { ...roundStart, roundNumber: 2 },
    });
    expect(store.getSnapshot().round.myAngle).toBe(90);
    expect(store.getSnapshot().round.targetAngle).toBeNull();
    expect(store.getSnapshot().clueDraft).toBe("");
  });
  it("only locks a guess after current-round acknowledgement", () => {
    const store = createSessionStore({ ...initialSession(), playerId: "one" });
    store.dispatch({ type: "server", event: "round_start", data: roundStart });
    store.dispatch({ type: "guess-pending", angle: 60 });
    expect(store.getSnapshot().round.hasSubmitted).toBe(false);
    store.dispatch({
      type: "server",
      event: "guess_accepted",
      data: { roundNumber: 0, angle: 30 },
    });
    expect(store.getSnapshot().round.hasSubmitted).toBe(false);
    store.dispatch({
      type: "server",
      event: "guess_accepted",
      data: { roundNumber: 1, angle: 60 },
    });
    expect(store.getSnapshot().round.hasSubmitted).toBe(true);
    expect(store.getSnapshot().guessPending).toBe(false);
  });
  it("rematch moves either final-results view to the lobby and clears round state", () => {
    for (const currentScreen of ["reveal", "winner"] as const) {
      const state = {
        ...initialSession(),
        currentScreen,
        phase: "finished" as const,
        playerId: "one",
        readyState: {
          playerIds: ["one"],
          readyCount: 1,
          requiredCount: 1,
          paused: true,
          remainingMs: 5000,
          endsAt: null,
        },
      };
      const next = sessionReducer(state, {
        type: "server",
        event: "rematch_started",
        data: {
          players: [player],
          winningScore: 20,
          selectedPackIds: ["core"],
          gameMode: "individual",
          teamCount: 2,
          teams: [],
        },
      });
      expect(next.currentScreen).toBe("lobby");
      expect(next.readyState.paused).toBe(false);
      expect(next.round.roundNumber).toBe(0);
    }
  });
  it("late spectator receives paused snapshot immediately without a secret target", () => {
    const next = sessionReducer(initialSession(), {
      type: "server",
      event: "watch_success",
      data: {
        roomCode: "ABCD",
        status: "playing",
        winningScore: 20,
        players: [player],
        redrawAvailable: true,
        gameMode: "individual",
        teamCount: 2,
        teams: [],
        readyState: {
          playerIds: [],
          readyCount: 0,
          requiredCount: 1,
          paused: true,
          remainingMs: 4200,
          endsAt: null,
        },
        currentRound: {
          ...roundStart,
          clue: "شاي",
          status: "revealed",
          previewAngle: null,
          revealData: null,
        },
        finalState: null,
      },
    });
    expect(next.readyState.paused).toBe(true);
    expect(next.currentScreen).toBe("spectator");
    expect(next.round.targetAngle).toBeNull();
  });
  it("normalizes old snapshots to unpaused rather than retaining an earlier pause", () => {
    const state = {
      ...initialSession(),
      readyState: {
        playerIds: [],
        readyCount: 0,
        requiredCount: 1,
        paused: true,
        remainingMs: 4000,
        endsAt: null,
      },
    };
    const next = sessionReducer(state, {
      type: "server",
      event: "watch_success",
      data: {
        roomCode: "ABCD",
        status: "waiting",
        winningScore: 20,
        players: [],
        redrawAvailable: true,
        gameMode: "individual",
        teamCount: 2,
        teams: [],
        currentRound: null,
        finalState: null,
      },
    });
    expect(next.readyState.paused).toBe(false);
  });
  it("reconciles a reconnect without losing an unsubmitted draft in the same round", () => {
    const store = createSessionStore({
      ...initialSession(),
      roomCode: "ABCD",
      playerId: "one",
      reconnectToken: "token",
    });
    store.dispatch({ type: "server", event: "round_start", data: roundStart });
    store.dispatch({ type: "draft", angle: 63, clue: "شاي" });
    store.dispatch({ type: "guess-pending", angle: 63 });
    store.dispatch({ type: "server", event: "reconnect_success", data: reconnectFixture() });
    const next = store.getSnapshot();
    expect(next.round.myAngle).toBe(63);
    expect(next.clueDraft).toBe("شاي");
    expect(next.guessPending).toBe(false);
    expect(next.round.hasSubmitted).toBe(false);
    expect(next.reconnectToken).toBe("token");
    expect(next.currentScreen).toBe("game-player");
  });
  it("uses the accepted server guess after reconnect and clears a draft on a new round", () => {
    const state = {
      ...initialSession(),
      playerId: "one",
      clueDraft: "قديم",
      round: { ...initialSession().round, roundNumber: 1, myAngle: 63 },
    };
    const data = reconnectFixture();
    data.currentRound.roundNumber = 2;
    data.currentRound.hasSubmitted = true;
    data.currentRound.myGuessAngle = 42;
    const next = sessionReducer(state, { type: "server", event: "reconnect_success", data });
    expect(next.round.myAngle).toBe(42);
    expect(next.round.hasSubmitted).toBe(true);
    expect(next.clueDraft).toBe("");
    expect(next.readyState.paused).toBe(false);
  });
  it("keeps the deciding reveal open across reconnect until the player chooses results", () => {
    const data: ReconnectSuccessPayload = {
      ...reconnectFixture(),
      status: "finished",
      readyState: {
        playerIds: [],
        readyCount: 0,
        requiredCount: 0,
        endsAt: null,
        paused: false,
        remainingMs: null,
      },
    };
    const state = {
      ...initialSession(),
      roomCode: "ABCD",
      playerId: "one",
      currentScreen: "reveal" as const,
      round: { ...initialSession().round, roundNumber: 1 },
    };
    expect(
      sessionReducer(state, { type: "server", event: "reconnect_success", data }).currentScreen,
    ).toBe("reveal");
    expect(
      sessionReducer(
        { ...state, currentScreen: "winner" },
        { type: "server", event: "reconnect_success", data },
      ).currentScreen,
    ).toBe("winner");
    expect(
      sessionReducer(state, {
        type: "server",
        event: "reconnect_success",
        data: { ...data, status: "waiting", currentRound: null },
      }).currentScreen,
    ).toBe("lobby");
  });
  it("does not expose a reconnect target to a nonpsychic even if the payload contains one", () => {
    const data: ReconnectSuccessPayload = {
      ...reconnectFixture(),
      readyState: {
        playerIds: [],
        readyCount: 0,
        requiredCount: 0,
        endsAt: null,
        paused: false,
        remainingMs: null,
      },
      currentRound: { ...reconnectFixture().currentRound, psychicTargetAngle: 35 },
    };
    expect(
      sessionReducer(initialSession(), { type: "server", event: "reconnect_success", data }).round
        .targetAngle,
    ).toBeNull();
    expect(
      sessionReducer(initialSession(), {
        type: "server",
        event: "reconnect_success",
        data: { ...data, playerId: "two" },
      }).round.targetAngle,
    ).toBe(35);
  });
});

function reconnectFixture() {
  return {
    roomCode: "ABCD",
    playerId: "one",
    displayName: "الأول",
    isOwner: false,
    status: "playing" as const,
    winningScore: 20,
    psychicTimerEnabled: false,
    roomLocked: false,
    selectedPackIds: ["core"],
    redrawAvailable: true,
    gameMode: "individual" as const,
    teamCount: 2,
    teams: [],
    players: [player],
    awaitingNextRound: false,
    rematchState: { playerIds: [], voteCount: 0, requiredCount: 1 },
    finalState: null,
    currentRound: {
      roundNumber: 1,
      psychicId: "two",
      card: roundStart.card,
      clue: "شاي",
      status: "guessing" as const,
      activeTeamId: null,
      controllerId: null,
      revealData: null,
      timerEndsAt: 123456,
      timerPhase: "guessing" as const,
      hasSubmitted: false,
      hasRated: false,
      myRatingVote: null,
      shouldPromptRating: false,
      redrawUsed: false,
      redrawAvailable: true,
      myGuessAngle: null as number | null,
    },
  };
}
describe("persisted sessions", () => {
  it("rejects malformed data and survives storage access failures", () => {
    for (const data of ["{", "null", "[]", '{"roomCode":"ABCD"}']) {
      expect(readSession({ getItem: () => data })).toBeNull();
    }
    expect(
      readSession({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
    expect(() => {
      writeSession(
        {
          setItem: () => {
            throw new Error("full");
          },
          removeItem: () => {
            throw new Error("blocked");
          },
        },
        initialSession(),
      );
    }).not.toThrow();
  });
  it("retains the established session storage shape and key", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    writeSession(storage, {
      ...initialSession(),
      roomCode: "ABCD",
      playerId: "one",
      reconnectToken: "token",
      displayName: "اسم",
      isOwner: true,
    });
    expect(readSession(storage)).toEqual({
      roomCode: "ABCD",
      playerId: "one",
      reconnectToken: "token",
      displayName: "اسم",
      isOwner: true,
    });
    expect(memory.has("hint_session")).toBe(true);
  });
});
