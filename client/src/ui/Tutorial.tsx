import { useEffect, useState } from "react";
import { SCORING, pointsForGuess, type GameMode, type GuessResult } from "@hint/contracts";
import { Dial } from "./Dial";
import { ClueCard, SpectrumCard } from "./Game";
import { RulesContent } from "./Rules";

/**
 * The interactive explanation. Everything here is synthetic: it never touches the session
 * store, the socket or a live secret, so help can stay open while a real match continues.
 */
interface PracticeCard {
  id: string;
  left: string;
  right: string;
  clue: string;
  target: number;
}

/** Step one uses the familiar cold→hot spectrum with the real card's own example word. */
const WALKTHROUGH: PracticeCard = {
  id: "core-35",
  left: "بارد",
  right: "حار",
  clue: "شاي ساخن",
  target: 130,
};

/**
 * Free play rotates through real cards, each paired with one of its own editorial examples
 * so a clue and its target always belong together. Targets are authored, never random.
 */
export const FREE_PRACTICE_CARDS: PracticeCard[] = [
  { id: "core-9", left: "هادئ", right: "صاخب", clue: "حفلة", target: 152 },
  { id: "core-7", left: "خفيف", right: "ثقيل", clue: "حقيبة سفر", target: 108 },
  { id: "core-13", left: "قديم", right: "حديث", clue: "ساعة ذكية", target: 140 },
  { id: "core-35", left: "بارد", right: "حار", clue: "ماء مثلج", target: 22 },
];

const STEPS = [
  {
    title: "الوسيط يرى الهدف",
    detail:
      "المنطقة الملوّنة سرّية: يراها الوسيط وحده. الأقرب إلى قلبها يمنح ثلاث نقاط، ثم اثنتين، ثم واحدة.",
    next: "التالي",
  },
  {
    title: "الوسيط يعطي تلميحاً",
    detail:
      "التلميح يقرّب المعنى من موضع الهدف. اختار الوسيط «شاي ساخن» لأن الهدف قريب من جهة الحار.",
    next: "جرّب التخمين",
  },
  {
    title: "أنت تخمّن المكان",
    // The interaction itself is described once, in the guidance line under the clue.
    detail: "التلميح يقودك إلى موضع على المقياس، ولا يوجد مؤقت في التجربة.",
    next: "اكشف الهدف",
  },
  {
    title: "نكشف الهدف ونحسب النقاط",
    detail: "النقاط تُحسب من قرب مؤشرك إلى الهدف، لا من الجهة وحدها.",
    next: "جرّب بنفسك",
  },
];

const FICTIONAL_TEAMS = [
  { id: "stars", name: "النجوم", color: "#6C5CE7", psychic: "ريم", controller: "خالد" },
  { id: "falcons", name: "الصقور", color: "#00B894", psychic: "سلمان", controller: "نورة" },
] as const;

/** The other players in the individual demonstration. Exported so tests can score every card. */
export const PRACTICE_INPUTS = [
  { playerId: "practice-2", displayName: "سارة", angle: 96 },
  { playerId: "practice-3", displayName: "أحمد", angle: 158 },
];

/** Points wording used by both the walkthrough and free play. */
export function practiceResultText(points: number): string {
  if (points === 3) return "إصابة دقيقة في القلب";
  if (points === 2) return "قريب جداً من الهدف";
  if (points === 1) return "قريب من الهدف";
  return "خارج مناطق النقاط — المحاولة القادمة أقرب";
}

function resultPoints(angle: number, target: number) {
  return pointsForGuess(angle, target);
}

function Progress({ step, total }: { step: number; total: number }) {
  return (
    // Compact on screen, spelled out for screen readers, so the header stays one row.
    <div className="practice-progress" aria-label={`الخطوة ${step + 1} من ${total}`}>
      <span className="practice-progress-label" aria-hidden="true" dir="ltr">
        {step + 1} / {total}
      </span>
      <span className="practice-progress-track" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <i key={index} className={index <= step ? "is-done" : ""} />
        ))}
      </span>
    </div>
  );
}

function ScoreSummary({ points }: { points: number }) {
  return (
    // The number is written out as well as coloured, so the result never depends on colour.
    <p className="practice-score" role="status">
      <strong>{practiceResultText(points)}</strong>
      <span>
        {points} من 3 نقاط {points === 0 ? "— لا بأس، هذه تجربة" : ""}
      </span>
    </p>
  );
}

/**
 * Individual mode: separate guesses for the eligible players, shown as a small result set.
 * Every row is scored against the card that is actually on the dial, so the list and the
 * needles can never disagree.
 */
function IndividualTeaching({
  guess,
  points,
  target,
}: {
  guess: number;
  points: number;
  target: number;
}) {
  const rows = [
    { name: "أنت", angle: guess, points },
    ...PRACTICE_INPUTS.map((entry) => ({
      name: entry.displayName,
      angle: entry.angle,
      points: resultPoints(entry.angle, target),
    })),
  ];
  return (
    <div className="practice-mode" aria-label="مثال وضع كل لاعب">
      <h4>الوضع الفردي</h4>
      <p>كل لاعب متصل يرسل تخمينه بنفسه، وللوسيط نقاطه المحسوبة من متوسط التخمينات.</p>
      <ul className="practice-score-list">
        {rows.map((row) => (
          <li key={row.name} className={row.name === "أنت" ? "is-mine" : ""}>
            <span>{row.name}</span>
            <small>{row.points} نقاط</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Reduced motion keeps every teaching state but drops the movement. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = () => {
      setReduced(query.matches);
    };
    query.addEventListener("change", listener);
    return () => {
      query.removeEventListener("change", listener);
    };
  }, []);
  return reduced;
}

/**
 * Team mode: the awarded points visibly land in the active team's total, and the turn moves
 * to the next team and its own psychic and controller when the viewer asks for it.
 */
function TeamTeaching({ points }: { points: number }) {
  const reduced = usePrefersReducedMotion();
  const [turn, setTurn] = useState(0);
  const [awarded, setAwarded] = useState(false);
  useEffect(() => {
    // The points arrive just behind the revealed bands, or immediately without motion.
    const timer = window.setTimeout(
      () => {
        setAwarded(true);
      },
      reduced ? 0 : 320,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [reduced]);
  const next = FICTIONAL_TEAMS[(turn + 1) % FICTIONAL_TEAMS.length] ?? FICTIONAL_TEAMS[0];
  return (
    <div className="practice-mode" aria-label="مثال وضع الفرق">
      <h4>وضع الفرق</h4>
      <p>
        الفريق النشط يجيب مرة واحدة عبر متحكّمه، وبقية الفريق يناقش. الفرق الأخرى تشاهد ولا تجيب.
      </p>
      <ul className="practice-team-list">
        {FICTIONAL_TEAMS.map((team, index) => {
          const active = index === turn;
          // The points belong to the team that answered, not to whichever team is active now.
          const scored = index === 0 && awarded;
          const total = scored ? points : 0;
          return (
            <li
              key={team.id}
              className={`practice-team-row${active ? " is-active" : ""}`}
              data-team-turn={active ? "now" : "next"}
            >
              <span className="practice-team-chip" style={{ background: team.color }}>
                {team.name}
              </span>
              <span className="practice-team-score" aria-label={`رصيد ${team.name}: ${total} نقطة`}>
                {total} نقطة
                {scored && <span className="practice-gain">+{points}</span>}
              </span>
              <span className="practice-team-role">
                {active ? "الدور الآن" : "الدور القادم"} — الوسيط: <strong>{team.psychic}</strong> ·
                يثبت الإجابة: <strong>{team.controller}</strong>
              </span>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn btn-secondary practice-turn-button"
        onClick={() => {
          setTurn((current) => (current + 1) % FICTIONAL_TEAMS.length);
        }}
      >
        الدور التالي: {next.name}
      </button>
    </div>
  );
}

function RevealExtras({ mode, angle, target }: { mode: GameMode; angle: number; target: number }) {
  const points = resultPoints(angle, target);
  return (
    <div className="practice-reveal">
      <ScoreSummary points={points} />
      <p className="practice-bands">
        المناطق: {SCORING.BULLSEYE}° الداخلية = 3 نقاط · {SCORING.MIDDLE}° = 2 · {SCORING.OUTER}° =
        1
      </p>
      {mode === "teams" ? (
        <TeamTeaching points={points} />
      ) : (
        <IndividualTeaching guess={angle} points={points} target={target} />
      )}
    </div>
  );
}

export interface TutorialProps {
  /** The room's mode when help is opened from a game, otherwise individual. */
  initialMode?: GameMode;
  /** True when a live match keeps running behind the dialog. */
  live?: boolean;
}

export function PracticeWalkthrough({ initialMode = "individual", live = false }: TutorialProps) {
  const [mode, setMode] = useState<GameMode>(initialMode);
  const [step, setStep] = useState(0);
  const [angle, setAngle] = useState(90);
  const [phase, setPhase] = useState<"walk" | "free">("walk");
  const [freeIndex, setFreeIndex] = useState(0);
  const [freeRevealed, setFreeRevealed] = useState(false);
  const freeCard = FREE_PRACTICE_CARDS[freeIndex] ?? WALKTHROUGH;
  const stepInfo = STEPS[step] ?? { title: "", detail: "", next: "" };

  function restart() {
    setStep(0);
    setAngle(90);
    setPhase("walk");
    setFreeRevealed(false);
  }
  function startFree() {
    setAngle(90);
    setFreeRevealed(false);
    setPhase("free");
  }
  function nextFreeCard() {
    setFreeIndex((index) => (index + 1) % FREE_PRACTICE_CARDS.length);
    startFree();
  }
  function advance() {
    if (step < STEPS.length - 1) setStep(step + 1);
    else startFree();
  }

  const card = phase === "free" ? freeCard : WALKTHROUGH;
  // Step one is the psychic's view and step four is the reveal, so those two draw the target;
  // step two hides it again before the guess. Free play keeps it hidden, visually and in the
  // accessibility tree, until the answer is confirmed.
  const revealTarget =
    phase === "free"
      ? freeRevealed
        ? card.target
        : null
      : step === 0 || step === 3
        ? card.target
        : null;
  const revealed = phase === "free" ? freeRevealed : step === 3;
  const showNeedle = phase === "free" || step >= 2;
  const interactive = phase === "free" ? !freeRevealed : step === 2;
  const guesses: GuessResult[] | undefined =
    mode === "individual" && (phase === "free" ? freeRevealed : step === 3)
      ? [
          {
            playerId: "practice-me",
            displayName: "أنت",
            angle,
            points: resultPoints(angle, card.target),
          },
          ...PRACTICE_INPUTS.map((entry) => ({
            playerId: entry.playerId,
            displayName: entry.displayName,
            angle: entry.angle,
            points: resultPoints(entry.angle, card.target),
          })),
        ]
      : undefined;
  const heading = phase === "free" ? "جرّب بنفسك" : stepInfo.title;
  const detail =
    phase === "free"
      ? "الهدف مخفي هذه المرة ولا يوجد مؤقت: ثبّت اختيارك، وبعدها نكشف الهدف."
      : stepInfo.detail;
  /**
   * Guidance belongs to the step it describes: the first two steps have no needle to move,
   * so telling the viewer to drag one would be wrong.
   */
  const guidance = (() => {
    if (!interactive) {
      if (revealed) return null;
      if (step === 0) return "المنطقة الملوّنة سرّية — اضغط «التالي» لترى كيف يعطي الوسيط تلميحاً.";
      return "التلميح جاهز الآن — الخطوة التالية تترك لك التخمين.";
    }
    return "اسحب المؤشر أو استخدم أسهم لوحة المفاتيح، ثم ثبّت إجابتك.";
  })();

  return (
    <div className="practice" data-step={phase === "free" ? "free" : step}>
      {/* The lesson scrolls; the footer never moves, so it can never paint over the dial. */}
      <div className="practice-body">
        <div className="practice-head">
          <div className="practice-modes" role="group" aria-label="طريقة اللعب">
            {(["individual", "teams"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`pill ${mode === candidate ? "pill-active" : "pill-default"}`}
                aria-pressed={mode === candidate}
                onClick={() => {
                  setMode(candidate);
                }}
              >
                {candidate === "individual" ? "كل لاعب" : "الفرق"}
              </button>
            ))}
          </div>
          {phase === "free" ? (
            <span className="practice-progress-label">بطاقة تجريبية</span>
          ) : (
            <Progress step={step} total={STEPS.length} />
          )}
        </div>

        {live && (
          <p className="practice-live-note">
            الشرح لا يوقف المباراة — أغلق النافذة للعودة إلى الجولة الجارية.
          </p>
        )}

        {/* Step changes are announced, so the lesson is usable without watching the animation. */}
        <div className="practice-heading" aria-live="polite">
          <h3>{heading}</h3>
          <p>{detail}</p>
        </div>

        <SpectrumCard left={card.left} right={card.right} />
        <ClueCard clue={phase === "free" || step >= 1 ? card.clue : null} />

        {/* The one instruction for the step that actually moves the needle. */}
        {guidance && (
          <p className="practice-hint" role="status">
            {guidance}
          </p>
        )}

        <div className="dial-stage">
          <Dial
            targetAngle={revealTarget}
            angle={showNeedle ? angle : null}
            {...(guesses ? { guesses } : {})}
            highlightPlayerId={guesses ? "practice-me" : null}
            playerId="practice-me"
            interactive={interactive}
            onChange={setAngle}
          />
        </div>

        {revealed ? <RevealExtras mode={mode} angle={angle} target={card.target} /> : null}

        <details className="practice-tip">
          <summary>ما الفرق بين تغيير البطاقة وتخطي الدور؟</summary>
          <p>
            <strong>تغيير البطاقة</strong> متاح مرة واحدة في دور الوسيط، ويستبدل المقياس دون خصم
            نقاط، ويبقى الوسيط والفريق والمؤقت كما هما.
          </p>
          <p>
            <strong>تخطي الدور</strong> يُنهي الدور: تُخصم نقطة من الوسيط في الوضع الفردي أو من
            الفريق النشط في وضع الفرق، ثم ينتقل الدور إلى الوسيط التالي.
          </p>
        </details>
      </div>

      <div className="practice-actions">
        {phase === "free" ? (
          <>
            {freeRevealed ? (
              <button type="button" className="btn btn-primary" onClick={nextFreeCard}>
                بطاقة أخرى
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setFreeRevealed(true);
                }}
              >
                تأكيد الإجابة
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPhase("walk");
                setStep(0);
                setAngle(90);
              }}
            >
              رجوع للشرح
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={advance}>
              {stepInfo.next}
            </button>
            <div className="practice-actions-row">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={step === 0}
                onClick={() => {
                  setStep(Math.max(0, step - 1));
                }}
              >
                السابق
              </button>
              <button type="button" className="btn btn-secondary" onClick={restart}>
                إعادة من البداية
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Help panel shared by the landing page, the lobby and the game menu: the visual practice
 * round is the main content, and the precise written rules stay one tap away.
 */
export function HelpPanel({ initialMode = "individual", live = false }: TutorialProps) {
  const [view, setView] = useState<"practice" | "rules">("practice");
  return (
    <div className="help-panel">
      <div className="help-tabs" role="tablist" aria-label="محتوى الشرح">
        <button
          type="button"
          role="tab"
          aria-selected={view === "practice"}
          className={`pill ${view === "practice" ? "pill-active" : "pill-default"}`}
          onClick={() => {
            setView("practice");
          }}
        >
          جرّب جولة
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "rules"}
          className={`pill ${view === "rules" ? "pill-active" : "pill-default"}`}
          onClick={() => {
            setView("rules");
          }}
        >
          القواعد بالتفصيل
        </button>
      </div>
      {/* Both views stay mounted so peeking at the rules never loses the practice progress. */}
      <div className="help-view" hidden={view !== "practice"}>
        <PracticeWalkthrough initialMode={initialMode} live={live} />
      </div>
      <div className="help-view rules-dialog-body" hidden={view !== "rules"}>
        <RulesContent />
      </div>
    </div>
  );
}
