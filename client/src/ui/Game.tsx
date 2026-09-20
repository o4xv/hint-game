import { useEffect, useRef, useState } from "react";
import { useGame, useSession } from "./GameContext";
import { Dial } from "./Dial";
import { Dialog } from "./Dialog";
import { useGameMenu } from "./GameMenu";
import { RoundStatus, type RoundRole } from "./RoundStatus";
import { ConnectionStatus } from "./Entry";
import { playTick } from "../session/audio";

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

export function Guessing() {
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
  return (
    <main className="screen game game-shell">
      <h1 className="sr-only">تخمين الإجابة</h1>
      <GameHeader />
      <RoundStatus role={roundRole} />
      <Spectrum />
      <ClueCard clue={state.round.clue} />
      {roundRole === "mate" && (
        <p className="dial-hint">ناقش الإجابة مع فريقك — المتحكم وحده يرسل الاختيار</p>
      )}
      <div className="dial-stage">
        <Dial
          onTick={playTick}
          angle={canControl ? state.round.myAngle : state.round.previewAngle}
          interactive={canControl}
          locked={locked}
          playerId={state.playerId}
          playerIndex={state.players.findIndex((player) => player.id === state.playerId)}
          onDraft={(angle) => {
            guess.current = angle;
          }}
          onChange={(angle) => {
            store.dispatch({ type: "draft", angle });
          }}
          onPreview={(angle) => {
            if (teamMode && canControl && state.roomCode)
              controller.send("guess_preview", {
                roomCode: state.roomCode,
                roundNumber: state.round.roundNumber,
                angle,
                ...(state.round.card ? { cardId: state.round.card.id } : {}),
              });
          }}
        />
      </div>
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
      <ConnectionStatus />
      <Coach key={canControl ? "guesser" : "observer"} role={canControl ? "guesser" : "observer"} />
    </main>
  );
}

export function Psychic() {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const [pending, setPending] = useState(false);
  const [skip, setSkip] = useState(false);
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
  const clue = state.clueDraft;
  const busy = pending && !state.joinError;
  const activeTeam = state.teams.find((team) => team.id === state.round.activeTeamId);
  const redrawUsed = state.round.redrawUsed;
  const canRedraw =
    state.round.redrawAvailable &&
    !redrawUsed &&
    !state.round.clue &&
    state.round.targetAngle !== null &&
    state.connection === "connected";
  const redrawPending =
    redrawRequest !== null &&
    redrawRequest.roundNumber === state.round.roundNumber &&
    redrawRequest.cardId === state.round.card?.id &&
    redrawRequest.snapshot === state.authoritativeRound &&
    !state.round.redrawUsed &&
    state.actionError?.event !== "redraw_card";
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
          : "تغيير البطاقة غير متاح الآن. يمكنك المتابعة أو تخطي الدور.";
  function submit() {
    if (!clue.trim() || state.round.clue || !state.roomCode || busy) return;
    store.dispatch({ type: "clear-error" });
    setPending(true);
    controller.send("clue_submitted", {
      roomCode: state.roomCode,
      roundNumber: state.round.roundNumber,
      clue: clue.trim(),
      ...(state.round.card ? { cardId: state.round.card.id } : {}),
    });
  }
  function changeCard() {
    if (!canRedraw || redrawPending || !state.roomCode || !state.round.card) return;
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
  return (
    <main className="screen game game-shell">
      <h1 className="sr-only">أنت الوسيط</h1>
      <GameHeader />
      <RoundStatus role="psychic" />
      <Spectrum />
      <p className="dial-hint">الهدف لك فقط — لا تُظهر الشاشة للآخرين</p>
      <div className="dial-stage">
        <Dial targetAngle={state.round.targetAngle} angle={null} />
      </div>
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
            {busy ? "جارٍ إرسال التلميح…" : "أرسل التلميح"}
          </button>
          <div className="psychic-secondary-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setSkip(true);
              }}
            >
              تخطي الدور (-1)
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canRedraw || redrawPending}
              onClick={changeCard}
            >
              {redrawUsed
                ? "تم استخدام التغيير"
                : redrawPending
                  ? "جارٍ تغيير البطاقة…"
                  : "تغيير البطاقة"}
            </button>
          </div>
          <p className="redraw-note" role="status">
            {redrawNote}
          </p>
          {state.joinError && <p role="alert">{state.joinError}</p>}
        </form>
      )}
      {skip && (
        <Dialog
          title="تخطي الدور؟"
          onClose={() => {
            setSkip(false);
          }}
        >
          <p>
            {activeTeam
              ? `سيتم خصم نقطة واحدة من رصيد فريق ${activeTeam.name}`
              : "سيتم خصم نقطة واحدة من رصيدك"}
          </p>
          <p>ينتقل الدور إلى الوسيط التالي، ولا يمكن التراجع.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (state.roomCode && state.round.card)
                controller.send("skip_round", {
                  roomCode: state.roomCode,
                  roundNumber: state.round.roundNumber,
                  cardId: state.round.card.id,
                });
              setSkip(false);
            }}
          >
            تأكيد التخطي (-1)
          </button>
        </Dialog>
      )}
      <ConnectionStatus />
      {state.round.targetAngle !== null && <Coach role="psychic" />}
    </main>
  );
}
