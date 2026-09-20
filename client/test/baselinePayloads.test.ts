import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createSessionStore, initialSession, type ServerAction } from "../src/session/store";

// Captured from the pinned server, not generated from current contract definitions.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/baseline-guest-session.json", import.meta.url), "utf8"),
) as {
  baseline: string;
  packets: [ServerAction["event"], ServerAction["data"]][];
};
const actions = fixture.packets.map(
  ([event, data]) => ({ type: "server", event, data }) as ServerAction,
);

it("replays baseline join, round, reveal, pause and reconnect packets without score drift", () => {
  expect(fixture.baseline).toBe("34d68dbbb3f15d5c68a00975021478a15ce9c0b6");
  const store = createSessionStore({ ...initialSession(), displayName: "ضيف التوافق" });
  const seen = new Set<string>();
  for (const action of actions) {
    store.dispatch(action);
    seen.add(action.event);
    const state = store.getSnapshot();
    if (action.event === "round_start" && action.data.roundNumber === 1) {
      expect(state.currentScreen).toBe("game-player");
      expect(state.round.targetAngle).toBeNull();
    }
    if (action.event === "clue_broadcast") {
      expect(state.round.clue).toBe("تلميح متوافق");
      expect(state.round.targetAngle).toBeNull();
    }
    if (action.event === "reveal_phase") {
      expect(state.currentScreen).toBe("reveal");
      expect(action.data.updatedScores.some((score) => score.totalScore > 0)).toBe(true);
      for (const score of action.data.updatedScores) {
        expect(state.players.find((player) => player.id === score.playerId)?.score).toBe(
          score.totalScore,
        );
      }
      store.dispatch(action);
      expect(store.getSnapshot()).toEqual(state);
    }
    if (action.event === "reconnect_success") {
      expect(state.playerId).toBe("fixture-player-1");
      expect(state.currentScreen).toBe("reveal");
      expect(state.readyState.paused).toBe(true);
      expect(state.readyState.remainingMs).toBeGreaterThan(0);
      expect(state.revealData).toEqual(action.data.currentRound?.revealData);
    }
  }
  for (const event of [
    "join_success",
    "round_start",
    "clue_broadcast",
    "reveal_phase",
    "round_ready_updated",
    "reconnect_success",
  ])
    expect(seen.has(event), event).toBe(true);
  expect(store.getSnapshot().round.roundNumber).toBe(2);
  expect(store.getSnapshot().readyState.paused).toBe(false);
});

it("restores the captured reveal snapshot directly after a fresh page load", () => {
  const snapshot = actions.find((action) => action.event === "reconnect_success");
  expect(snapshot).toBeDefined();
  if (!snapshot) throw new Error("Missing captured reconnect snapshot");
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "ABCD",
    playerId: "fixture-player-1",
    reconnectToken: "fixture-reconnect-token",
  });
  store.dispatch(snapshot);
  expect(store.getSnapshot()).toMatchObject({
    currentScreen: "reveal",
    connection: "connected",
    phase: "playing",
    readyState: { paused: true },
    round: { roundNumber: 1, targetAngle: null },
    reconnectToken: "fixture-reconnect-token",
  });
});
