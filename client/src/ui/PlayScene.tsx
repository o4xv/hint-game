import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RevealData } from "@hint/contracts";
import { useGame, useSession } from "./GameContext";
import {
  ClueCard,
  Coach,
  GameHeader,
  GuessingActions,
  PsychicActions,
  Spectrum,
  useGuessingControls,
} from "./Game";
import { ConnectionStatus } from "./Entry";
import { Dial } from "./Dial";
import { RoundStatus } from "./RoundStatus";
import { RevealResults, Winner } from "./Results";
import { playReveal, playScore, playTick, playWinner } from "../session/audio";

/**
 * The shared timeline for one reveal. The dial keeps its position, the answer zone arrives
 * before the other needles, and the round totals wait for the score stage.
 */
export const REVEAL_STAGE_TIMES = [0, 180, 480, 800, 1080, 1200] as const;
export const REVEAL_REDUCED_MOTION_MS = 150;
/** Index of each presentation stage inside REVEAL_STAGE_TIMES. */
const ZONE_STAGE = 1;
const NEEDLE_STAGE = 2;
const SCORE_STAGE = 3;
const SETTLED_STAGE = 5;

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * One staged reveal per round: a duplicate event for the same round never restarts it, and a
 * reveal that recovery restored opens settled. Every timer is cleared on unmount or a change.
 */
function useRevealStage(animate: boolean) {
  const [stage, setStage] = useState(animate ? 0 : SETTLED_STAGE);
  useEffect(() => {
    if (!animate) return;
    if (prefersReducedMotion()) {
      const timer = window.setTimeout(() => {
        setStage(SETTLED_STAGE);
      }, REVEAL_REDUCED_MOTION_MS);
      return () => {
        window.clearTimeout(timer);
      };
    }
    const timers = REVEAL_STAGE_TIMES.slice(1).map((delay, index) =>
      window.setTimeout(() => {
        setStage(index + 1);
      }, delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [animate]);
  return animate ? stage : SETTLED_STAGE;
}

type Phase = "psychic" | "guesser" | "reveal";

/** The clue giver keeps the target they already know; everyone else learns it on stage one. */
function useRevealCues({
  phase,
  fresh,
  bestScore,
  finished,
}: {
  phase: Phase;
  fresh: boolean;
  bestScore: number | null;
  finished: boolean;
}) {
  useEffect(() => {
    if (phase !== "reveal" || !fresh || bestScore === null) return;
    const reduced = prefersReducedMotion();
    const revealDelay = reduced ? 0 : REVEAL_STAGE_TIMES[ZONE_STAGE];
    const scoreDelay = reduced ? REVEAL_REDUCED_MOTION_MS : REVEAL_STAGE_TIMES[SCORE_STAGE];
    const winnerDelay = reduced ? REVEAL_REDUCED_MOTION_MS : REVEAL_STAGE_TIMES[SETTLED_STAGE];
    // Scheduled rather than called directly so StrictMode's first pass is cancelled.
    const revealTimer = setTimeout(() => {
      playReveal();
    }, revealDelay);
    const scoreTimer = setTimeout(() => {
      playScore(bestScore);
    }, scoreDelay);
    const winnerTimer = finished
      ? setTimeout(() => {
          playWinner();
        }, winnerDelay)
      : undefined;
    return () => {
      clearTimeout(revealTimer);
      clearTimeout(scoreTimer);
      if (winnerTimer !== undefined) clearTimeout(winnerTimer);
    };
  }, [bestScore, finished, fresh, phase]);
}

/**
 * The local player's own answer starts highlighted and a spectator starts with everything
 * shown. A choice is remembered against the reveal it belongs to, so a new reveal resets it
 * without any effect or extra render.
 */
function useRevealSelection(data: RevealData | null, playerId: string | null) {
  const [choice, setChoice] = useState<{ reveal: RevealData; id: string | null } | null>(null);
  const own = data?.guesses.find((guess) => guess.playerId === playerId && guess.angle !== null);
  const selectedId = data && choice?.reveal === data ? choice.id : (own?.playerId ?? null);
  const select = (id: string | null) => {
    setChoice(data ? { reveal: data, id } : null);
  };
  return [selectedId, select] as const;
}

export function PlayScene({ forcedPhase }: { forcedPhase?: Phase } = {}) {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const screen = state.currentScreen;
  const phase: Phase =
    forcedPhase ??
    (screen === "reveal" ? "reveal" : screen === "game-psychic" ? "psychic" : "guesser");
  const guessing = useGuessingControls();
  const stage = useRevealStage(phase === "reveal" && state.revealFresh);
  const data = state.revealData;
  const bestScore = data ? Math.max(0, ...data.guesses.map((guess) => guess.points)) : null;
  const finished =
    state.phase === "finished" || (data?.winners.length ?? 0) > 0 || data?.winner !== null;
  useRevealCues({ phase, fresh: state.revealFresh, bestScore, finished });
  const [selectedId, setSelectedId] = useRevealSelection(
    phase === "reveal" ? data : null,
    state.playerId,
  );
  const teamsMode = state.gameMode === "teams";
  const myTeam = state.round.activeTeamId;
  const moveToken = state.targetMove?.id ?? 0;
  /**
   * The dial's slot is measured while the turn is still being played, then pinned for the
   * reveal so the results below it can grow the page instead of shrinking the dial area.
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const playedStageHeight = useRef<number | null>(null);
  /*
   * The dial's slot is measured while the turn is still being played and pinned imperatively
   * for the reveal, so the results below can grow the page instead of shrinking the dial area.
   * A layout effect writes the style before paint, which a React state update could not do
   * without an extra frame.
   */
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (phase !== "reveal") {
      playedStageHeight.current = stage.getBoundingClientRect().height;
      stage.style.removeProperty("height");
      stage.style.removeProperty("flex");
      return;
    }
    const height = playedStageHeight.current;
    if (height) {
      stage.style.height = `${height}px`;
      stage.style.flex = "none";
    }
  });
  useEffect(() => {
    // A rotation or a resize invalidates a portrait measurement instead of reusing it.
    const release = () => {
      playedStageHeight.current = null;
      stageRef.current?.style.removeProperty("height");
      stageRef.current?.style.removeProperty("flex");
    };
    window.addEventListener("resize", release);
    window.addEventListener("orientationchange", release);
    return () => {
      window.removeEventListener("resize", release);
      window.removeEventListener("orientationchange", release);
    };
  }, []);

  if (phase === "reveal" && !data)
    return (
      <main className="screen">
        <h1>جارٍ استعادة نتيجة الجولة…</h1>
        <ConnectionStatus />
      </main>
    );

  let context: ReactNode = null;
  let hint: ReactNode = null;
  let actions: ReactNode;
  let coach: ReactNode = null;
  let dial: ReactNode = null;
  if (phase === "psychic") {
    hint = <p className="dial-hint">الهدف لك فقط — لا تُظهر الشاشة للآخرين</p>;
    actions = <PsychicActions />;
    dial = (
      <Dial
        targetAngle={state.round.targetAngle}
        angle={null}
        animateTarget
        moveToken={moveToken}
      />
    );
    if (state.round.targetAngle !== null) coach = <Coach role="psychic" />;
  } else if (phase === "guesser") {
    context = <ClueCard clue={state.round.clue} />;
    if (guessing.roundRole === "mate")
      hint = <p className="dial-hint">ناقش الإجابة مع فريقك — المتحكم وحده يرسل الاختيار</p>;
    actions = (
      <GuessingActions
        canControl={guessing.canControl}
        canSubmit={guessing.canSubmit}
        submit={guessing.submit}
      />
    );
    coach = (
      <Coach
        key={guessing.canControl ? "guesser" : "observer"}
        role={guessing.canControl ? "guesser" : "observer"}
      />
    );
    dial = (
      <Dial
        onTick={playTick}
        angle={guessing.canControl ? state.round.myAngle : state.round.previewAngle}
        interactive={guessing.canControl}
        locked={guessing.locked}
        playerId={state.playerId}
        playerIndex={state.players.findIndex((player) => player.id === state.playerId)}
        onDraft={guessing.setDraft}
        onChange={(angle) => {
          store.dispatch({ type: "draft", angle });
        }}
        onPreview={(angle) => {
          if (teamsMode && guessing.canControl && state.roomCode)
            controller.send("guess_preview", {
              roomCode: state.roomCode,
              roundNumber: state.round.roundNumber,
              angle,
              ...(state.round.card ? { cardId: state.round.card.id } : {}),
            });
        }}
      />
    );
  } else if (data) {
    const mine = data.guesses.find(
      (guess) => guess.playerId === state.playerId || guess.teamId === myTeam,
    );
    // The clue giver already knows the target, so it never hides and reappears for them.
    const knowsTarget = state.playerId !== null && state.playerId === state.round.psychicId;
    const needleStage = stage >= NEEDLE_STAGE ? 2 : 0;
    const guesses = data.guesses.filter(
      (guess) => needleStage >= NEEDLE_STAGE || guess === mine || guess.playerId === state.playerId,
    );
    // The clue card the guesser already had stays exactly where it was; the psychic never had
    // anything above the dial, so the reveal does not introduce a line that would push it down.
    context =
      state.playerId !== state.round.psychicId ? <ClueCard clue={state.round.clue} /> : null;
    dial = (
      <Dial
        targetAngle={data.targetAngle}
        guesses={guesses}
        playerId={state.playerId}
        highlightPlayerId={selectedId}
        revealStage={knowsTarget ? null : stage}
        animateTarget
        moveToken={moveToken}
      />
    );
    actions = (
      <RevealResults
        stage={stage}
        spectator={false}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    );
  }
  return (
    <main
      className={`screen game game-shell${phase === "reveal" ? " reveal-screen" : ""}`}
      aria-label={phase === "reveal" ? "نتيجة الجولة" : undefined}
    >
      <h1 className="sr-only">
        {phase === "psychic"
          ? "أنت الوسيط"
          : phase === "guesser"
            ? "تخمين الإجابة"
            : "نتيجة الجولة"}
      </h1>
      <GameHeader holdScores={phase === "reveal" && stage < SCORE_STAGE} />
      <RoundStatus
        role={
          phase === "psychic" ? "psychic" : phase === "guesser" ? guessing.roundRole : "spectate"
        }
      />
      {context}
      <Spectrum />
      {hint}
      {/* The dial stage and its dial stay mounted from the clue to the reveal. */}
      <div className={`dial-stage${phase === "reveal" ? " reveal-dial-stage" : ""}`} ref={stageRef}>
        {dial}
      </div>
      {actions}
      <ConnectionStatus />
      {coach}
    </main>
  );
}

export function Psychic() {
  return <PlayScene forcedPhase="psychic" />;
}

export function Guessing() {
  return <PlayScene forcedPhase="guesser" />;
}

export function Reveal({ spectator = false }: { spectator?: boolean }) {
  if (spectator) return <SpectatorReveal />;
  return <PlayScene forcedPhase="reveal" />;
}

/** A watched match shows the same reveal, with no controls of its own. */
function SpectatorReveal() {
  const state = useSession((state) => state);
  const stage = useRevealStage(state.revealFresh);
  const data = state.revealData;
  const bestScore = data ? Math.max(0, ...data.guesses.map((guess) => guess.points)) : null;
  const finished =
    state.phase === "finished" || (data?.winners.length ?? 0) > 0 || data?.winner !== null;
  useRevealCues({ phase: "reveal", fresh: state.revealFresh, bestScore, finished });
  const [selectedId, setSelectedId] = useRevealSelection(state.revealData, null);
  if (!data)
    return (
      <main className="screen">
        <h1>جارٍ استعادة نتيجة الجولة…</h1>
        <ConnectionStatus />
      </main>
    );
  return (
    <main
      className="screen game game-shell reveal-screen spectator-screen"
      aria-label="نتيجة الجولة"
    >
      <h1 className="sr-only">نتيجة الجولة</h1>
      <GameHeader holdScores={stage < SCORE_STAGE} />
      <p>ظهرت النتيجة</p>
      <p className="reveal-clue">
        {state.players.find((player) => player.id === state.round.psychicId)?.displayName ??
          "الوسيط"}
        : {state.round.clue}
      </p>
      <Spectrum />
      <div className="dial-stage reveal-dial-stage">
        <Dial
          targetAngle={data.targetAngle}
          guesses={data.guesses}
          playerId={null}
          highlightPlayerId={selectedId}
          revealStage={stage}
        />
      </div>
      <RevealResults stage={stage} spectator selectedId={selectedId} onSelect={setSelectedId} />
      <ConnectionStatus />
    </main>
  );
}

export function Spectator() {
  const state = useSession((state) => state);
  // A won match still shows its deciding reveal first; a restored finished match opens the
  // standings directly because it has no live reveal to stage.
  if (state.revealData) return <SpectatorReveal />;
  if (state.phase === "finished") return <Winner spectator />;
  return (
    <main className="screen game game-shell spectator-screen">
      <h1>شاشة العرض</h1>
      <GameHeader />
      <RoundStatus role="spectate" />
      {state.phase === "waiting" ? (
        <p>بانتظار بدء المباراة…</p>
      ) : (
        <>
          <Spectrum />
          <section className="card round-clue-card">
            <span>التلميح</span>
            <p>{state.round.clue ?? "بانتظار تلميح الوسيط…"}</p>
          </section>
          <div className="dial-stage">
            <Dial angle={state.round.previewAngle} />
          </div>
          <p>شاهد الجولة وناقش التلميح — لا توجد أدوات لإرسال إجابة هنا.</p>
        </>
      )}
      <ConnectionStatus />
    </main>
  );
}
