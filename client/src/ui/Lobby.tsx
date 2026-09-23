import { useEffect, useRef, useState } from "react";
import {
  MAX_PLAYERS,
  TEAM_NAME_MAX_LENGTH,
  WINNING_SCORES,
  checkTeamName,
  type PublicTeam,
  type TeamNameIssue,
} from "@hint/contracts";
import { useGame, useSession } from "./GameContext";
import { Rules } from "./Rules";
import { LeaveButton, RoomControls } from "./RoomControls";
import { ConnectionStatus } from "./Entry";
import type { createSessionController } from "../session/controller";
import type { SessionState, createSessionStore } from "../session/store";

/** How long an unconfirmed rename stays "saving" before the editor offers a retry. */
const SAVE_CONFIRM_TIMEOUT_MS = 5_000;

const nameIssueText: Record<TeamNameIssue, string> = {
  blank: "اكتب اسماً للفريق.",
  invalid: "الاسم يحتوي على أحرف غير مسموحة.",
  too_long: `اسم الفريق يجب ألا يزيد على ${TEAM_NAME_MAX_LENGTH} حرفاً.`,
  duplicate: "يوجد فريق بهذا الاسم.",
};

const renameErrorText: Record<string, string> = {
  TEAM_NAME_BLANK: nameIssueText.blank,
  TEAM_NAME_INVALID: nameIssueText.invalid,
  TEAM_NAME_TOO_LONG: nameIssueText.too_long,
  TEAM_NAME_DUPLICATE: nameIssueText.duplicate,
  NOT_OWNER: "صاحب الغرفة وحده يعدّل أسماء الفرق.",
  ROOM_NOT_WAITING: "لا يمكن تعديل الأسماء بعد بدء المباراة.",
  TEAM_NOT_FOUND: "الفريق غير موجود.",
};

/** Inline team rename: client-side rule check, then server confirmation only. */
function TeamNameEditor({
  team,
  otherNames,
  roomCode,
  canEdit,
  controller,
  store,
  actionError,
  rejection,
  connection,
}: {
  team: PublicTeam;
  otherNames: string[];
  roomCode: string;
  canEdit: boolean;
  controller: Pick<ReturnType<typeof createSessionController>, "send">;
  store: ReturnType<typeof createSessionStore>;
  actionError: { event: string; code: string; teamId?: string } | null;
  /** The last rejection the server sent for this team, if any. */
  rejection: { code: string } | null;
  connection: SessionState["connection"];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(team.name);
  /** The attempt the editor waits on. Success is the broadcast carrying this name back. */
  const [attempt, setAttempt] = useState<{ id: number; name: string } | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [retry, setRetry] = useState<null | "timeout" | "offline">(null);
  const [timeouts, setTimeouts] = useState(0);
  const attemptIds = useRef(0);

  // The server accepted the name once the broadcast carries it back, and a rejected
  // save ends the attempt. Both are derived from props, so no effect has to reset state.
  const confirmed = attempt !== null && team.name === attempt.name;
  /**
   * A rejection belongs to this card when the server named it. A server that predates that
   * field only sends the shared error, which is shown while this editor is the one waiting
   * for an answer; anything else would put another team's error on an untouched card.
   */
  const legacyRejection =
    actionError?.event === "rename_team" && actionError.teamId === undefined && inFlight
      ? { code: actionError.code }
      : null;
  const ownRejection = rejection ?? legacyRejection;
  const serverIssue = ownRejection
    ? (renameErrorText[ownRejection.code] ?? "تعذّر حفظ الاسم. حاول مرة أخرى.")
    : null;
  const saving = inFlight && !confirmed && serverIssue === null && retry === null;
  const editing = open && !confirmed;

  useEffect(() => {
    if (!saving) return;
    // A dropped connection is answered on the next tick: the emit may be replayed after a
    // reconnect, but the user must not wait on a spinner that cannot resolve meanwhile.
    const offline = connection !== "connected";
    const timer = window.setTimeout(
      () => {
        setInFlight(false);
        if (offline) {
          setRetry("offline");
          return;
        }
        // Restore a usable form instead of leaving a spinner that never resolves. The
        // draft stays, and a late confirmation still closes the editor.
        setRetry("timeout");
        setTimeouts((count) => count + 1);
      },
      offline ? 0 : SAVE_CONFIRM_TIMEOUT_MS,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [saving, connection]);

  function save() {
    if (saving) return;
    const checked = checkTeamName(draft, otherNames);
    if (!checked.ok) {
      setIssue(nameIssueText[checked.issue]);
      return;
    }
    if (connection !== "connected") {
      setIssue("لا يوجد اتصال بالخادم الآن. تحقّق من الاتصال ثم أعد المحاولة.");
      return;
    }
    setIssue(null);
    setRetry(null);
    setAttempt({ id: (attemptIds.current += 1), name: checked.name });
    setInFlight(true);
    store.dispatch({ type: "clear-error" });
    store.dispatch({ type: "clear-rename-error", teamId: team.id });
    controller.send("rename_team", { roomCode, teamId: team.id, name: checked.name });
  }

  function close() {
    setOpen(false);
    setDraft(team.name);
    setIssue(null);
    setRetry(null);
    setInFlight(false);
    setAttempt(null);
    store.dispatch({ type: "clear-error" });
    store.dispatch({ type: "clear-rename-error", teamId: team.id });
  }

  const retryMessage =
    retry === "offline"
      ? "انقطع الاتصال قبل وصول تأكيد الحفظ. أعد المحاولة عند عودة الاتصال."
      : retry === "timeout"
        ? timeouts > 1
          ? "لم يصل تأكيد الحفظ خلال 5 ثوانٍ مرتين. تحقّق من الاتصال، وإذا تكرر الأمر فقد يحتاج الخادم إلى تحديث."
          : "لم يصل تأكيد الحفظ خلال 5 ثوانٍ. تحقّق من الاتصال ثم حاول مرة أخرى."
        : null;

  if (!canEdit) return <span className="team-name">{team.name}</span>;
  return (
    <div className="team-name-editor">
      {editing ? (
        <form
          className="team-name-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <>
            <label className="sr-only" htmlFor={`team-name-${team.id}`}>
              اسم {team.name}
            </label>
            <input
              id={`team-name-${team.id}`}
              className="input"
              value={draft}
              maxLength={TEAM_NAME_MAX_LENGTH * 2}
              enterKeyHint="done"
              onChange={(event) => {
                setDraft(event.target.value);
                setIssue(null);
                setRetry(null);
              }}
            />
            <div className="team-name-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "جارٍ الحفظ…" : "حفظ"}
              </button>
              <button type="button" className="btn btn-ghost" disabled={saving} onClick={close}>
                إلغاء
              </button>
            </div>
          </>
        </form>
      ) : (
        <div className="team-name-row">
          <span className="team-name">{team.name}</span>
          <button
            type="button"
            className="btn btn-ghost team-name-edit"
            onClick={() => {
              setDraft(team.name);
              setAttempt(null);
              setIssue(null);
              setRetry(null);
              setInFlight(false);
              setOpen(true);
              store.dispatch({ type: "clear-error" });
              store.dispatch({ type: "clear-rename-error", teamId: team.id });
            }}
          >
            تعديل الاسم
          </button>
        </div>
      )}
      {(issue ?? serverIssue) && (
        <p role="alert" className="team-name-error">
          {issue ?? serverIssue}
        </p>
      )}
      {retryMessage !== null && (
        <p role="status" className="team-name-error">
          {retryMessage}
        </p>
      )}
    </div>
  );
}

const lengths = ["سريعة", "عادية", "طويلة", "ماراثون"];
const fallbackPacks = [
  { id: "core", name: "الأساسية", cardCount: 60, familySafe: true },
  { id: "daily-life", name: "الحياة اليومية", cardCount: 50, familySafe: true },
  { id: "entertainment", name: "الترفيه", cardCount: 45, familySafe: true },
];

function ShareRoom({ roomCode, watch = false }: { roomCode: string; watch?: boolean }) {
  const [status, setStatus] = useState("");
  const url = `${window.location.origin}/${watch ? "watch" : "room"}/${roomCode}`;
  async function share() {
    try {
      if (typeof navigator.share === "function")
        await navigator.share({ title: watch ? "شاشة عرض هنت" : "هنت", url });
      else {
        await navigator.clipboard.writeText(url);
        setStatus("✓ تم النسخ");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setStatus("انسخ الرابط أدناه");
    }
  }
  return (
    <div className="share-room">
      <button
        type="button"
        className={watch ? "btn btn-ghost lobby-watch-button" : "btn btn-secondary"}
        aria-label={watch ? "فتح رابط شاشة العرض بدون كشف الهدف السري" : "مشاركة رابط الغرفة"}
        onClick={() => {
          void share();
        }}
      >
        {watch
          ? "شاشة العرض"
          : typeof navigator.share === "function"
            ? "مشاركة الرابط"
            : "نسخ الرابط"}
      </button>
      <span role="status">{status}</span>
      {status === "انسخ الرابط أدناه" && (
        <input
          className="input"
          aria-label="رابط الغرفة"
          value={url}
          readOnly
          onFocus={(event) => {
            event.target.select();
          }}
        />
      )}
    </div>
  );
}

export function Lobby() {
  const { controller, store } = useGame();
  const state = useSession((state) => state);
  const roomCode = state.roomCode;
  if (!roomCode) return null;
  const connectedPlayers = state.players.filter((player) => player.isConnected);
  const connectedInTeam = (teamId: string) =>
    connectedPlayers.filter((player) => player.teamId === teamId).length;
  const teamStartIssue = (() => {
    if (state.gameMode !== "teams") return null;
    if (connectedPlayers.length < 4) return "وضع الفرق يحتاج 4 لاعبين على الأقل";
    const shortTeam = state.teams.find((team) => connectedInTeam(team.id) < 2);
    if (!shortTeam) return null;
    const missing = 2 - connectedInTeam(shortTeam.id);
    return missing >= 2
      ? `فريق ${shortTeam.name} يحتاج لاعبين`
      : `فريق ${shortTeam.name} يحتاج لاعباً إضافياً`;
  })();
  const teamReady = teamStartIssue === null;
  const canStart = connectedPlayers.length >= 2 && teamReady && state.connection === "connected";
  const packNames = (state.cardPacks.length ? state.cardPacks : fallbackPacks)
    .filter((pack) => state.selectedPackIds.includes(pack.id))
    .map((pack) => pack.name)
    .join("، ");
  return (
    <main className="screen lobby-screen">
      <header className="lobby-header">
        <LeaveButton />
        <h1>انتظار اللاعبين</h1>
      </header>
      <div className="card-accent lobby-code-card">
        <strong dir="ltr" className="lobby-room-code">
          {roomCode}
        </strong>
        <ShareRoom roomCode={roomCode} />
        <ShareRoom roomCode={roomCode} watch />
      </div>
      <div className="lobby-length-summary" role="status">
        <strong>
          مباراة{" "}
          {lengths[WINNING_SCORES.findIndex((score) => score === state.winningScore)] ?? "عادية"}
        </strong>
        <span>الهدف {state.winningScore} نقطة</span>
      </div>
      <section className="lobby-setup-summary" aria-label="ملخص إعدادات الغرفة">
        {[
          state.gameMode === "teams" ? `${state.teamCount} فرق` : "كل لاعب",
          `الهدف ${state.winningScore} نقطة`,
          `${state.selectedPackIds.length} حزم: ${packNames}`,
          state.psychicTimerEnabled ? "مؤقت الوسيط يعمل" : "مؤقت الوسيط متوقف",
        ].map((text) => (
          <span key={text} className="lobby-setup-chip">
            {text}
          </span>
        ))}
      </section>
      <Rules />
      {state.gameMode === "teams" && (
        <section className="card lobby-teams" aria-label="الفرق">
          <h2>الفرق</h2>
          <div className="team-card-grid">
            {state.teams.map((team) => {
              const members = state.players.filter((player) => player.teamId === team.id);
              const connected = members.filter((player) => player.isConnected).length;
              const active = state.round.activeTeamId === team.id;
              return (
                <article
                  key={team.id}
                  className={`team-card${active ? " is-active" : ""}`}
                  data-team-id={team.id}
                >
                  <header className="team-card-header">
                    <span
                      className="team-color"
                      style={{ background: team.color }}
                      aria-hidden="true"
                    />
                    <TeamNameEditor
                      team={team}
                      otherNames={state.teams
                        .filter((candidate) => candidate.id !== team.id)
                        .map((candidate) => candidate.name)}
                      roomCode={roomCode}
                      canEdit={state.isOwner}
                      controller={controller}
                      store={store}
                      actionError={state.actionError}
                      rejection={state.renameErrors[team.id] ?? null}
                      connection={state.connection}
                    />
                  </header>
                  <p className="team-card-meta">
                    {members.length} أعضاء · {connected} متصل
                    {active && <span className="team-card-active">الدور الآن</span>}
                  </p>
                  <ul className="team-members">
                    {members.map((player) => (
                      <li
                        key={player.id}
                        className={player.isConnected ? "" : "is-disconnected"}
                        data-player-id={player.id}
                      >
                        <span>{player.displayName}</span>
                        {player.id === state.playerId && <small>أنت</small>}
                        {!player.isConnected && <small>غير متصل</small>}
                      </li>
                    ))}
                    {members.length === 0 && <li className="is-empty">لا يوجد لاعبون بعد</li>}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <section className="card lobby-roster">
        <h2>
          اللاعبون ({state.players.length}/{MAX_PLAYERS})
        </h2>
        <div className="lobby-player-grid">
          {state.players.map((player) => (
            <div
              key={player.id}
              className={`player-badge on-card${player.id === state.playerId ? " active" : ""}${player.isConnected ? "" : " disconnected"}`}
            >
              <span className="name">{player.displayName}</span>
              {state.gameMode === "teams" && (
                <small className="lobby-player-team">
                  {state.teams.find((team) => team.id === player.teamId)?.name ?? "بدون فريق"}
                </small>
              )}
              <span className="score" aria-label={`${player.score} نقطة`}>
                {player.score}
              </span>
            </div>
          ))}
        </div>
      </section>
      {state.isOwner && (
        <details className="lobby-settings-disclosure">
          <summary>خيارات اللعبة</summary>
          <div className="card">
            <h2 className="lobby-setting-label">هدف الفوز</h2>
            <div className="winning-score-grid">
              {WINNING_SCORES.map((score, index) => (
                <button
                  key={score}
                  type="button"
                  className={`pill winning-score-option ${score === state.winningScore ? "pill-active" : "pill-default"}`}
                  data-winning-score={score}
                  aria-label={`${lengths[index] ?? "عادية"}، الهدف ${score} نقطة`}
                  aria-pressed={score === state.winningScore}
                  onClick={() => {
                    if (score !== state.winningScore)
                      controller.send("update_settings", { roomCode, winningScore: score });
                  }}
                >
                  <strong>{lengths[index]}</strong>
                  <span>{score} نقاط</span>
                </button>
              ))}
            </div>
            <h2 className="lobby-setting-label">مؤقت الوسيط</h2>
            <div className="pill-row">
              {[false, true].map((enabled) => (
                <button
                  key={String(enabled)}
                  type="button"
                  className={`pill ${enabled === state.psychicTimerEnabled ? "pill-active" : "pill-default"}`}
                  aria-pressed={enabled === state.psychicTimerEnabled}
                  onClick={() => {
                    if (enabled !== state.psychicTimerEnabled)
                      controller.send("toggle_psychic_timer", { roomCode });
                  }}
                >
                  {enabled ? "نعم" : "لا"}
                </button>
              ))}
            </div>
            <h2 className="lobby-setting-label">طريقة اللعب</h2>
            <div className="pill-row">
              {(["individual", "teams"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`pill ${mode === state.gameMode ? "pill-active" : "pill-default"}`}
                  aria-pressed={mode === state.gameMode}
                  onClick={() => {
                    if (mode !== state.gameMode)
                      controller.send("update_game_mode", { roomCode, gameMode: mode });
                  }}
                >
                  {mode === "individual" ? "كل لاعب" : "فرق"}
                </button>
              ))}
            </div>
            {state.gameMode === "teams" && (
              <>
                <h2 className="lobby-setting-label">عدد الفرق</h2>
                <div className="pill-row">
                  {[2, 3, 4].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={`pill ${count === state.teamCount ? "pill-active" : "pill-default"}`}
                      aria-pressed={count === state.teamCount}
                      onClick={() => {
                        controller.send("update_team_count", { roomCode, teamCount: count });
                      }}
                    >
                      {count}
                    </button>
                  ))}
                </div>
                <div className="team-assignment-list">
                  {state.players.map((player) => (
                    <label key={player.id} className="team-assignment-row">
                      <span>{player.displayName}</span>
                      <select
                        className="team-select"
                        aria-label={`فريق ${player.displayName}`}
                        value={player.teamId ?? ""}
                        onChange={(event) => {
                          controller.send("assign_team", {
                            roomCode,
                            playerId: player.id,
                            teamId: event.target.value,
                          });
                        }}
                      >
                        {state.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <p className="team-mode-hint">
                  يحتاج كل فريق لاعبين على الأقل. يتناوب وسيط ومتحكم واحد في مؤشر الفريق.
                </p>
              </>
            )}
            <h2 className="lobby-setting-label">حزم البطاقات</h2>
            <div className="pack-grid">
              {(state.cardPacks.length ? state.cardPacks : fallbackPacks).map((pack) => {
                const selected = state.selectedPackIds.includes(pack.id);
                return (
                  <button
                    key={pack.id}
                    type="button"
                    className={`pack-option${selected ? " is-selected" : ""}`}
                    data-pack-id={pack.id}
                    aria-pressed={selected}
                    onClick={() => {
                      if (selected && state.selectedPackIds.length === 1) return;
                      controller.send("update_packs", {
                        roomCode,
                        selectedPackIds: selected
                          ? state.selectedPackIds.filter((id) => id !== pack.id)
                          : [...state.selectedPackIds, pack.id],
                      });
                    }}
                  >
                    <span>
                      {pack.name}
                      {!pack.familySafe && " +16"}
                    </span>
                    <small>{pack.cardCount} بطاقة</small>
                  </button>
                );
              })}
            </div>
            <RoomControls inline />
          </div>
        </details>
      )}
      {state.joinError && (
        <p role="alert" className="entry-error">
          {state.joinError}
        </p>
      )}
      <div className="lobby-action-bar">
        {state.isOwner ? (
          <>
            <button
              type="button"
              className="btn btn-primary lobby-primary-action"
              disabled={!canStart}
              onClick={() => {
                controller.send("start_game", { roomCode });
              }}
            >
              {canStart ? "ابدأ اللعبة" : (teamStartIssue ?? "بانتظار لاعبين على الأقل")}
            </button>
            {!canStart && (
              <p className="lobby-start-reason" role="status">
                {teamStartIssue ?? "تحتاج اللعبة إلى لاعبين متصلين على الأقل"}
              </p>
            )}
          </>
        ) : (
          <p className="lobby-waiting-message">بانتظار صاحب الغرفة لبدء اللعبة…</p>
        )}
      </div>
      <ConnectionStatus />
    </main>
  );
}
