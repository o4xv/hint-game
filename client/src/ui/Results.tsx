import type { RevealData } from "@hint/contracts";
import { useEffect, useState, type CSSProperties } from "react";
import { playWinner } from "../session/audio";
import { useGame, useSession } from "./GameContext";
import { Countdown, GameHeader } from "./Game";
import { ConnectionStatus } from "./Entry";

/** Stage indexes shared with the scene that owns the timeline. */
const SCORE_STAGE = 3;
const CONTROL_STAGE = 4;
const SETTLED_STAGE = 5;

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
      className={`card reveal-score-card reveal-stage${stage >= SCORE_STAGE ? " is-visible" : ""}`}
      aria-label="نقاط الجولة والمجموع"
      tabIndex={0}
      // A stage that has not arrived yet must be unreachable for keyboard and assistive tech.
      inert={stage < SCORE_STAGE}
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

/**
 * Everything below the dial on a result screen. The scene above owns the header, the clue
 * line and the dial itself, so the answer zone never jumps between the two phases.
 */
export function RevealResults({
  stage,
  spectator = false,
  selectedId,
  onSelect,
}: {
  stage: number;
  spectator?: boolean;
  selectedId: string | null;
  onSelect: (playerId: string | null) => void;
}) {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const data = state.revealData;
  const finished =
    state.phase === "finished" || (data?.winners.length ?? 0) > 0 || data?.winner !== null;
  if (!data) return null;
  const ready = state.readyState;
  const myReady = state.playerId !== null && ready.playerIds.includes(state.playerId);
  const roomCode = state.roomCode;
  const valid = data.guesses.filter(
    (guess): guess is typeof guess & { angle: number } => guess.angle !== null,
  );
  const distance = Math.min(...valid.map((guess) => Math.abs(guess.angle - data.targetAngle)));
  const closest = valid.filter((guess) => Math.abs(guess.angle - data.targetAngle) === distance);
  return (
    <>
      {/* Only the clue giver lost the line above the dial, so their clue is repeated here. */}
      {state.playerId !== null &&
        state.playerId === state.round.psychicId &&
        state.round.clue !== null && (
          <p className="reveal-clue reveal-stage is-visible">
            {state.displayName ?? "الوسيط"}: {state.round.clue}
          </p>
        )}
      <p className={`reveal-closest reveal-stage${stage >= SCORE_STAGE ? " is-visible" : ""}`}>
        {closest.length
          ? `أقرب إجابة: ${closest.map((guess) => guess.displayName).join(" و ")}`
          : "لم تُسجّل إجابة هذه الجولة"}
      </p>
      {selectedId !== null && (
        <button
          type="button"
          className="btn btn-ghost reveal-show-all"
          onClick={() => {
            onSelect(null);
          }}
        >
          عرض كل الإجابات
        </button>
      )}
      <RoundScores data={data} selectedId={selectedId} onSelect={onSelect} stage={stage} />
      <section
        className={`reveal-handoff reveal-stage${stage >= CONTROL_STAGE ? " is-visible" : ""}`}
        // The controls only accept input once the sequence has settled.
        inert={stage < SETTLED_STAGE}
        aria-hidden={stage < CONTROL_STAGE ? true : undefined}
      >
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
    </>
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
