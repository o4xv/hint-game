// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TargetRedrawState } from "@hint/contracts";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Psychic } from "../src/ui/PlayScene";
import {
  createSessionStore,
  initialSession,
  normalizeTargetRedraw,
  unsupportedTargetRedraw,
  type ServerAction,
  type SessionState,
} from "../src/session/store";

beforeEach(() => {
  localStorage.setItem("hint_first_round_coach_v2_psychic", "1");
  localStorage.setItem("hint_intro_seen", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const available = (overrides: Partial<TargetRedrawState> = {}): TargetRedrawState => ({
  supported: true,
  remaining: 3,
  usedThisRound: false,
  revision: 0,
  ...overrides,
});

function roundState(overrides: Partial<SessionState["round"]> = {}) {
  return {
    ...initialSession().round,
    roundNumber: 3,
    psychicId: "psychic",
    card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
    targetAngle: 90,
    redrawAvailable: true,
    redrawUsed: false,
    targetRedraw: available(),
    ...overrides,
  };
}

function reconnectPacket({
  revision = 0,
  cardId = "core-7",
  roundNumber = 3,
  remaining = 3,
}: { revision?: number; cardId?: string; roundNumber?: number; remaining?: number } = {}) {
  return {
    type: "server" as const,
    event: "reconnect_success" as const,
    data: {
      roomCode: "AB12",
      playerId: "psychic",
      displayName: "Psychic",
      isOwner: true,
      status: "playing" as const,
      redrawAvailable: true,
      winningScore: 20,
      psychicTimerEnabled: false,
      roomLocked: false,
      selectedPackIds: ["core"],
      readyState: initialSession().readyState,
      rematchState: initialSession().rematchState,
      awaitingNextRound: false,
      players: [],
      gameMode: "individual" as const,
      teamCount: 2,
      teams: [],
      finalState: null,
      currentRound: {
        roundNumber,
        psychicId: "psychic",
        card: { id: cardId, packId: "core", left: "بارد", right: "حار" },
        clue: null,
        status: "waiting" as const,
        activeTeamId: null,
        controllerId: null,
        revealData: null,
        redrawUsed: false,
        redrawAvailable: true,
        targetRedraw: available({ revision, usedThisRound: revision > 0, remaining }),
        timerEndsAt: null,
        timerPhase: null,
        hasSubmitted: false,
        hasRated: false,
        myRatingVote: null,
        shouldPromptRating: false,
        myGuessAngle: null,
        psychicTargetAngle: 90,
      },
    } as ServerAction["data"],
  };
}

function renderPsychic({
  overrides = {},
  recover = vi.fn(() => Promise.resolve(true)),
  draft = "",
}: {
  overrides?: Partial<SessionState>;
  recover?: () => Promise<boolean>;
  draft?: string;
} = {}) {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "psychic",
    isOwner: true,
    currentScreen: "game-psychic",
    connection: "connected",
    phase: "playing",
    clueDraft: draft,
    round: roundState(),
    ...overrides,
  });
  const send = vi.fn();
  render(
    <GameProvider runtime={{ store, controller: { send, recover }, leave: vi.fn() }}>
      <GameMenuProvider>
        <Psychic />
      </GameMenuProvider>
    </GameProvider>,
  );
  return { store, send, recover };
}

function dispatch(store: ReturnType<typeof createSessionStore>, action: ServerAction) {
  act(() => {
    store.dispatch(action);
  });
}

const changeTarget = () => screen.getByRole("button", { name: "تغيير مكان الإجابة" });

it("sends one identified request and never spends a use optimistically", () => {
  const { store, send } = renderPsychic();
  fireEvent.click(changeTarget());
  expect(send).toHaveBeenCalledTimes(1);
  const [event, payload] = send.mock.calls[0] as [string, Record<string, unknown>];
  expect(event).toBe("redraw_target");
  expect(payload).toMatchObject({
    roomCode: "AB12",
    roundNumber: 3,
    cardId: "core-7",
    targetRevision: 0,
  });
  expect(typeof payload.requestId).toBe("string");
  expect(String(payload.requestId).length).toBeGreaterThan(0);
  expect(String(payload.requestId).length).toBeLessThanOrEqual(128);
  // Nothing is invented locally: the server alone decides the position and the counters.
  expect(store.getSnapshot().round.targetAngle).toBe(90);
  expect(store.getSnapshot().round.targetRedraw).toEqual(available());
  expect(screen.getByRole("button", { name: "جارٍ تغيير المكان…" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "جارٍ تغيير المكان…" }));
  expect(send).toHaveBeenCalledTimes(1);
});

it("applies the confirmed position atomically and clears the draft only then", () => {
  const { store, send } = renderPsychic({ draft: "شاي ساخن" });
  fireEvent.click(changeTarget());
  expect(store.getSnapshot().clueDraft).toBe("شاي ساخن");
  const requestId = String((send.mock.calls[0] as [string, Record<string, unknown>])[1].requestId);

  dispatch(store, {
    type: "server",
    event: "target_redrawn",
    data: {
      requestId,
      roundNumber: 3,
      cardId: "core-7",
      previousTargetRevision: 0,
      targetAngle: 12,
      targetRedraw: available({ remaining: 2, usedThisRound: true, revision: 1 }),
    },
  });

  const state = store.getSnapshot();
  expect(state.round.targetAngle).toBe(12);
  expect(state.round.targetRedraw).toEqual(
    available({ remaining: 2, usedThisRound: true, revision: 1 }),
  );
  expect(state.clueDraft).toBe("");
  expect(screen.getByText("لك: ٢ / ٣")).toBeTruthy();
  expect(screen.getByText("استُخدم تغيير المكان في هذا الدور.")).toBeTruthy();
  expect(screen.getByText("تغيّر مكان الإجابة. المتبقي لك: ٢ من ٣.")).toBeTruthy();
});

it("keeps the draft and restores the control after this attempt's rejection", () => {
  const { store, send } = renderPsychic({ draft: "شاي ساخن" });
  fireEvent.click(changeTarget());
  const requestId = String((send.mock.calls[0] as [string, Record<string, unknown>])[1].requestId);
  dispatch(store, {
    type: "server",
    event: "action_error",
    data: { event: "redraw_target", code: "TARGET_REDRAW_EXHAUSTED", requestId },
  });

  expect(store.getSnapshot().clueDraft).toBe("شاي ساخن");
  const retry = screen.getByRole("button", { name: "تغيير مكان الإجابة" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  fireEvent.click(retry);
  expect(send).toHaveBeenCalledTimes(2);
});

it("ignores a rejection that belongs to an older attempt", () => {
  const { store, send } = renderPsychic();
  fireEvent.click(changeTarget());
  dispatch(store, {
    type: "server",
    event: "action_error",
    data: { event: "redraw_target", code: "STALE_TARGET", requestId: "an-older-request" },
  });
  expect(screen.getByRole("button", { name: "جارٍ تغيير المكان…" })).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
});

it("asks for authoritative recovery after eight seconds without resending", () => {
  vi.useFakeTimers();
  const { store, send, recover } = renderPsychic();
  fireEvent.click(changeTarget());
  expect(send).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(8_000);
  });
  expect(recover).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "جارٍ التحقق من حالة الجولة…" }).hasAttribute("disabled"),
  ).toBe(true);

  dispatch(store, reconnectPacket({ revision: 1, remaining: 2 }) as ServerAction);
  expect(screen.getByRole("button", { name: "تغيير مكان الإجابة" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByText("استُخدم تغيير المكان في هذا الدور.")).toBeTruthy();
});

it("stops the request deadline once the server has answered", () => {
  vi.useFakeTimers();
  const { store, send, recover } = renderPsychic();
  fireEvent.click(changeTarget());
  const requestId = String((send.mock.calls[0] as [string, Record<string, unknown>])[1].requestId);
  dispatch(store, {
    type: "server",
    event: "target_redrawn",
    data: {
      requestId,
      roundNumber: 3,
      cardId: "core-7",
      previousTargetRevision: 0,
      targetAngle: 12,
      targetRedraw: available({ remaining: 2, usedThisRound: true, revision: 1 }),
    },
  });
  act(() => {
    vi.advanceTimersByTime(20_000);
  });
  // A success ends the wait: no recovery is asked for and no checking message appears.
  expect(recover).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.getByText("استُخدم تغيير المكان في هذا الدور.")).toBeTruthy();
});

it("blocks the card change, the position change and the clue while one is pending", () => {
  const { store, send } = renderPsychic({ draft: "شاي ساخن" });
  fireEvent.click(changeTarget());
  expect(screen.getByRole("button", { name: "تغيير البطاقة" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "أرسل التلميح" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "أرسل التلميح" }));
  expect(send).toHaveBeenCalledTimes(1);
  dispatch(store, {
    type: "server",
    event: "target_redrawn",
    data: {
      requestId: "r",
      roundNumber: 3,
      cardId: "core-7",
      previousTargetRevision: 0,
      targetAngle: 12,
      targetRedraw: available({ remaining: 2, usedThisRound: true, revision: 1 }),
    },
  });
  // Settling keeps both change controls closed until the confirmed sweep has landed.
  expect(screen.getByRole("button", { name: "تغيير البطاقة" }).hasAttribute("disabled")).toBe(true);
});

it("explains an unsupported, used, exhausted and available allowance", () => {
  const exhausted = renderPsychic({
    overrides: { round: roundState({ targetRedraw: available({ remaining: 0 }) }) },
  });
  expect(changeTarget().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("نفدت تغييرات المكان لهذه المباراة.")).toBeTruthy();
  expect(screen.getByText("لك: ٠ / ٣")).toBeTruthy();
  expect(exhausted.store.getSnapshot().round.targetRedraw.remaining).toBe(0);
  cleanup();

  renderPsychic({
    overrides: {
      round: roundState({
        targetRedraw: available({ remaining: 2, usedThisRound: true, revision: 1 }),
      }),
    },
  });
  expect(changeTarget().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("استُخدم تغيير المكان في هذا الدور.")).toBeTruthy();
  cleanup();

  // An older server sends no metadata at all, which normalises to "unsupported".
  expect(normalizeTargetRedraw(undefined)).toEqual({
    supported: false,
    remaining: 0,
    usedThisRound: false,
    revision: 0,
  });
  expect(normalizeTargetRedraw(null)).toEqual(unsupportedTargetRedraw());
  renderPsychic({ overrides: { round: roundState({ targetRedraw: unsupportedTargetRedraw() }) } });
  expect(changeTarget().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("تغيير مكان الإجابة غير متاح في هذه النسخة.")).toBeTruthy();
  expect(screen.queryByText(/^لك:/)).toBeNull();
  cleanup();

  renderPsychic();
  expect(changeTarget().hasAttribute("disabled")).toBe(false);
  expect(screen.getByText("لك: ٣ / ٣")).toBeTruthy();
  expect(screen.getByText("مرة واحدة في الدور، وبحد أقصى ٣ مرات لك خلال المباراة.")).toBeTruthy();
});

it("keeps a draft only while the recovered round, card and position all match", () => {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "psychic",
    displayName: "Psychic",
    round: roundState(),
  });
  store.dispatch({ type: "draft", clue: "شاي ساخن" });
  store.dispatch(reconnectPacket() as ServerAction);
  expect(store.getSnapshot().clueDraft).toBe("شاي ساخن");

  store.dispatch({ type: "draft", clue: "شاي ساخن" });
  store.dispatch(reconnectPacket({ revision: 1, remaining: 2 }) as ServerAction);
  expect(store.getSnapshot().clueDraft).toBe("");
  expect(store.getSnapshot().round.targetRedraw.revision).toBe(1);

  store.dispatch({ type: "draft", clue: "شاي ساخن" });
  store.dispatch(reconnectPacket({ cardId: "core-9" }) as ServerAction);
  expect(store.getSnapshot().clueDraft).toBe("");
});

it("applies only the acknowledgement that belongs to this turn and revision", () => {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "psychic",
    isSpectator: false,
    round: roundState(),
  });
  const ack = (overrides: Record<string, unknown> = {}) =>
    ({
      type: "server",
      event: "target_redrawn",
      data: {
        requestId: "r",
        roundNumber: 3,
        cardId: "core-7",
        previousTargetRevision: 0,
        targetAngle: 12,
        targetRedraw: available({ remaining: 2, usedThisRound: true, revision: 1 }),
        ...overrides,
      },
    }) as ServerAction;

  store.dispatch(ack({ roundNumber: 4 }));
  expect(store.getSnapshot().round.targetAngle).toBe(90);
  store.dispatch(ack({ cardId: "core-1" }));
  expect(store.getSnapshot().round.targetAngle).toBe(90);
  store.dispatch(ack({ previousTargetRevision: 2 }));
  expect(store.getSnapshot().round.targetAngle).toBe(90);
  store.dispatch(ack({ targetRedraw: available({ remaining: 2, revision: 3 }) }));
  expect(store.getSnapshot().round.targetAngle).toBe(90);

  store.dispatch(ack());
  expect(store.getSnapshot().round.targetAngle).toBe(12);
  expect(store.getSnapshot().targetMove?.revision).toBe(1);
  // A duplicate cannot restart the animation or navigate the psychic anywhere.
  store.dispatch(ack());
  expect(store.getSnapshot().targetMove?.id).toBe(1);
});

it("never lets a delayed initial target overwrite a changed position", () => {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "psychic",
    round: roundState({
      targetAngle: null,
      targetRedraw: available({ remaining: 2, usedThisRound: true, revision: 1 }),
    }),
  });
  // The initial target was drawn before the change and arrives late with its old revision.
  store.dispatch({
    type: "server",
    event: "target_reveal",
    data: { targetAngle: 90, roundNumber: 3, cardId: "core-7", targetRevision: 0 },
  });
  expect(store.getSnapshot().round.targetAngle).toBeNull();
  store.dispatch({
    type: "server",
    event: "target_reveal",
    data: { targetAngle: 30, roundNumber: 3, cardId: "core-7", targetRevision: 1 },
  });
  expect(store.getSnapshot().round.targetAngle).toBe(30);
  // A context-free legacy initial target is only trusted before any change happened.
  store.dispatch({
    type: "server",
    event: "target_reveal",
    data: { targetAngle: 150 },
  });
  expect(store.getSnapshot().round.targetAngle).toBe(30);
});
