// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GameProvider } from "../src/ui/GameContext";
import { GameMenuProvider } from "../src/ui/GameMenu";
import { Psychic } from "../src/ui/Game";
import { createSessionStore, initialSession, type SessionState } from "../src/session/store";

beforeEach(() => {
  localStorage.setItem("hint_first_round_coach_v2_psychic", "1");
  localStorage.setItem("hint_intro_seen", "1");
  // jsdom has no modal dialog implementation; the component only needs the API to exist.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPsychic(overrides: Partial<SessionState> = {}) {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "psychic",
    isOwner: true,
    currentScreen: "game-psychic",
    connection: "connected",
    phase: "playing",
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: true,
      redrawUsed: false,
    },
    ...overrides,
  });
  const send = vi.fn();
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <GameMenuProvider>
        <Psychic />
      </GameMenuProvider>
    </GameProvider>,
  );
  return { store, send };
}

it("offers one replacement and marks the turn once the server confirms it", () => {
  const { store, send } = renderPsychic();
  const replace = screen.getByRole("button", { name: "تغيير البطاقة" });
  expect(replace.hasAttribute("disabled")).toBe(false);

  fireEvent.click(replace);
  expect(send).toHaveBeenCalledWith("redraw_card", {
    roomCode: "AB12",
    roundNumber: 3,
    cardId: "core-7",
  });

  act(() => {
    store.dispatch({
      type: "server",
      event: "card_redrawn",
      data: {
        roundNumber: 3,
        previousCardId: "core-7",
        card: { id: "core-9", packId: "core", left: "قريب", right: "بعيد" },
        redrawUsed: true,
      },
    });
  });
  expect(store.getSnapshot().round.card?.id).toBe("core-9");
  expect(store.getSnapshot().round.targetAngle).toBe(90);
  const used = screen.getByRole("button", { name: "تم استخدام التغيير" });
  expect(used.hasAttribute("disabled")).toBe(true);
});

it("hides replacement when a live client cannot understand it", () => {
  renderPsychic({
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: false,
      redrawUsed: false,
    },
  });
  const replace = screen.getByRole("button", { name: "تغيير البطاقة" });
  expect(replace.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByText("تغيير البطاقة غير متاح الآن. يمكنك المتابعة أو تخطي الدور."),
  ).toBeTruthy();
});

it("sends the clue with its card context", () => {
  const { store, send } = renderPsychic();
  fireEvent.change(screen.getByLabelText("التلميح"), { target: { value: "شاي دافئ" } });
  fireEvent.click(screen.getByRole("button", { name: "أرسل التلميح" }));
  expect(send).toHaveBeenCalledWith("clue_submitted", {
    roomCode: "AB12",
    roundNumber: 3,
    clue: "شاي دافئ",
    cardId: "core-7",
  });
  expect(store.getSnapshot().clueDraft).toBe("شاي دافئ");
});

it("confirms a skip with the score it charges and sends the card context", () => {
  const { send } = renderPsychic();
  fireEvent.click(screen.getByRole("button", { name: "تخطي الدور (-1)" }));
  expect(screen.getByText("سيتم خصم نقطة واحدة من رصيدك")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "تأكيد التخطي (-1)" }));
  expect(send).toHaveBeenCalledWith("skip_round", {
    roomCode: "AB12",
    roundNumber: 3,
    cardId: "core-7",
  });
});

it("names the team that pays for a skip in team mode", () => {
  renderPsychic({
    gameMode: "teams",
    teamCount: 2,
    teams: [{ id: "team-1", name: "النجوم", color: "#6C5CE7", score: 4 }],
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      activeTeamId: "team-1",
      redrawAvailable: true,
      redrawUsed: false,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "تخطي الدور (-1)" }));
  expect(screen.getByText("سيتم خصم نقطة واحدة من رصيد فريق النجوم")).toBeTruthy();
});

it("re-enables replacement after a rejection so the player can retry", () => {
  const { store, send } = renderPsychic();
  fireEvent.click(screen.getByRole("button", { name: "تغيير البطاقة" }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "جارٍ تغيير البطاقة…" })).toBeTruthy();

  act(() => {
    store.dispatch({
      type: "server",
      event: "action_error",
      data: { event: "redraw_card", code: "REDRAW_UNAVAILABLE" },
    });
  });
  const retry = screen.getByRole("button", { name: "تغيير البطاقة" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  fireEvent.click(retry);
  expect(send).toHaveBeenCalledTimes(2);
});

it("clears a stale request when an authoritative snapshot keeps the same card", () => {
  const { store, send } = renderPsychic();
  fireEvent.click(screen.getByRole("button", { name: "تغيير البطاقة" }));
  expect(screen.getByRole("button", { name: "جارٍ تغيير البطاقة…" })).toBeTruthy();

  act(() => {
    store.dispatch({
      type: "server",
      event: "reconnect_success",
      data: {
        roomCode: "AB12",
        playerId: "psychic",
        displayName: "Psychic",
        isOwner: true,
        status: "playing",
        redrawAvailable: true,
        winningScore: 20,
        psychicTimerEnabled: false,
        roomLocked: false,
        selectedPackIds: ["core"],
        readyState: initialSession().readyState,
        rematchState: initialSession().rematchState,
        awaitingNextRound: false,
        players: [],
        gameMode: "individual",
        teamCount: 2,
        teams: [],
        finalState: null,
        currentRound: {
          roundNumber: 3,
          psychicId: "psychic",
          card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
          clue: null,
          status: "waiting",
          activeTeamId: null,
          controllerId: null,
          revealData: null,
          redrawUsed: false,
          redrawAvailable: true,
          timerEndsAt: null,
          timerPhase: null,
          hasSubmitted: false,
          hasRated: false,
          myRatingVote: null,
          shouldPromptRating: false,
          myGuessAngle: null,
          psychicTargetAngle: 90,
        },
      },
    });
  });
  const retry = screen.getByRole("button", { name: "تغيير البطاقة" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  fireEvent.click(retry);
  expect(send).toHaveBeenCalledTimes(2);
});

it("keeps one request in flight until the server answers", () => {
  const { send } = renderPsychic();
  const button = screen.getByRole("button", { name: "تغيير البطاقة" });
  fireEvent.click(button);
  const pending = screen.getByRole("button", { name: "جارٍ تغيير البطاقة…" });
  fireEvent.click(pending);
  fireEvent.click(pending);
  expect(send).toHaveBeenCalledTimes(1);
});

it("describes the psychic's options according to the turn's replacement state", () => {
  renderPsychic({
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: false,
      redrawUsed: false,
    },
  });
  // One explanation for the unavailable control, and no second copy in the status block.
  expect(
    screen.getByText("تغيير البطاقة غير متاح الآن. يمكنك المتابعة أو تخطي الدور."),
  ).toBeTruthy();
  expect(screen.getByText("اكتب تلميحاً ثم أرسله قبل انتهاء الوقت")).toBeTruthy();
  cleanup();

  renderPsychic({
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: true,
      redrawUsed: true,
    },
  });
  expect(screen.getByText("استُخدم التغيير المجاني في هذا الدور.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "تم استخدام التغيير" }).hasAttribute("disabled")).toBe(
    true,
  );
  cleanup();

  renderPsychic({
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: true,
      redrawUsed: false,
    },
  });
  expect(screen.getByText("تغيير واحد مجاني قبل إرسال التلميح.")).toBeTruthy();
});

it("explains the reason the server reported for an unavailable replacement", () => {
  renderPsychic({
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: false,
      redrawReason: "disconnected",
      redrawUsed: false,
    },
  });
  expect(screen.getByText("لاعب غير متصل الآن، لذلك التغيير غير متاح مؤقتاً.")).toBeTruthy();
  cleanup();

  renderPsychic({
    round: {
      ...initialSession().round,
      roundNumber: 3,
      psychicId: "psychic",
      card: { id: "core-7", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 90,
      redrawAvailable: false,
      redrawReason: "incompatible",
      redrawUsed: false,
    },
  });
  expect(
    screen.getByText("أحد المشاركين يستخدم نسخة أقدم من اللعبة، لذلك التغيير غير متاح الآن."),
  ).toBeTruthy();
});
