import { useSession } from "./GameContext";

export type RoundRole = "psychic" | "guess" | "ctrl" | "mate" | "watch" | "spectate";

/**
 * Compact round status: who acts now, who holds the dial, and what the viewer is waiting
 * for. Every role gets wording for its own situation instead of generic instructions.
 */
export function RoundStatus({ role }: { role: RoundRole }) {
  const state = useSession((state) => state);
  const teamsMode = state.gameMode === "teams";
  const psychic = state.players.find((player) => player.id === state.round.psychicId);
  const controller = state.players.find((player) => player.id === state.round.controllerId);
  const activeTeam = state.teams.find((team) => team.id === state.round.activeTeamId);
  const myTeamId = state.players.find((player) => player.id === state.playerId)?.teamId ?? null;
  // Same eligibility the server scores and waits on: a disconnected guesser is not counted
  // and is not listed as someone the round is waiting for.
  const guessers = state.players.filter(
    (player) =>
      player.id !== state.round.psychicId && !player.awaitingNextRound && player.isConnected,
  );
  const answered = guessers.filter((player) => player.hasSubmitted);
  const waiting = guessers.filter((player) => !player.hasSubmitted);
  const controllerReconnecting = Boolean(controller && !controller.isConnected);
  const waitingNames = waiting
    .slice(0, 3)
    .map((player) => player.displayName)
    .join("، ");
  const more = waiting.length > 3 ? ` و${waiting.length - 3} غيرهم` : "";

  const stateText = (() => {
    if (role === "psychic") {
      if (state.round.clue) return "تم إرسال التلميح — بانتظار الإجابات";
      if (state.round.targetAngle === null) return "جارٍ استعادة الهدف…";
      return "اكتب تلميحاً ثم أرسله قبل انتهاء الوقت";
    }
    if (!state.round.clue) {
      // The clue card already says the round is waiting for a hint; this line says what the
      // viewer can usefully do right now instead of repeating it.
      if (role === "ctrl" || role === "mate" || role === "guess")
        return "جرّب حركة المؤشر الآن، وعدّلها بعد وصول التلميح";
      if (role === "watch") return "ستتابع جولة الفريق النشط عند وصول التلميح";
      return "بانتظار تلميح الوسيط…";
    }
    if (role === "guess" || role === "ctrl") {
      if (state.round.hasSubmitted) return "تم تثبيت الإجابة — بانتظار البقية";
      if (state.guessPending) return "جارٍ تثبيت الإجابة…";
      return "اختر موقع الإجابة على المؤشر ثم ثبّتها";
    }
    return teamsMode ? "الجولة جارية — شاهد مؤشر الفريق النشط" : "الجولة جارية الآن";
  })();

  return (
    <section className={`round-status round-status-role-${role}`} aria-label="حالة الجولة">
      {teamsMode && activeTeam && (
        <p className="round-status-line">
          <span>الدور الآن:</span> <strong>{activeTeam.name}</strong>
          {myTeamId === activeTeam.id && <small className="round-status-tag">فريقك</small>}
        </p>
      )}
      <p className="round-status-line round-status-secondary">
        <span>الوسيط:</span>{" "}
        <strong title={psychic?.displayName ?? "—"}>{psychic?.displayName ?? "—"}</strong>
        {psychic?.id === state.playerId && <small className="round-status-tag">أنت</small>}
      </p>
      {teamsMode && controller && (
        <p
          className={`round-status-line round-status-controller${role === "ctrl" ? " is-you" : ""}${controllerReconnecting ? " is-reconnecting" : ""}`}
        >
          <span>يحرك المؤشر ويثبت الإجابة:</span>{" "}
          <strong title={controller.displayName}>{controller.displayName}</strong>
          {role === "ctrl" && <small className="round-status-tag">دورك لتحريك المؤشر</small>}
          {controllerReconnecting && (
            <small className="round-status-tag round-status-reconnect">يعيد الاتصال…</small>
          )}
        </p>
      )}
      {!teamsMode && guessers.length > 0 && (
        <p className="round-status-line">
          <span>الإجابات:</span>{" "}
          <strong>
            {answered.length} من {guessers.length}
          </strong>
          {waiting.length > 0 && (
            <small className="round-status-waiting">
              بانتظار {waitingNames}
              {more}
            </small>
          )}
        </p>
      )}
      {role === "watch" && activeTeam && (
        <p className="round-status-line round-status-watch">
          <span>أنتم تشاهدون:</span> <strong>{activeTeam.name}</strong>
        </p>
      )}
      <p className="round-status-state" role="status">
        {stateText}
      </p>
    </section>
  );
}
