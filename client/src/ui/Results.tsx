import type { RevealData } from "@hint/contracts";
import { useEffect, useState, type CSSProperties } from "react";
import { playReveal, playScore, playWinner } from "../session/audio";
import { useGame, useSession } from "./GameContext";
import { Countdown, GameHeader, Spectrum } from "./Game";
import { Dial } from "./Dial";
import { ConnectionStatus } from "./Entry";
import { RoundStatus } from "./RoundStatus";

/**
 * One staged reveal per round: needles, then the closest answer, then round points and
 * totals, settled before a second. Reduced motion collapses the timing and drops the
 * movement, and restored results open settled.
 */
const REVEAL_STAGE_TIMES = [0, 280, 520, 950] as const;
const REVEAL_SETTLED = REVEAL_STAGE_TIMES.length - 1;
const REVEAL_REDUCED_MOTION_MS = 150;

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useRevealStage(roundNumber: number, animate: boolean) {
  const [stage, setStage] = useState(animate ? 0 : REVEAL_SETTLED);
  // Deps are the round and its freshness, so a duplicate reveal for the same round never
  // restarts the sequence. StrictMode's second pass reschedules after the first cleanup.
  useEffect(() => {
    if (!animate) return;
    const reduced = prefersReducedMotion();
    const timers = REVEAL_STAGE_TIMES.slice(1).map((delay, index) =>
      window.setTimeout(
        () => {
          setStage(index + 1);
        },
        reduced ? REVEAL_REDUCED_MOTION_MS : delay,
      ),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [animate, roundNumber]);
  // Recovery can turn a live reveal into a restored one while this component stays
  // mounted: the sequence must then settle immediately instead of waiting for stages
  // whose timers were cancelled.
  return animate ? stage : REVEAL_SETTLED;
}

function RoundScores({
  data,
  selectedId,
  onSelect,
  stage,
}: {
  data: RevealData;
  selectedId?: string | null;
  onSelect?: (playerId: string | null) => void;
  stage: number;
}) {
  const state = useSession((state) => state);
  const entries =
    data.gameMode === "teams"
      ? data.updatedTeams.map((team) => ({
          id: team.id,
          name: team.name,
          total: team.score,
          points: team.id === data.activeTeamId ? (data.guesses[0]?.points ?? 0) : 0,
        }))
      : data.updatedScores.map((player) => ({
          id: player.playerId,
          name: player.displayName,
          total: player.totalScore,
          points:
            player.playerId === state.round.psychicId
              ? (data.psychicPoints ?? 0)
              : (data.guesses.find((guess) => guess.playerId === player.playerId)?.points ?? 0),
        }));
  const breakdown = data.psychicBreakdown;
  return (
    <section
      className={`card reveal-score-card reveal-stage${stage >= 2 ? " is-visible" : ""}`}
      aria-label="نقاط الجولة والمجموع"
      tabIndex={0}
    >
      <div className="reveal-score-row reveal-score-header">
        <span>{data.gameMode === "teams" ? "الفريق" : "اللاعب"}</span>
        <b>نقاط الجولة</b>
        <strong>المجموع</strong>
      </div>
      {entries
        .sort((first, second) => second.total - first.total)
        .map((entry, index) => {
          const selectable = onSelect !== undefined && data.gameMode !== "teams";
          const selected = selectable && selectedId === entry.id;
          const answered = data.guesses.some(
            (guess) => guess.playerId === entry.id && guess.angle !== null,
          );
          const className = `reveal-score-row${entry.id === state.playerId ? " is-current" : ""}${selected ? " is-selected" : ""}`;
          const style = { "--row-index": Math.min(index, 6) } as CSSProperties;
          const content = (
            <>
              <span>{entry.name}</span>
              <b className="round-points">
                {entry.points >= 0 ? "+" : ""}
                {entry.points}
              </b>
              <strong>{entry.total}</strong>
            </>
          );
          return selectable ? (
            <button
              key={entry.id}
              type="button"
              className={className}
              style={style}
              aria-pressed={selected}
              aria-label={`${entry.name}، ${entry.total} نقطة${answered ? "" : "، لم يجب"}`}
              onClick={() => {
                onSelect(selected ? null : entry.id);
              }}
            >
              {content}
            </button>
          ) : (
            <div key={entry.id} className={className} style={style}>
              {content}
            </div>
          );
        })}
      {data.gameMode !== "teams" && breakdown && (
        <p className="psychic-score-explanation">
          {breakdown.allMissPenalty
            ? "نقاط الوسيط: لم يصب أحد المنطقة، لذلك تُخصم نقطة واحدة."
            : `نقاط الوسيط: متوسط الإجابات ${breakdown.averagePoints}${breakdown.twoPlayerBonus ? " + مكافأة إصابة اللاعب الوحيد 1" : ""}${breakdown.bullseyeBonus ? ` + مكافأة الإصابات الدقيقة ${breakdown.bullseyeBonus}` : ""} = ${data.psychicPoints ?? 0}`}
        </p>
      )}
    </section>
  );
}

export function Reveal({ spectator = false }: { spectator?: boolean }) {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const data = state.revealData;
  const bestScore = data ? Math.max(0, ...data.guesses.map((guess) => guess.points)) : null;
  const finished =
    state.phase === "finished" || (data?.winners.length ?? 0) > 0 || data?.winner !== null;
  const stage = useRevealStage(state.round.roundNumber, state.revealFresh);
  const myGuess = data?.guesses.find((guess) => guess.playerId === state.playerId);
  const [selectedId, setSelectedId] = useState<string | null>(
    myGuess && myGuess.angle !== null ? (state.playerId ?? null) : null,
  );
  useEffect(() => {
    if (!state.revealFresh || bestScore === null) return;
    // Sounds follow the same clock as the visuals: with reduced motion the stages collapse,
    // so the score and winner cues move with them instead of arriving late.
    const reduced = prefersReducedMotion();
    const scoreDelay = reduced ? REVEAL_REDUCED_MOTION_MS : REVEAL_STAGE_TIMES[2];
    const winnerDelay = reduced ? REVEAL_REDUCED_MOTION_MS : REVEAL_STAGE_TIMES[REVEAL_SETTLED];
    // Scheduled rather than called directly so StrictMode's first pass is cancelled.
    const revealTimer = setTimeout(() => {
      playReveal();
    }, 0);
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
  }, [bestScore, finished, state.revealFresh, state.round.roundNumber]);
  if (!data)
    return (
      <main className="screen">
        <h1>جارٍ استعادة نتيجة الجولة…</h1>
        <ConnectionStatus />
      </main>
    );
  const ready = state.readyState;
  const myReady = state.playerId !== null && ready.playerIds.includes(state.playerId);
  const roomCode = state.roomCode;
  const valid = data.guesses.filter(
    (guess): guess is typeof guess & { angle: number } => guess.angle !== null,
  );
  const distance = Math.min(...valid.map((guess) => Math.abs(guess.angle - data.targetAngle)));
  const closest = valid.filter((guess) => Math.abs(guess.angle - data.targetAngle) === distance);
  return (
    <main className="screen game game-shell reveal-screen" aria-label="نتيجة الجولة">
      <h1 className="sr-only">نتيجة الجولة</h1>
      <GameHeader holdScores={stage < 2} />
      {spectator && <p>ظهرت النتيجة</p>}
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
          playerId={state.playerId}
          highlightPlayerId={selectedId}
        />
      </div>
      <p className={`reveal-closest reveal-stage${stage >= 1 ? " is-visible" : ""}`}>
        {closest.length
          ? `أقرب إجابة: ${closest.map((guess) => guess.displayName).join(" و ")}`
          : "لم تُسجّل إجابة هذه الجولة"}
      </p>
      {selectedId !== null && (
        <button
          type="button"
          className="btn btn-ghost reveal-show-all"
          onClick={() => {
            setSelectedId(null);
          }}
        >
          عرض كل الإجابات
        </button>
      )}
      <RoundScores data={data} selectedId={selectedId} onSelect={setSelectedId} stage={stage} />
      <section className="reveal-handoff">
        {finished ? (
          <>
            {spectator && <p>انتهت المباراة</p>}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                store.dispatch({ type: "navigate", screen: "winner" });
              }}
            >
              عرض النتائج النهائية
            </button>
          </>
        ) : (
          <>
            <p className="ready-status" aria-live="polite">
              <span>{ready.paused ? "الجولة متوقفة مؤقتاً" : "الجولة التالية خلال"}</span>{" "}
              <Countdown endsAt={ready.endsAt} pausedMs={ready.paused ? ready.remainingMs : null} />{" "}
              · {ready.readyCount} / {ready.requiredCount} جاهز
            </p>
            {!spectator && (
              <button
                type="button"
                className={`btn ${myReady ? "btn-secondary is-ready" : "btn-primary"}`}
                aria-pressed={myReady}
                onClick={() => {
                  if (roomCode)
                    controller.send("round_ready", {
                      roomCode,
                      roundNumber: state.round.roundNumber,
                      ready: !myReady,
                    });
                }}
              >
                {myReady ? "✓ جاهز" : "أنا جاهز"}
              </button>
            )}
            {state.isOwner && !spectator && (
              <div className="round-host-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => {
                    if (roomCode)
                      controller.send("set_round_pause", {
                        roomCode,
                        roundNumber: state.round.roundNumber,
                        paused: !ready.paused,
                      });
                  }}
                >
                  {ready.paused ? "استئناف العد التنازلي" : "إيقاف العد التنازلي"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  onClick={() => {
                    if (roomCode)
                      controller.send("next_round", {
                        roomCode,
                        roundNumber: state.round.roundNumber,
                      });
                  }}
                >
                  ابدأ الآن
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <ConnectionStatus />
    </main>
  );
}

function ShareResult({ text }: { text: string }) {
  const [status, setStatus] = useState("");
  async function share() {
    setStatus("");
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "هنت", text, url: window.location.origin });
        return;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        )
          return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${window.location.origin}`);
      setStatus("✓ تم نسخ النتيجة");
    } catch {
      setStatus("انسخ النتيجة أدناه");
    }
  }
  return (
    <div className="share-room">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          void share();
        }}
      >
        مشاركة النتيجة
      </button>
      <span role="status">{status}</span>
      {status === "انسخ النتيجة أدناه" && (
        <textarea
          className="input"
          aria-label="نص النتيجة للمشاركة"
          readOnly
          value={`${text}\n${window.location.origin}`}
          rows={5}
          onFocus={(event) => {
            event.target.select();
          }}
        />
      )}
    </div>
  );
}

export function Winner({ spectator = false }: { spectator?: boolean }) {
  useEffect(() => {
    const timer = setTimeout(playWinner, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const { store, controller, leave } = useGame();
  const state = useSession((state) => state);
  const data = state.finalState ?? state.revealData;
  const winners = data?.winners ?? [];
  const entries =
    (data?.gameMode ?? state.gameMode) === "teams"
      ? (data?.updatedTeams ?? state.teams).map((team) => ({
          id: team.id,
          name: team.name,
          score: team.score,
        }))
      : data
        ? ("leaderboard" in data ? data.leaderboard : data.updatedScores).map((player) => ({
            id: player.playerId,
            name: player.displayName,
            score: player.totalScore,
          }))
        : state.players.map((player) => ({
            id: player.id,
            name: player.displayName,
            score: player.score,
          }));
  entries.sort((first, second) => second.score - first.score);
  const shareText = `نتيجة هنت\n${entries.map((entry) => `${entry.name}: ${entry.score}`).join("\n")}`;
  const voted = state.playerId !== null && state.rematchState.playerIds.includes(state.playerId);
  return (
    <main className="screen winner-screen">
      <GameHeader />
      <h1>النتائج النهائية</h1>
      <h2 className="winner-title">
        {winners.length > 1 ? "فوز مشترك!" : winners.length ? "الفائز!" : "انتهت المباراة"}
      </h2>
      {winners.length > 0 && (
        <ul className="winner-names" aria-label="الفائزون">
          {winners.map((winner) => (
            <li key={winner.playerId}>{winner.displayName}</li>
          ))}
        </ul>
      )}
      {data && "reason" in data && <p>{data.reason}</p>}
      {!spectator && (
        <section className="rematch-section">
          <button
            type="button"
            className="btn btn-primary"
            aria-pressed={voted}
            onClick={() => {
              if (state.roomCode)
                controller.send("vote_rematch", { roomCode: state.roomCode, vote: !voted });
            }}
          >
            {voted ? "✓ تم التصويت — إلغاء التصويت" : "إعادة المباراة"}
          </button>
          <p role="status">
            {state.rematchState.voteCount} / {state.rematchState.requiredCount} أصوات لإعادة
            المباراة
          </p>
          <p>بعد موافقة الأغلبية نعود إلى نفس الغرفة، ويبدأ صاحب الغرفة المباراة.</p>
        </section>
      )}
      <section className="card winner-score-card" aria-label="النتيجة النهائية">
        {entries.map((entry, index) => (
          <div key={entry.id} className="winner-score-row">
            <span>{index + 1}</span>
            <strong>{entry.name}</strong>
            <b>{entry.score}</b>
          </div>
        ))}
      </section>
      {Boolean(data?.awards?.length) && (
        <details className="match-awards">
          <summary>جوائز المباراة</summary>
          {(data?.awards ?? []).map((award) => (
            <section className="card match-award" key={award.type}>
              <h2>{award.title}</h2>
              <ul>
                {[
                  ...new Map(award.players.map((player) => [player.playerId, player])).values(),
                ].map((player) => (
                  <li key={player.playerId}>{player.displayName}</li>
                ))}
              </ul>
            </section>
          ))}
        </details>
      )}
      <div className="winner-secondary-actions">
        <ShareResult text={shareText} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            leave();
            store.dispatch({ type: "navigate", screen: "home" });
          }}
        >
          غرفة جديدة
        </button>
      </div>
      <ConnectionStatus />
    </main>
  );
}

export function Spectator() {
  const state = useSession((state) => state);
  // A won match still shows its deciding reveal first; a restored finished match opens the
  // standings directly because it has no live reveal to stage.
  if (state.revealData) return <Reveal spectator />;
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

export function Waiting() {
  const { controller, leave } = useGame();
  const state = useSession((state) => state);
  const pending = state.pendingJoin;
  return (
    <main className="screen waiting-screen">
      <h1>{pending ? "بانتظار موافقة المضيف" : "ستنضم في الجولة التالية"}</h1>
      <p>
        {pending
          ? "أرسلنا طلبك إلى صاحب الغرفة."
          : "تابع النقاش، وسندخلك تلقائيًا عند بداية الجولة القادمة."}
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          if (pending) controller.send("cancel_join_request", pending);
          leave();
        }}
      >
        {pending ? "إلغاء الطلب" : "مغادرة الغرفة"}
      </button>
      <ConnectionStatus />
    </main>
  );
}
