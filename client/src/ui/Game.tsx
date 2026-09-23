import { useEffect, useRef, useState } from "react";
import { useGame, useSession } from "./GameContext";
import { TARGET_REDRAWS_PER_MATCH } from "@hint/contracts";
import { Dialog } from "./Dialog";
import { useGameMenu } from "./GameMenu";
import type { RoundRole } from "./RoundStatus";

export function Countdown({
  endsAt,
  pausedMs = null,
}: {
  endsAt: number | null;
  pausedMs?: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (endsAt === null || pausedMs !== null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, [endsAt, pausedMs]);
  if (endsAt === null && pausedMs === null) return null;
  const seconds = Math.max(0, Math.ceil((pausedMs ?? (endsAt ?? now) - now) / 1000));
  return (
    <span className="timer" aria-label={`${seconds} ثانية${pausedMs !== null ? "، متوقف" : ""}`}>
      {seconds}
    </span>
  );
}

export function GameHeader({ holdScores = false }: { holdScores?: boolean } = {}) {
  const state = useSession((state) => state);
  // The panel lives above the screens, so a live phase change cannot close it.
  const menu = useGameMenu();
  const teamsMode = state.gameMode === "teams";
  const myPlayer = state.players.find((player) => player.id === state.playerId);
  const myTeam = teamsMode ? state.teams.find((team) => team.id === myPlayer?.teamId) : null;
  const activeTeam = teamsMode
    ? state.teams.find((team) => team.id === state.round.activeTeamId)
    : null;
  const myScore = teamsMode ? (myTeam?.score ?? 0) : (myPlayer?.score ?? 0);
  const heldScore = holdScores
    ? (state.preRevealScores?.find((entry) =>
        teamsMode ? entry.id === myPlayer?.teamId : entry.id === state.playerId,
      )?.score ?? myScore)
    : myScore;
  const scoreLabel = state.isSpectator
    ? "لوحة النتائج"
    : teamsMode
      ? myTeam
        ? `فريقك: ${myTeam.name}`
        : "فريقي"
      : "نقاطي";
  return (
    <header className="game-header">
      <button
        type="button"
        className="icon-button"
        aria-label="قائمة اللعبة"
        aria-haspopup="dialog"
        onClick={() => {
          menu.open("menu");
        }}
      >
        ☰
      </button>
      <p className="game-header-round">
        <span className="game-header-roundline">
          <span>الجولة {state.round.roundNumber}</span>
          <span className="game-header-timer">
            <Countdown endsAt={state.round.timerEndsAt} />
          </span>
        </span>
        {activeTeam && <span className="game-header-team">الدور: {activeTeam.name}</span>}
      </p>
      <button
        type="button"
        className="game-header-score"
        aria-label={`${scoreLabel}، ${heldScore} نقطة، عرض لوحة النتائج الكاملة`}
        aria-haspopup="dialog"
        onClick={() => {
          menu.open("scores");
        }}
      >
        <span>{scoreLabel}</span>
        {/* Round points arrive on their own stage, so the header holds the previous total. */}
        <strong>{heldScore}</strong>
      </button>
    </header>
  );
}

/** The spectrum card, shared by live rounds and the in-app practice round. */
export function SpectrumCard({ left, right }: { left: string | null; right: string | null }) {
  return (
    <section className="card spectrum-card" aria-label="طرفا المقياس">
      <span>{right}</span>
      <i aria-hidden="true" />
      <span>{left}</span>
    </section>
  );
}

export function Spectrum() {
  const card = useSession((state) => state.round.card);
  return <SpectrumCard left={card?.left ?? null} right={card?.right ?? null} />;
}

/** The clue card. A missing clue is a modest placeholder, never an empty headline. */
export function ClueCard({ clue }: { clue: string | null }) {
  return (
    <section className={`card round-clue-card${clue ? "" : " is-waiting"}`}>
      <span>التلميح</span>
      <p>{clue ?? "بانتظار تلميح الوسيط…"}</p>
    </section>
  );
}

const seenRoles = new Set<string>();
const guidance = {
  psychic: [
    {
      title: "اقرأ المقياس",
      text: "الإجابة يمكن أن تكون في أي مكان بين الطرفين، وليست خياراً ثنائياً.",
    },
    {
      title: "الهدف لك فقط",
      text: "لا تُظهر الشاشة للآخرين. أعطهم تلميحاً يقودهم نحو هذا الموضع.",
    },
    {
      title: "اكتب تلميحك",
      text: "اكتب تلميحاً واضحاً هنا، ثم أرسله واترك اللاعبين أو فريقك يناقشون الإجابة.",
    },
  ],
  guesser: [
    { title: "انتظر التلميح", text: "يمكنك تجربة المؤشر الآن، ثم عدّله بعد سماع تلميح الوسيط." },
    {
      title: "اختر موقع الإجابة",
      text: "اسحب المؤشر إلى الموضع المناسب بين طرفي المقياس وناقش اختيارك مع المجموعة.",
    },
    {
      title: "ثبّت الإجابة",
      text: "اضغط «تأكيد الإجابة» عندما تكون جاهزًا. لا يمكن تغيير الإجابة بعد قبولها.",
    },
  ],
  observer: [
    {
      title: "تابع وناقش",
      text: "يمكنك متابعة التلميح ومناقشة الإجابة. المتحكم في الفريق هو من يحرك المؤشر ويرسل الإجابة.",
    },
  ],
};

export function Coach({ role }: { role: keyof typeof guidance }) {
  const [step, setStep] = useState(() => {
    if (seenRoles.has(role)) return -1;
    try {
      return localStorage.getItem(`hint_first_round_coach_v2_${role}`) ? -1 : 0;
    } catch {
      return 0;
    }
  });
  const item = guidance[role][step];
  function dismiss() {
    seenRoles.add(role);
    try {
      localStorage.setItem(`hint_first_round_coach_v2_${role}`, "1");
    } catch {
      /* Remembered for this tab. */
    }
    setStep(-1);
  }
  if (!item) return null;
  return (
    <Dialog title={item.title} onClose={dismiss} closeLabel="تخطي الشرح">
      <p>{item.text}</p>
      <p className="coachmark-progress" dir="ltr">
        {step + 1} / {guidance[role].length}
      </p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          if (step + 1 === guidance[role].length) dismiss();
          else setStep(step + 1);
        }}
      >
        {step + 1 === guidance[role].length ? "فهمت" : "التالي"}
      </button>
      <button type="button" className="btn btn-ghost" onClick={dismiss}>
        تخطي
      </button>
    </Dialog>
  );
}

/**
 * The guessing controls live above the shared dial, so this hook owns the draft ref, the
 * timed auto-submit and the role wording while the scene owns the stable dial element.
 */
export function useGuessingControls() {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const guess = useRef(state.round.myAngle);
  const me = state.players.find((player) => player.id === state.playerId);
  const teamMode = state.gameMode === "teams";
  const canControl =
    !teamMode ||
    (state.round.activeTeamId === me?.teamId && state.round.controllerId === state.playerId);
  // Everyone gets wording for their own situation: the controller acts, team mates watch
  // their own team's dial, and other teams watch the active team.
  const roundRole: RoundRole = !teamMode
    ? "guess"
    : canControl
      ? "ctrl"
      : state.round.activeTeamId === me?.teamId
        ? "mate"
        : "watch";
  const locked = state.round.hasSubmitted || state.guessPending;
  const canSubmit =
    canControl && !locked && Boolean(state.round.clue) && state.connection === "connected";
  useEffect(() => {
    guess.current = state.round.myAngle;
  }, [state.round.myAngle]);
  useEffect(() => {
    if (
      !canControl ||
      state.round.hasSubmitted ||
      state.guessPending ||
      state.round.timerPhase !== "guessing" ||
      !state.round.timerEndsAt
    )
      return;
    const roundNumber = state.round.roundNumber;
    const timer = setTimeout(
      () => {
        const current = store.getSnapshot();
        if (
          !current.roomCode ||
          current.round.roundNumber !== roundNumber ||
          current.round.hasSubmitted ||
          current.guessPending ||
          current.connection !== "connected"
        )
          return;
        store.dispatch({ type: "guess-pending", angle: guess.current });
        controller.send("guess_submitted", {
          roomCode: current.roomCode,
          roundNumber,
          angle: guess.current,
          ...(current.round.card ? { cardId: current.round.card.id } : {}),
        });
      },
      Math.max(0, state.round.timerEndsAt - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [
    canControl,
    state.round.hasSubmitted,
    state.guessPending,
    state.round.timerPhase,
    state.round.timerEndsAt,
    state.round.roundNumber,
    store,
    controller,
  ]);
  function submit() {
    if (!canSubmit || !state.roomCode) return;
    store.dispatch({ type: "guess-pending", angle: guess.current });
    controller.send("guess_submitted", {
      roomCode: state.roomCode,
      roundNumber: state.round.roundNumber,
      angle: guess.current,
      ...(state.round.card ? { cardId: state.round.card.id } : {}),
    });
  }
  /** The dial reports a live drag here; the ref keeps one pointer move from re-rendering. */
  function setDraft(angle: number) {
    guess.current = angle;
  }
  return { state, canControl, roundRole, locked, canSubmit, submit, teamsMode: teamMode, setDraft };
}

export function GuessingActions({
  canControl,
  canSubmit,
  submit,
}: {
  canControl: boolean;
  canSubmit: boolean;
  submit: () => void;
}) {
  const state = useSession((state) => state);
  return (
    <div className="game-action-area">
      {canControl ? (
        <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
          {state.round.hasSubmitted
            ? "✓ تم تثبيت الاختيار"
            : state.guessPending
              ? "جارٍ تثبيت الاختيار…"
              : "تأكيد الإجابة"}
        </button>
      ) : (
        <p role="status">بانتظار إجابة الفريق</p>
      )}
      {state.joinError && <p role="alert">{state.joinError}</p>}
    </div>
  );
}

/** The server answers a target change within this deadline or the client re-states the round. */
const TARGET_CHANGE_TIMEOUT_MS = 8_000;
/** The confirmed sweep plus its landing pulse; both change controls wait for it. */
const TARGET_SETTLE_MS = 600;

/** One identifier per deliberate click, so a rejection can be matched to its own request. */
function createRequestId(): string {
  const { crypto } = globalThis;
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The clue form and both change controls; the scene above it owns the header and the dial. */
export function PsychicActions() {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const [pending, setPending] = useState(false);
  /**
   * The replacement request stays pending only while it still belongs to this turn: the
   * round and card must match, no rejection may have arrived, the turn must not have used
   * its change, and no authoritative snapshot may have replaced the local view. That keeps
   * the control retryable after a refusal or a same-card recovery without ever letting one
   * request fire twice.
   */
  const [redrawRequest, setRedrawRequest] = useState<{
    roundNumber: number;
    cardId: string;
    snapshot: number;
  } | null>(null);
  /**
   * The answer-position request waits for its own acknowledgement: the same guardrails as the
   * card change, plus a request id so only this attempt's rejection can end the wait.
   */
  const [targetRequest, setTargetRequest] = useState<{
    requestId: string;
    roundNumber: number;
    cardId: string;
    snapshot: number;
  } | null>(null);
  /** Set when the deadline passed, so the controls stay disabled until the round is restated. */
  const [recovering, setRecovering] = useState<{ roundNumber: number; snapshot: number } | null>(
    null,
  );
  /** The last live move whose sweep has finished; the difference drives the settling state. */
  const [settledMoveId, setSettledMoveId] = useState(0);
  const clue = state.clueDraft;
  const teamsMode = state.gameMode === "teams";
  const clueBusy = pending && !state.joinError;
  const redrawUsed = state.round.redrawUsed;
  const targetRedraw = state.round.targetRedraw;
  const targetUsed = targetRedraw.usedThisRound;
  const targetExhausted = targetRedraw.supported && targetRedraw.remaining <= 0;
  const turnOpen =
    state.round.targetAngle !== null && !state.round.clue && !state.round.hasSubmitted;
  const connected = state.connection === "connected";
  const canRedraw = state.round.redrawAvailable && !redrawUsed && turnOpen && connected;
  const redrawPending =
    redrawRequest !== null &&
    redrawRequest.roundNumber === state.round.roundNumber &&
    redrawRequest.cardId === state.round.card?.id &&
    redrawRequest.snapshot === state.authoritativeRound &&
    !state.round.redrawUsed &&
    state.actionError?.event !== "redraw_card";
  const rejectedTarget = state.actionError?.event === "redraw_target" ? state.actionError : null;
  const targetPending =
    targetRequest !== null &&
    targetRequest.roundNumber === state.round.roundNumber &&
    targetRequest.cardId === state.round.card?.id &&
    targetRequest.snapshot === state.authoritativeRound &&
    !targetUsed &&
    // A rejection from an older attempt must not cancel this one.
    !(
      rejectedTarget &&
      (rejectedTarget.requestId ?? targetRequest.requestId) === targetRequest.requestId
    );
  // A recovery is over once the round is restated, so nothing has to clear it.
  const targetChecking =
    recovering !== null &&
    recovering.roundNumber === state.round.roundNumber &&
    !(connected && state.authoritativeRound !== recovering.snapshot);
  const moveId = state.targetMove?.id ?? 0;
  const settling = moveId > settledMoveId;
  const targetBusy = targetPending || targetChecking;
  const canTargetRedraw =
    targetRedraw.supported && !targetUsed && !targetExhausted && turnOpen && connected;
  const changeBusy = redrawPending || targetBusy || settling;
  const busy = clueBusy || changeBusy;
  /**
   * One explanation for the replacement control. The server names the blocker when it can,
   * and an older server that sends no reason gets the neutral wording instead of a guess.
   */
  const redrawNote = redrawUsed
    ? "استُخدم التغيير المجاني في هذا الدور."
    : state.round.redrawReason === "disconnected"
      ? "لاعب غير متصل الآن، لذلك التغيير غير متاح مؤقتاً."
      : state.round.redrawReason === "incompatible"
        ? "أحد المشاركين يستخدم نسخة أقدم من اللعبة، لذلك التغيير غير متاح الآن."
        : state.round.redrawAvailable
          ? "تغيير واحد مجاني قبل إرسال التلميح."
          : "تغيير البطاقة غير متاح الآن. يمكنك المتابعة بالتلميح الحالي.";
  /**
   * One explanation for the position control, in the required precedence: a pending request
   * or a recovery first, then the states the server can name, then the helper text.
   */
  const targetStatus = targetBusy
    ? targetPending
      ? "جارٍ تغيير المكان…"
      : "جارٍ التحقق من حالة الجولة…"
    : !targetRedraw.supported
      ? "تغيير مكان الإجابة غير متاح في هذه النسخة."
      : targetExhausted
        ? "نفدت تغييرات المكان لهذه المباراة."
        : targetUsed
          ? `استُخدم تغيير المكان في هذا الدور. المتبقي: ${targetRedraw.remaining} من ${TARGET_REDRAWS_PER_MATCH}.`
          : teamsMode
            ? `مرة واحدة في الدور، وبحد أقصى ${TARGET_REDRAWS_PER_MATCH} مرات لفريقك خلال المباراة. المتبقي: ${targetRedraw.remaining}.`
            : `مرة واحدة في الدور، وبحد أقصى ${TARGET_REDRAWS_PER_MATCH} مرات لك خلال المباراة. المتبقي: ${targetRedraw.remaining}.`;
  const targetButtonLabel = targetBusy
    ? targetPending
      ? "جارٍ تغيير المكان…"
      : "جارٍ التحقق من حالة الجولة…"
    : "تغيير مكان الإجابة";
  const targetCaption = targetBusy
    ? "يرجى الانتظار"
    : !targetRedraw.supported
      ? "غير متاح"
      : targetExhausted
        ? "متبقي: 0"
        : targetUsed
          ? `باقي ${targetRedraw.remaining} · الدور القادم`
          : `متبقي: ${targetRedraw.remaining} من ${TARGET_REDRAWS_PER_MATCH}`;
  const cardButtonLabel = redrawUsed
    ? "تم استخدام التغيير"
    : redrawPending
      ? "جارٍ تغيير البطاقة…"
      : "تغيير البطاقة";
  const cardCaption = redrawPending
    ? "يرجى الانتظار"
    : redrawUsed
      ? "استُخدم هذا الدور"
      : state.round.redrawAvailable
        ? "1 مجاني لكل دور"
        : "غير متاح الآن";

  // A request that never answers is not resent: the client asks recovery to restate the round.
  useEffect(() => {
    // The deadline only runs while this attempt is still unanswered, so a success or a matching
    // rejection stops it before it can ask for a needless recovery.
    if (!targetRequest || !targetPending) return;
    const deadline = targetRequest;
    const timer = setTimeout(() => {
      setTargetRequest((current) => (current === deadline ? null : current));
      setRecovering({ roundNumber: deadline.roundNumber, snapshot: deadline.snapshot });
      void controller.recover();
    }, TARGET_CHANGE_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [targetRequest, targetPending, controller]);
  // The controls reopen when the confirmed sweep has landed; the state only records that.
  useEffect(() => {
    if (!moveId || moveId === settledMoveId) return;
    const timer = setTimeout(() => {
      setSettledMoveId(moveId);
    }, TARGET_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [moveId, settledMoveId]);
  /**
   * Only a live, applied change is announced; a recovered position arrives with no move token.
   * The message stays for the whole turn it belongs to, and the next round replaces it.
   */
  const announcement =
    state.targetMove?.roundNumber === state.round.roundNumber
      ? teamsMode
        ? `تغيّر مكان الإجابة. المتبقي لفريقك: ${targetRedraw.remaining} من ${TARGET_REDRAWS_PER_MATCH}.`
        : `تغيّر مكان الإجابة. المتبقي لك: ${targetRedraw.remaining} من ${TARGET_REDRAWS_PER_MATCH}.`
      : null;
  function submit() {
    if (!clue.trim() || state.round.clue || !state.roomCode || busy) return;
    store.dispatch({ type: "clear-error" });
    setPending(true);
    controller.send("clue_submitted", {
      roomCode: state.roomCode,
      roundNumber: state.round.roundNumber,
      clue: clue.trim(),
      ...(state.round.card ? { cardId: state.round.card.id } : {}),
      // The clue belongs to the position it was written for; the server rejects a stale one.
      targetRevision: targetRedraw.revision,
    });
  }
  function changeCard() {
    if (!canRedraw || changeBusy || !state.roomCode || !state.round.card) return;
    const cardId = state.round.card.id;
    store.dispatch({ type: "clear-error" });
    setRedrawRequest({
      roundNumber: state.round.roundNumber,
      cardId,
      snapshot: state.authoritativeRound,
    });
    controller.send("redraw_card", {
      roomCode: state.roomCode,
      roundNumber: state.round.roundNumber,
      cardId,
    });
  }
  function changeTarget() {
    if (!canTargetRedraw || changeBusy || !state.roomCode || !state.round.card) return;
    const cardId = state.round.card.id;
    const requestId = createRequestId();
    store.dispatch({ type: "clear-error" });
    setTargetRequest({
      requestId,
      roundNumber: state.round.roundNumber,
      cardId,
      snapshot: state.authoritativeRound,
    });
    // The client never sends an angle, an owner or a remaining count: the server decides all
    // three and answers with the confirmed position together with the new counters.
    controller.send("redraw_target", {
      roomCode: state.roomCode,
      roundNumber: state.round.roundNumber,
      cardId,
      targetRevision: targetRedraw.revision,
      requestId,
    });
  }
  return (
    <>
      {state.round.clue ? (
        <ClueCard clue={state.round.clue} />
      ) : (
        <form
          className="game-action-area"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="sr-only" htmlFor="psychic-clue">
            التلميح
          </label>
          <input
            id="psychic-clue"
            className="input"
            enterKeyHint="send"
            placeholder="اكتب تلميحك هنا..."
            maxLength={50}
            value={clue}
            disabled={busy}
            onChange={(event) => {
              store.dispatch({ type: "draft", clue: event.target.value });
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              !clue.trim() ||
              busy ||
              state.round.targetAngle === null ||
              state.connection !== "connected"
            }
          >
            {/* The label describes the clue itself; another pending change only disables it. */}
            {clueBusy ? "جارٍ إرسال التلميح…" : "أرسل التلميح"}
          </button>
          <div className="psychic-secondary-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canTargetRedraw || changeBusy}
              onClick={changeTarget}
              aria-label={targetButtonLabel}
              aria-describedby="target-redraw-note"
            >
              <span className="secondary-action-title">{targetButtonLabel}</span>
              <span className="secondary-action-caption" aria-hidden="true">
                {targetCaption}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canRedraw || changeBusy}
              onClick={changeCard}
              aria-label={cardButtonLabel}
              aria-describedby="card-redraw-note"
            >
              <span className="secondary-action-title">{cardButtonLabel}</span>
              <span className="secondary-action-caption" aria-hidden="true">
                {cardCaption}
              </span>
            </button>
          </div>
          {/* Keep detailed availability reasons for assistive technology without lengthening the UI. */}
          <p className="sr-only" id="target-redraw-note">
            {targetStatus}
          </p>
          <p className="sr-only" id="card-redraw-note" role="status">
            {redrawNote}
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          {state.joinError && <p role="alert">{state.joinError}</p>}
        </form>
      )}
    </>
  );
}
