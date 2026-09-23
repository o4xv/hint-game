import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSession, useGame } from "./GameContext";
import { Dialog } from "./Dialog";
import { HelpPanel } from "./Tutorial";
import { RoomControlPanel } from "./RoomControls";

export type GamePanel = "menu" | "help" | "room" | "leave" | "scores";

const GameMenuContext = createContext<{ open: (panel: GamePanel) => void } | null>(null);

/**
 * One dialog host above the screens. The round keeps changing phase behind an open panel —
 * the clue arrives, the reveal starts, the next round begins — so the panel belongs to the
 * app, not to the header that happens to be mounted when it opens.
 */
export function GameMenuProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<GamePanel | null>(null);
  const { store } = useGame();
  useEffect(
    () =>
      store.subscribe(() => {
        if (!store.getSnapshot().roomCode) setPanel(null);
      }),
    [store],
  );
  return (
    <GameMenuContext.Provider value={{ open: setPanel }}>
      {children}
      {panel !== null && (
        <GameDialog
          panel={panel}
          onPanel={setPanel}
          onClose={() => {
            setPanel(null);
          }}
        />
      )}
    </GameMenuContext.Provider>
  );
}

export function useGameMenu() {
  const controls = useContext(GameMenuContext);
  if (!controls) throw new Error("GameMenuProvider is required");
  return controls;
}

/**
 * One dialog host for the whole in-game header. Menu, help, room management, leaving and
 * the scoreboard replace each other inside the same dialog, so two dialogs never stack.
 */
export function GameDialog({
  panel,
  onPanel,
  onClose,
}: {
  panel: GamePanel;
  onPanel: (panel: GamePanel) => void;
  onClose: () => void;
}) {
  const { leave } = useGame();
  const state = useSession((state) => state);
  const title =
    panel === "help"
      ? "كيف تلعب هنت؟"
      : panel === "room"
        ? "إدارة الغرفة"
        : panel === "leave"
          ? "مغادرة الغرفة؟"
          : panel === "scores"
            ? "لوحة النتائج"
            : "قائمة اللعبة";
  return (
    <Dialog
      title={title}
      closeLabel="إغلاق القائمة"
      onClose={onClose}
      className={panel === "help" ? "help-dialog" : undefined}
    >
      {panel === "menu" && (
        <div className="game-menu-panel">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              onPanel("help");
            }}
          >
            شرح اللعبة
          </button>
          {state.isOwner && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                onPanel("room");
              }}
            >
              إدارة الغرفة
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              onPanel("scores");
            }}
          >
            لوحة النتائج
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onPanel("leave");
            }}
          >
            مغادرة الغرفة
          </button>
        </div>
      )}
      {panel === "help" && (
        <>
          {/* The live match keeps running behind this panel, and the practice round says so. */}
          <HelpPanel initialMode={state.gameMode} live />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onPanel("menu");
            }}
          >
            رجوع
          </button>
        </>
      )}
      {panel === "room" && (
        <>
          <RoomControlPanel onDone={onClose} />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onPanel("menu");
            }}
          >
            رجوع
          </button>
        </>
      )}
      {panel === "leave" && (
        <>
          <p>هل تريد مغادرة المباراة؟</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onClose();
              leave();
            }}
          >
            مغادرة
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onPanel("menu");
            }}
          >
            إلغاء
          </button>
        </>
      )}
      {panel === "scores" && <ScoreboardContent />}
    </Dialog>
  );
}

interface ScoreRow {
  id: string;
  name: string;
  score: number;
  rank: number;
  connected: boolean;
  isMine: boolean;
  isActiveTeam: boolean;
  /** Short state markers that stay beside the name. */
  markers: string[];
  /** Quiet second line for connection counts and other secondary state. */
  secondary: string | null;
}

/** Shared ranks for tied scores, and the roster order decides ties so rows never jump. */
function rankRows(entries: { id: string; name: string; score: number }[]): Map<string, number> {
  const sorted = [...entries].sort((first, second) => second.score - first.score);
  const ranks = new Map<string, number>();
  let previousScore: number | null = null;
  let previousRank = 0;
  sorted.forEach((entry, index) => {
    const rank = previousScore === entry.score ? previousRank : index + 1;
    ranks.set(entry.id, rank);
    previousScore = entry.score;
    previousRank = rank;
  });
  return ranks;
}

export function ScoreboardContent() {
  const state = useSession((state) => state);
  const teamsMode = state.gameMode === "teams";
  const entries = teamsMode
    ? state.teams.map((team) => ({ id: team.id, name: team.name, score: team.score }))
    : state.players.map((player) => ({
        id: player.id,
        name: player.displayName,
        score: player.score,
      }));
  const ranks = rankRows(entries);
  const myTeamId = state.players.find((player) => player.id === state.playerId)?.teamId ?? null;
  const rows: ScoreRow[] = entries.map((entry) => {
    const player = teamsMode ? null : state.players.find((candidate) => candidate.id === entry.id);
    const markers: string[] = [];
    let secondary: string | null = null;
    if (!teamsMode) {
      if (entry.id === state.round.psychicId) markers.push("الوسيط");
      if (entry.id === state.round.controllerId) markers.push("يحرك المؤشر");
      if (entry.id === state.playerId) markers.push("أنت");
      if (player && !player.isConnected) secondary = "غير متصل — في مهلة إعادة الاتصال";
      if (player?.awaitingNextRound) secondary = "ينضم في الجولة القادمة";
    } else {
      if (entry.id === state.round.activeTeamId) markers.push("الدور الآن");
      if (entry.id === myTeamId) markers.push("فريقك");
      const members = state.players.filter((candidate) => candidate.teamId === entry.id);
      const connected = members.filter((candidate) => candidate.isConnected).length;
      secondary = `${connected}/${members.length} متصل`;
    }
    return {
      id: entry.id,
      name: entry.name,
      score: entry.score,
      rank: ranks.get(entry.id) ?? 0,
      connected: teamsMode ? true : (player?.isConnected ?? false),
      isMine: teamsMode ? entry.id === myTeamId : entry.id === state.playerId,
      isActiveTeam: teamsMode && entry.id === state.round.activeTeamId,
      markers,
      secondary,
    };
  });
  rows.sort((first, second) => {
    if (second.score !== first.score) return second.score - first.score;
    return (
      entries.findIndex((entry) => entry.id === first.id) -
      entries.findIndex((entry) => entry.id === second.id)
    );
  });
  return (
    <div className="scoreboard" role="table" aria-label="لوحة النتائج الكاملة">
      <div className="scoreboard-row scoreboard-header" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">{teamsMode ? "الفريق" : "اللاعب"}</span>
        <span role="columnheader">النقاط</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          role="row"
          data-entry-id={row.id}
          className={`scoreboard-row${row.isMine ? " is-mine" : ""}${row.isActiveTeam ? " is-active-team" : ""}${row.connected ? "" : " is-disconnected"}`}
        >
          <span role="cell" className="scoreboard-rank">
            {row.rank}
          </span>
          <span role="cell" className="scoreboard-name">
            <span className="scoreboard-name-line">
              <strong className="scoreboard-entry-name">{row.name}</strong>
              {row.markers.map((marker) => (
                <small key={marker} className="scoreboard-role">
                  {marker}
                </small>
              ))}
            </span>
            {row.secondary && <small className="scoreboard-secondary">{row.secondary}</small>}
          </span>
          <strong role="cell" className="scoreboard-score">
            {row.score}
          </strong>
        </div>
      ))}
      {rows.length === 0 && <p>لا يوجد لاعبون بعد.</p>}
    </div>
  );
}
