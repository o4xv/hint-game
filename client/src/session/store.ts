import type {
  FinalState,
  GameMode,
  IncomingEvent,
  PublicCard,
  PublicPack,
  PublicPlayer,
  PublicTeam,
  RatingVote,
  RedrawReason,
  RematchState,
  RevealData,
  RoundReadyState,
  ServerToClientEvents,
  TargetRedrawState,
  TimerPhase,
} from "@hint/contracts";

export type Screen =
  | "landing"
  | "home"
  | "lobby"
  | "game-player"
  | "game-psychic"
  | "reveal"
  | "winner"
  | "spectator"
  | "pending-join"
  | "waiting-next-round";
export interface RoundState {
  roundNumber: number;
  psychicId: string | null;
  card: PublicCard | null;
  clue: string | null;
  targetAngle: number | null;
  myAngle: number;
  hasSubmitted: boolean;
  timerEndsAt: number | null;
  timerPhase: TimerPhase | null;
  activeTeamId: string | null;
  controllerId: string | null;
  previewAngle: number | null;
  shouldPromptRating: boolean;
  redrawUsed: boolean;
  redrawAvailable: boolean;
  /**
   * Why the server withholds same-turn replacement. `null` while it is available or while
   * an older server sent no reason, so the UI can explain the state without guessing.
   */
  redrawReason: RedrawReason | null;
  /**
   * The current turn's answer-position allowance. An older server omits it, and the client
   * then reports the feature as unsupported instead of guessing why it is unavailable.
   */
  targetRedraw: TargetRedrawState;
}
export interface SessionState {
  playerId: string | null;
  displayName: string | null;
  roomCode: string | null;
  reconnectToken: string | null;
  joinCode: string | null;
  isOwner: boolean;
  isSpectator: boolean;
  awaitingNextRound: boolean;
  players: PublicPlayer[];
  winningScore: number;
  psychicTimerEnabled: boolean;
  roomLocked: boolean;
  selectedPackIds: string[];
  gameMode: GameMode;
  teamCount: number;
  teams: PublicTeam[];
  readyState: RoundReadyState;
  rematchState: RematchState;
  cardPacks: PublicPack[];
  ratedRoundNumbers: number[];
  ratingVotesByRound: Record<number, RatingVote>;
  pendingJoin: { roomCode: string; requestId: string } | null;
  joinError: string | null;
  pendingJoinRequests: { requestId: string; displayName: string }[];
  /** Last rejected action, so a form can explain the refusal inline. */
  /** `teamId` correlates a rename rejection with the team it belongs to. */
  actionError: {
    event: IncomingEvent;
    code: string;
    teamId?: string;
    /** Echoed by the server so a correlated action only reacts to its own rejection. */
    requestId?: string;
  } | null;
  /**
   * The last rename rejection per team, so a host editing two teams at once keeps each
   * answer on the card it belongs to. The newest rejection also stays in `actionError`.
   */
  renameErrors: Record<string, { code: string }>;
  currentScreen: Screen;
  phase: "waiting" | "playing" | "finished";
  connection: "connecting" | "connected" | "offline" | "recovering" | "waking" | "unavailable";
  round: RoundState;
  clueDraft: string;
  guessPending: boolean;
  revealData: RevealData | null;
  /** True only for a reveal that arrived live, so restored results open settled. */
  revealFresh: boolean;
  /** Totals as they stood before a live reveal, so the header can hold them until the score stage. */
  preRevealScores: { id: string; score: number }[] | null;
  /** Increments on every authoritative round snapshot (round start, reconnect, watch). */
  authoritativeRound: number;
  /**
   * Increments only when a live `target_redrawn` event was applied, so the dial animates a
   * confirmed move but never replays one that recovery restored.
   */
  targetMove: { roundNumber: number; revision: number; id: number } | null;
  finalState: FinalState | null;
  reaction: (Parameters<ServerToClientEvents["reaction_received"]>[0] & { id: number }) | null;
}

export const emptyReady = (): RoundReadyState => ({
  playerIds: [],
  readyCount: 0,
  requiredCount: 0,
  endsAt: null,
  paused: false,
  remainingMs: null,
});
/**
 * A server that predates the feature sends no metadata, and "unsupported" is a different
 * statement from "you have no uses left".
 */
export const unsupportedTargetRedraw = (): TargetRedrawState => ({
  supported: false,
  remaining: 0,
  usedThisRound: false,
  revision: 0,
});
export function normalizeTargetRedraw(value?: TargetRedrawState | null): TargetRedrawState {
  if (!value || typeof value !== "object") return unsupportedTargetRedraw();
  return {
    supported: value.supported,
    remaining: Number.isFinite(value.remaining) ? Math.max(0, Math.floor(value.remaining)) : 0,
    usedThisRound: value.usedThisRound,
    revision: Number.isFinite(value.revision) ? Math.max(0, Math.floor(value.revision)) : 0,
  };
}
const emptyRound = (): RoundState => ({
  roundNumber: 0,
  psychicId: null,
  card: null,
  clue: null,
  targetAngle: null,
  myAngle: 90,
  hasSubmitted: false,
  timerEndsAt: null,
  timerPhase: null,
  activeTeamId: null,
  controllerId: null,
  previewAngle: null,
  shouldPromptRating: false,
  redrawUsed: false,
  redrawAvailable: false,
  redrawReason: null,
  targetRedraw: unsupportedTargetRedraw(),
});
export function initialSession(): SessionState {
  return {
    playerId: null,
    displayName: null,
    roomCode: null,
    reconnectToken: null,
    joinCode: null,
    isOwner: false,
    isSpectator: false,
    awaitingNextRound: false,
    players: [],
    winningScore: 20,
    psychicTimerEnabled: false,
    roomLocked: false,
    selectedPackIds: ["core", "daily-life", "entertainment"],
    gameMode: "individual",
    teamCount: 2,
    teams: [],
    readyState: emptyReady(),
    rematchState: { playerIds: [], voteCount: 0, requiredCount: 0 },
    cardPacks: [],
    ratedRoundNumbers: [],
    ratingVotesByRound: {},
    pendingJoin: null,
    joinError: null,
    actionError: null,
    renameErrors: {},
    pendingJoinRequests: [],
    currentScreen: "landing",
    phase: "waiting",
    connection: "connecting",
    round: emptyRound(),
    clueDraft: "",
    guessPending: false,
    revealData: null,
    revealFresh: false,
    preRevealScores: null,
    authoritativeRound: 0,
    targetMove: null,
    finalState: null,
    reaction: null,
  };
}

export type ServerAction = {
  [Event in keyof ServerToClientEvents]: {
    type: "server";
    event: Event;
    data: CompatiblePayload<Event>;
  };
}[keyof ServerToClientEvents];
type CompatiblePayload<Event extends keyof ServerToClientEvents> = Event extends
  "watch_success" | "reconnect_success"
  ? Omit<Parameters<ServerToClientEvents[Event]>[0], "readyState"> & {
      readyState?: Partial<RoundReadyState>;
    }
  : Parameters<ServerToClientEvents[Event]>[0];
export type SessionAction =
  | ServerAction
  | { type: "navigate"; screen: Screen }
  | { type: "draft"; angle?: number; clue?: string }
  | { type: "guess-pending"; angle: number }
  | { type: "connection"; status: SessionState["connection"] }
  | {
      type: "identity";
      data: Partial<
        Pick<SessionState, "playerId" | "displayName" | "roomCode" | "reconnectToken" | "isOwner">
      >;
    }
  | { type: "clear-error" }
  | { type: "clear-rename-error"; teamId: string }
  | { type: "card-packs"; data: PublicPack[] }
  | { type: "reset" };

function playScreen(
  state: Pick<SessionState, "isSpectator" | "awaitingNextRound" | "playerId">,
  psychicId: string | null,
): Screen {
  if (state.isSpectator) return "spectator";
  if (state.awaitingNextRound) return "waiting-next-round";
  return state.playerId === psychicId ? "game-psychic" : "game-player";
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "card-packs":
      return { ...state, cardPacks: action.data };
    case "clear-error":
      return state.joinError === null && state.actionError === null
        ? state
        : { ...state, joinError: null, actionError: null };
    case "clear-rename-error": {
      if (!(action.teamId in state.renameErrors)) return state;
      const renameErrors = Object.fromEntries(
        Object.entries(state.renameErrors).filter(([teamId]) => teamId !== action.teamId),
      );
      return { ...state, renameErrors };
    }
    case "reset":
      return initialSession();
    case "navigate":
      return state.currentScreen === action.screen
        ? state
        : { ...state, currentScreen: action.screen };
    case "connection":
      return state.connection === action.status ? state : { ...state, connection: action.status };
    case "identity":
      return { ...state, ...action.data };
    case "draft":
      return {
        ...state,
        clueDraft: action.clue ?? state.clueDraft,
        round: action.angle === undefined ? state.round : { ...state.round, myAngle: action.angle },
      };
    case "guess-pending":
      if (state.round.hasSubmitted || state.guessPending) return state;
      return { ...state, guessPending: true, round: { ...state.round, myAngle: action.angle } };
    case "server":
      break;
  }
  switch (action.event) {
    case "reaction_received":
      return { ...state, reaction: { ...action.data, id: (state.reaction?.id ?? 0) + 1 } };
    case "join_request_resolved":
      return {
        ...state,
        pendingJoin: null,
        currentScreen: "home",
        joinError:
          action.data.reason === "rejected"
            ? "رفض صاحب الغرفة طلب الانضمام."
            : "انتهى طلب الانضمام. يمكنك المحاولة مجددًا.",
      };
    case "round_skipped":
      return {
        ...state,
        players: state.players.map((player) => ({
          ...player,
          score:
            action.data.updatedScores.find((score) => score.playerId === player.id)?.totalScore ??
            player.score,
        })),
        teams: action.data.updatedTeams,
      };
    case "action_error":
      return {
        ...state,
        actionError: {
          event: action.data.event,
          code: action.data.code,
          ...(action.data.teamId === undefined ? {} : { teamId: action.data.teamId }),
          ...(action.data.requestId === undefined ? {} : { requestId: action.data.requestId }),
        },
        // Every team keeps its own last rejection, so two open editors cannot swap answers.
        renameErrors:
          action.data.event === "rename_team" && action.data.teamId
            ? { ...state.renameErrors, [action.data.teamId]: { code: action.data.code } }
            : state.renameErrors,
        guessPending: action.data.event === "guess_submitted" ? false : state.guessPending,
        joinError:
          action.data.code === "ROOM_FULL"
            ? "الغرفة ممتلئة، تعذّر قبول الطلب."
            : action.data.code === "UPDATE_REQUIRED"
              ? "استُبدلت بطاقة هذه الجولة على جهاز آخر. حدّث الصفحة ثم أعد المحاولة."
              : action.data.code === "CARD_CONTEXT_REQUIRED"
                ? "تعذّر التحقق من بطاقة الجولة. حدّث الصفحة ثم أعد المحاولة."
                : action.data.code === "STALE_CARD"
                  ? "تغيّرت بطاقة الجولة. راجع التلميح الحالي ثم أعد المحاولة."
                  : "تعذّر تنفيذ الطلب. تحقق من حالة الجولة وحاول مجددًا.",
      };
    case "player_joined":
    case "player_removed":
      return {
        ...state,
        players: action.data.players,
        round: {
          ...state.round,
          redrawAvailable: action.data.redrawAvailable,
          redrawReason: action.data.redrawReason ?? null,
        },
      };
    case "card_redrawn":
      // Only a replacement of the card this client still holds, before any accepted clue,
      // may be applied. A replayed or obsolete event leaves accepted state untouched.
      if (action.data.roundNumber !== state.round.roundNumber) return state;
      if (action.data.previousCardId !== state.round.card?.id) return state;
      if (state.round.clue || state.round.hasSubmitted) return state;
      if (action.data.card.id === state.round.card.id) return state;
      return {
        ...state,
        round: {
          ...state.round,
          card: action.data.card,
          redrawUsed: action.data.redrawUsed,
          clue: null,
          previewAngle: null,
          // The practice dial belonged to the discarded card, so it resets like recovery does.
          myAngle: 90,
        },
        clueDraft: "",
      };
    case "player_disconnected":
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.data.playerId ? { ...player, isConnected: false } : player,
        ),
      };
    case "ownership_transferred":
      return { ...state, isOwner: state.playerId === action.data.ownerId };
    case "settings_updated":
      return { ...state, ...action.data, actionError: null };
    case "join_pending":
      return { ...state, pendingJoin: action.data, currentScreen: "pending-join" };
    case "join_error":
    case "game_start_error":
    case "watch_error":
      return { ...state, joinError: action.data.message };
    case "join_request":
      return state.pendingJoinRequests.some(
        (request) => request.requestId === action.data.requestId,
      )
        ? state
        : { ...state, pendingJoinRequests: [...state.pendingJoinRequests, action.data] };
    case "join_request_removed":
      return {
        ...state,
        pendingJoinRequests: state.pendingJoinRequests.filter(
          (request) => request.requestId !== action.data.requestId,
        ),
      };
    case "room_closed":
    case "session_replaced":
    case "kicked_from_room":
      return { ...initialSession(), currentScreen: "home", connection: state.connection };
    case "room_created": {
      const data = action.data;
      return {
        ...state,
        ...data,
        phase: "waiting",
        currentScreen: "lobby",
        isOwner: true,
        isSpectator: false,
        players: [
          {
            id: data.playerId,
            displayName: state.displayName ?? "",
            score: 0,
            isConnected: true,
            hasSubmitted: false,
            awaitingNextRound: false,
            teamId: null,
          },
        ],
      };
    }
    case "join_success":
      return {
        ...state,
        ...action.data,
        pendingJoin: null,
        joinError: null,
        isSpectator: false,
        awaitingNextRound: action.data.joinMode === "next_round",
        currentScreen: action.data.joinMode === "next_round" ? "waiting-next-round" : "lobby",
      };
    case "game_started":
    case "rematch_started":
      return {
        ...state,
        ...action.data,
        phase: action.event === "game_started" ? "playing" : "waiting",
        currentScreen: state.isSpectator
          ? "spectator"
          : action.event === "game_started"
            ? "game-player"
            : "lobby",
        round: emptyRound(),
        readyState: emptyReady(),
        rematchState: { playerIds: [], voteCount: 0, requiredCount: 0 },
        clueDraft: "",
        guessPending: false,
        revealData: null,
        revealFresh: false,
        preRevealScores: null,
        finalState: null,
        ratedRoundNumbers: [],
        ratingVotesByRound: {},
        awaitingNextRound: false,
      };
    case "round_start": {
      const data = action.data;
      if (data.roundNumber <= state.round.roundNumber) return state;
      return {
        ...state,
        phase: "playing",
        players: data.players,
        gameMode: data.gameMode,
        teamCount: data.teamCount,
        teams: data.teams,
        round: {
          ...emptyRound(),
          roundNumber: data.roundNumber,
          psychicId: data.psychicId,
          card: data.card,
          activeTeamId: data.activeTeamId,
          controllerId: data.controllerId,
          redrawUsed: data.redrawUsed,
          redrawAvailable: data.redrawAvailable,
          redrawReason: data.redrawReason ?? null,
          targetRedraw: normalizeTargetRedraw(data.targetRedraw),
        },
        authoritativeRound: state.authoritativeRound + 1,
        targetMove: null,
        readyState: emptyReady(),
        clueDraft: "",
        guessPending: false,
        revealData: null,
        revealFresh: false,
        preRevealScores: null,
        awaitingNextRound: false,
        currentScreen: playScreen({ ...state, awaitingNextRound: false }, data.psychicId),
      };
    }
    case "target_reveal": {
      if (state.playerId !== state.round.psychicId || state.isSpectator) return state;
      const suppliedRevision = action.data.targetRevision;
      const revision = state.round.targetRedraw.revision;
      // Context-bearing events are only applied to the turn they belong to, so a delayed
      // initial target can never overwrite a position the player already changed.
      if (
        action.data.roundNumber !== undefined &&
        action.data.roundNumber !== state.round.roundNumber
      )
        return state;
      if (action.data.cardId !== undefined && action.data.cardId !== state.round.card?.id)
        return state;
      if (suppliedRevision !== undefined && suppliedRevision !== revision) return state;
      if (suppliedRevision === undefined && revision > 0) return state;
      if (suppliedRevision === undefined && state.round.targetAngle !== null) return state;
      return { ...state, round: { ...state.round, targetAngle: action.data.targetAngle } };
    }
    case "target_redrawn": {
      // Only the clue giver of this exact turn may apply the change, and only while the clue
      // is still unsent. A duplicate or obsolete acknowledgement leaves newer state alone.
      if (state.isSpectator || state.playerId !== state.round.psychicId) return state;
      if (action.data.roundNumber !== state.round.roundNumber) return state;
      if (action.data.cardId !== state.round.card?.id) return state;
      if (state.round.clue || state.round.hasSubmitted) return state;
      if (action.data.previousTargetRevision !== state.round.targetRedraw.revision) return state;
      const targetRedraw = normalizeTargetRedraw(action.data.targetRedraw);
      if (targetRedraw.revision !== action.data.previousTargetRevision + 1) return state;
      return {
        ...state,
        round: { ...state.round, targetAngle: action.data.targetAngle, targetRedraw },
        // The clue was written for the old position, so it is only cleared on real success.
        clueDraft: "",
        targetMove: {
          roundNumber: action.data.roundNumber,
          revision: targetRedraw.revision,
          id: (state.targetMove?.id ?? 0) + 1,
        },
      };
    }
    case "clue_broadcast":
      return { ...state, round: { ...state.round, clue: action.data.clue } };
    case "timer_start":
      return action.data.roundNumber !== state.round.roundNumber
        ? state
        : {
            ...state,
            round: {
              ...state.round,
              timerEndsAt: action.data.endsAt,
              timerPhase: action.data.phase,
            },
          };
    case "guess_accepted":
      return action.data.roundNumber !== state.round.roundNumber
        ? state
        : {
            ...state,
            guessPending: false,
            round: { ...state.round, hasSubmitted: true, myAngle: action.data.angle },
          };
    case "guess_rejected":
      return action.data.roundNumber !== null && action.data.roundNumber !== state.round.roundNumber
        ? state
        : { ...state, guessPending: false };
    case "player_guessed":
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.data.playerId ? { ...player, hasSubmitted: true } : player,
        ),
      };
    case "team_guess_preview":
      return action.data.roundNumber !== state.round.roundNumber
        ? state
        : { ...state, round: { ...state.round, previewAngle: action.data.angle } };
    case "round_ready_updated":
      return { ...state, readyState: { ...emptyReady(), ...action.data } };
    case "rematch_vote_updated":
      return { ...state, rematchState: action.data };
    case "card_rating_recorded":
      return {
        ...state,
        ratedRoundNumbers: [...new Set([...state.ratedRoundNumbers, state.round.roundNumber])],
        ratingVotesByRound: {
          ...state.ratingVotesByRound,
          [state.round.roundNumber]: action.data.vote,
        },
      };
    case "reveal_phase": {
      const data = action.data;
      const finished = data.winners.length > 0 || data.winner !== null;
      /**
       * Only the first result the client sees for this turn is a live reveal. A delivery that
       * arrives after recovery, or a duplicate of one already shown, stays settled: it must not
       * replay the sequence, recapture the pre-reveal totals from the scored state, overwrite
       * newer readiness or pull someone back from the final results.
       */
      const firstDelivery = state.revealData === null;
      // Capture the totals as they were before this reveal so the header can keep showing
      // them until the score stage instead of blanking out.
      const previous = firstDelivery
        ? [
            ...state.players.map((player) => ({ id: player.id, score: player.score })),
            ...state.teams.map((team) => ({ id: team.id, score: team.score })),
          ]
        : state.preRevealScores;
      return {
        ...state,
        revealData: data,
        revealFresh: state.revealFresh || firstDelivery,
        preRevealScores: previous,
        phase: finished ? "finished" : "playing",
        guessPending: false,
        readyState: finished
          ? emptyReady()
          : firstDelivery
            ? { ...emptyReady(), ...data.readyState }
            : state.readyState,
        players: state.players.map((player) => ({
          ...player,
          score:
            data.updatedScores.find((score) => score.playerId === player.id)?.totalScore ??
            player.score,
        })),
        teams: data.updatedTeams,
        currentScreen: !firstDelivery
          ? state.currentScreen
          : state.isSpectator
            ? "spectator"
            : state.awaitingNextRound
              ? finished
                ? "winner"
                : "waiting-next-round"
              : "reveal",
        round: {
          ...state.round,
          timerEndsAt: null,
          timerPhase: null,
          shouldPromptRating: data.shouldPromptRating,
        },
      };
    }
    case "game_over":
      return {
        ...state,
        phase: "finished",
        finalState: action.data,
        readyState: emptyReady(),
        currentScreen: state.isSpectator
          ? "spectator"
          : state.currentScreen === "reveal" && !("reason" in action.data)
            ? "reveal"
            : "winner",
      };
    case "reconnect_success": {
      const data = action.data;
      const snapshot = data.currentRound;
      const sameRound =
        data.roomCode === state.roomCode && snapshot?.roundNumber === state.round.roundNumber;
      // A missed replacement means the same round now holds a different card, so the
      // draft and pre-clue dial state belong to a card the turn no longer uses.
      const recoveredCardId = snapshot ? (snapshot.card?.id ?? null) : null;
      const sameCard = sameRound && recoveredCardId === (state.round.card?.id ?? null);
      // A moved answer invalidates a draft even when the card is unchanged: the clue was
      // written for a position the round no longer holds.
      const recoveredRevision = snapshot
        ? normalizeTargetRedraw(snapshot.targetRedraw).revision
        : 0;
      const samePosition = sameCard && recoveredRevision === state.round.targetRedraw.revision;
      const identity = {
        playerId: data.playerId,
        isSpectator: false,
        awaitingNextRound: data.awaitingNextRound,
      };
      let currentScreen: Screen =
        data.status === "waiting"
          ? "lobby"
          : data.status === "finished"
            ? "winner"
            : data.awaitingNextRound
              ? "waiting-next-round"
              : snapshot?.status === "revealed"
                ? "reveal"
                : playScreen(identity, snapshot?.psychicId ?? null);
      if (data.status === "finished" && sameRound && state.currentScreen === "reveal")
        currentScreen = "reveal";
      const round: RoundState = snapshot
        ? {
            ...emptyRound(),
            roundNumber: snapshot.roundNumber,
            psychicId: snapshot.psychicId,
            card: snapshot.card,
            clue: snapshot.clue,
            activeTeamId: snapshot.activeTeamId,
            controllerId: snapshot.controllerId,
            targetAngle:
              snapshot.psychicId === data.playerId ? (snapshot.psychicTargetAngle ?? null) : null,
            myAngle: snapshot.myGuessAngle ?? (sameCard ? state.round.myAngle : 90),
            hasSubmitted: snapshot.hasSubmitted,
            timerEndsAt: snapshot.timerEndsAt,
            timerPhase: snapshot.timerPhase,
            shouldPromptRating: snapshot.shouldPromptRating,
            redrawUsed: snapshot.redrawUsed,
            redrawAvailable: snapshot.redrawAvailable,
            redrawReason: snapshot.redrawReason ?? null,
            targetRedraw: normalizeTargetRedraw(snapshot.targetRedraw),
          }
        : emptyRound();
      const ratingVotesByRound = sameRound ? { ...state.ratingVotesByRound } : {};
      if (snapshot?.myRatingVote) ratingVotesByRound[snapshot.roundNumber] = snapshot.myRatingVote;
      return {
        ...state,
        ...identity,
        roomCode: data.roomCode,
        displayName: data.displayName,
        isOwner: data.isOwner,
        players: data.players,
        winningScore: data.winningScore,
        psychicTimerEnabled: data.psychicTimerEnabled,
        roomLocked: data.roomLocked,
        selectedPackIds: data.selectedPackIds,
        gameMode: data.gameMode,
        teamCount: data.teamCount,
        teams: data.teams,
        phase: data.status,
        connection: "connected",
        currentScreen,
        readyState:
          data.status === "finished" ? emptyReady() : { ...emptyReady(), ...data.readyState },
        rematchState: data.rematchState,
        finalState: data.finalState,
        revealData: snapshot?.revealData ?? null,
        revealFresh: false,
        authoritativeRound: state.authoritativeRound + 1,
        round,
        clueDraft: samePosition ? state.clueDraft : "",
        guessPending: false,
        targetMove: null,
        pendingJoin: null,
        joinError: null,
        ratingVotesByRound,
        ratedRoundNumbers: Object.keys(ratingVotesByRound).map(Number),
      };
    }
    case "watch_success": {
      const data = action.data;
      const snapshot = data.currentRound;
      return {
        ...state,
        roomCode: data.roomCode,
        players: data.players,
        winningScore: data.winningScore,
        gameMode: data.gameMode,
        teamCount: data.teamCount,
        teams: data.teams,
        phase: data.status,
        isSpectator: true,
        isOwner: false,
        playerId: null,
        reconnectToken: null,
        currentScreen: "spectator",
        readyState: { ...emptyReady(), ...data.readyState },
        finalState: data.finalState,
        round: snapshot
          ? {
              ...emptyRound(),
              roundNumber: snapshot.roundNumber,
              psychicId: snapshot.psychicId,
              card: snapshot.card,
              clue: snapshot.clue,
              activeTeamId: snapshot.activeTeamId,
              controllerId: snapshot.controllerId,
              previewAngle: snapshot.previewAngle,
              redrawUsed: snapshot.redrawUsed,
              redrawAvailable: snapshot.redrawAvailable,
              redrawReason: snapshot.redrawReason ?? null,
              targetRedraw: normalizeTargetRedraw(snapshot.targetRedraw),
            }
          : emptyRound(),
        revealData: snapshot?.revealData ?? null,
        revealFresh: false,
        authoritativeRound: state.authoritativeRound + 1,
        targetMove: null,
        clueDraft: "",
        guessPending: false,
      };
    }
    default:
      return state;
  }
}

export function createSessionStore(initial: SessionState = initialSession()) {
  let snapshot = initial;
  const listeners = new Set<(action: SessionAction) => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: (action: SessionAction) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action: SessionAction) {
      const next = sessionReducer(snapshot, action);
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of [...listeners]) listener(action);
    },
  };
}
