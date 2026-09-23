// This entry point deliberately contains no runtime schema dependency.
export const SCORING = Object.freeze({ BULLSEYE: 6, MIDDLE: 16, OUTER: 24 });

/**
 * Points for one guess, measured in degrees from the target. The server scores rounds with
 * this function and the in-app practice round shows the same bands, so the explanation can
 * never drift from real play.
 */
export function pointsForGuess(guessAngle: number, targetAngle: number): 0 | 1 | 2 | 3 {
  const difference = Math.abs(guessAngle - targetAngle);
  if (difference <= SCORING.BULLSEYE) return 3;
  if (difference <= SCORING.MIDDLE) return 2;
  if (difference <= SCORING.OUTER) return 1;
  return 0;
}
export const WINNING_SCORES = [10, 20, 30, 40] as const;
export const GAME_MODES = ["individual", "teams"] as const;
/** Seats per room, shared by admission, reservations, snapshots and the lobby. */
export const MAX_PLAYERS = 12;
/**
 * Answer-position changes a player (individual) or a team (team mode) may spend across one
 * match. Server-authoritative; the client only renders what the server reports.
 */
export const TARGET_REDRAWS_PER_MATCH = 3;
/** Team names are trimmed to this many Unicode code points. */
export const TEAM_NAME_MAX_LENGTH = 24;
export type TeamNameIssue = "blank" | "invalid" | "too_long" | "duplicate";
/**
 * One implementation of the team-name rule for the server and for inline client
 * feedback, so a rejected save and an inline warning can never disagree.
 */
export function checkTeamName(
  raw: unknown,
  otherNames: readonly string[] = [],
): { ok: true; name: string } | { ok: false; issue: TeamNameIssue } {
  if (typeof raw !== "string") return { ok: false, issue: "invalid" };
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, issue: "blank" };
  const characters = Array.from(name);
  const invalid = characters.some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || character === "<" || character === ">";
  });
  if (invalid) return { ok: false, issue: "invalid" };
  if (characters.length > TEAM_NAME_MAX_LENGTH) return { ok: false, issue: "too_long" };
  const folded = name.toLocaleLowerCase();
  const duplicate = otherNames.some(
    (other) => other.trim().replace(/\s+/g, " ").toLocaleLowerCase() === folded,
  );
  if (duplicate) return { ok: false, issue: "duplicate" };
  return { ok: true, name };
}
export const REACTIONS = ["👍", "😂", "😱", "🔥", "🎯", "👏"] as const;
export const DEFAULT_PACK_IDS = ["core", "daily-life", "entertainment"] as const;
export type GameMode = (typeof GAME_MODES)[number];
export type WinningScore = (typeof WINNING_SCORES)[number];
export type Reaction = (typeof REACTIONS)[number];
export type RatingVote = "up" | "down";
/**
 * Server-derived reason a same-turn card change is unavailable. Older servers omit the
 * field entirely, and the client then explains the state in general terms instead of
 * guessing which participant blocks it.
 */
export type RedrawReason = "incompatible" | "disconnected";
/**
 * The current turn's answer-position allowance, as the server sees it. It never carries a
 * target angle: older servers omit the whole object and the client shows the unsupported
 * explanation instead of guessing.
 */
export interface TargetRedrawState {
  supported: boolean;
  remaining: number;
  usedThisRound: boolean;
  revision: number;
}
export type RoomStatus = "waiting" | "playing" | "finished";
export type RoundStatus = "waiting" | "guessing" | "revealed";
export type TimerPhase = "psychic" | "guessing" | "round-ready";

/** Public roster entries never carry socket IDs or reconnect credentials. */
export interface PublicPlayer {
  id: string;
  displayName: string;
  score: number;
  isConnected: boolean;
  hasSubmitted: boolean;
  awaitingNextRound: boolean;
  teamId: string | null;
}
export interface PublicTeam {
  id: string;
  name: string;
  color: string;
  score: number;
}
export interface PublicCard {
  id: string;
  packId: string;
  left: string;
  right: string;
}
export interface PublicPack {
  id: string;
  name: string;
  description: string;
  familySafe: boolean;
  defaultEnabled: boolean;
  cardCount: number;
}
export interface PublicRoomMode {
  gameMode: GameMode;
  teamCount: number;
  teams: PublicTeam[];
}
export interface ScoreEntry {
  playerId: string;
  displayName: string;
  totalScore: number;
}
export type Winner =
  | { playerId: string; teamId?: never; displayName: string; score: number }
  | { teamId: string; playerId?: never; displayName: string; score: number };
export interface Award {
  type: "closest_guess" | "largest_miss" | "best_guessing_average" | "best_psychic_average";
  title: string;
  playerIds: string[];
  value: number | null;
  players: { playerId: string; displayName: string }[];
}
export interface GuessResult {
  playerId: string | null;
  teamId?: string | null;
  displayName: string;
  angle: number | null;
  points: number;
}
export interface PsychicBreakdown {
  averagePoints: number;
  twoPlayerBonus: number;
  bullseyeBonus: number;
  allMissPenalty: boolean;
}
export interface RoundReadyState {
  playerIds: string[];
  readyCount: number;
  requiredCount: number;
  endsAt: number | null;
  paused: boolean;
  remainingMs: number | null;
}
export interface RematchState {
  playerIds: string[];
  voteCount: number;
  requiredCount: number;
}
export interface RevealData {
  targetAngle: number;
  guesses: GuessResult[];
  psychicPoints: number | null;
  psychicBreakdown: PsychicBreakdown | null;
  updatedScores: ScoreEntry[];
  updatedTeams: PublicTeam[];
  gameMode: GameMode;
  activeTeamId: string | null;
  shouldPromptRating: boolean;
  winner: Winner | null;
  winners: Winner[];
  readyState?: RoundReadyState;
  awards?: Award[];
  matchRoundCount?: number;
}
export interface CompletedMatch extends RevealData {
  awards: Award[];
  matchRoundCount: number;
}
export interface AbandonedMatch {
  winner: null;
  winners: Winner[];
  gameMode: GameMode;
  updatedTeams: PublicTeam[];
  leaderboard: ScoreEntry[];
  awards: Award[];
  reason: string;
}
export type FinalState = CompletedMatch | AbandonedMatch;

export interface RoundStartPayload extends PublicRoomMode {
  roundNumber: number;
  psychicId: string;
  card: PublicCard;
  players: PublicPlayer[];
  activeTeamId: string | null;
  controllerId: string | null;
  redrawUsed: boolean;
  /** False while any live participant cannot understand a same-turn replacement. */
  redrawAvailable: boolean;
  /** Why replacement is unavailable, when the server can name the blocker. */
  redrawReason?: RedrawReason | null;
  /** The current turn's answer-position allowance; omitted by servers that predate it. */
  targetRedraw?: TargetRedrawState;
}
interface RoundSnapshotBase {
  roundNumber: number;
  psychicId: string | null;
  card: PublicCard | null;
  clue: string | null;
  status: RoundStatus;
  activeTeamId: string | null;
  controllerId: string | null;
  revealData: RevealData | null;
  redrawUsed: boolean;
  redrawAvailable: boolean;
  redrawReason?: RedrawReason | null;
  targetRedraw?: TargetRedrawState;
}
interface MemberRoundSnapshot extends RoundSnapshotBase {
  timerEndsAt: number | null;
  timerPhase: TimerPhase | null;
  hasSubmitted: boolean;
  hasRated: boolean;
  myRatingVote: RatingVote | null;
  shouldPromptRating: boolean;
  myGuessAngle: number | null;
}
export interface ParticipantRoundSnapshot extends MemberRoundSnapshot {
  psychicTargetAngle?: never;
}
/** Sent only to the authenticated psychic's socket. */
export interface PsychicRoundSnapshot extends MemberRoundSnapshot {
  psychicTargetAngle: number | null;
}
export interface SpectatorRoundSnapshot extends RoundSnapshotBase {
  previewAngle: number | null;
  psychicTargetAngle?: never;
}
export interface ReconnectSnapshot extends PublicRoomMode {
  roomCode: string;
  status: RoomStatus;
  redrawAvailable: boolean;
  winningScore: number;
  psychicTimerEnabled: boolean;
  roomLocked: boolean;
  selectedPackIds: string[];
  readyState: RoundReadyState;
  rematchState: RematchState;
  awaitingNextRound: boolean;
  players: PublicPlayer[];
  currentRound: ParticipantRoundSnapshot | PsychicRoundSnapshot | null;
  finalState: FinalState | null;
}
export interface ReconnectSuccessPayload extends ReconnectSnapshot {
  playerId: string;
  displayName: string;
  isOwner: boolean;
}
export interface WatchSuccessPayload extends PublicRoomMode {
  roomCode: string;
  status: RoomStatus;
  redrawAvailable: boolean;
  winningScore: number;
  players: PublicPlayer[];
  currentRound: SpectatorRoundSnapshot | null;
  readyState: RoundReadyState;
  finalState: FinalState | null;
}
export interface RoomCreatedPayload extends PublicRoomMode {
  roomCode: string;
  playerId: string;
  reconnectToken: string;
  selectedPackIds: string[];
}
export interface JoinSuccessPayload extends RoomCreatedPayload {
  players: PublicPlayer[];
  winningScore: number;
  psychicTimerEnabled: boolean;
  roomLocked: boolean;
  isOwner: boolean;
  joinMode?: "next_round";
}
export interface MatchStartedPayload extends PublicRoomMode {
  players: PublicPlayer[];
  winningScore: number;
  selectedPackIds: string[];
}
export interface SettingsUpdatedPayload extends Partial<PublicRoomMode> {
  winningScore?: number;
  psychicTimerEnabled?: boolean;
  roomLocked?: boolean;
  selectedPackIds?: string[];
  players?: PublicPlayer[];
}
export interface RoomCodePayload {
  roomCode: string;
}
/** Optional for legacy clients; supplied by current clients to reject stale actions. */
export interface RoundActionPayload extends RoomCodePayload {
  roundNumber?: number;
}
export interface IncomingPayloads {
  create_room: {
    displayName: string;
    winningScore?: number | string | null;
    selectedPackIds?: string[];
  };
  join_room: RoomCodePayload & { displayName: string };
  reconnect_player: RoomCodePayload & { reconnectToken: string };
  leave_room: RoomCodePayload;
  cancel_join_request: RoomCodePayload & { requestId: string };
  update_settings: RoomCodePayload & { winningScore: number | string };
  update_packs: RoomCodePayload & { selectedPackIds: string[] };
  update_game_mode: RoomCodePayload & { gameMode: GameMode };
  update_team_count: RoomCodePayload & { teamCount: number | string };
  assign_team: RoomCodePayload & { playerId: string; teamId: string };
  rename_team: RoomCodePayload & { teamId: string; name: string };
  toggle_psychic_timer: RoomCodePayload;
  set_room_lock: RoomCodePayload & { locked: boolean };
  approve_join_request: RoomCodePayload & { requestId: string };
  reject_join_request: RoomCodePayload & { requestId: string };
  transfer_ownership: RoomCodePayload & { playerId: string };
  kick_player: RoomCodePayload & { playerId: string };
  start_game: RoomCodePayload;
  watch_room: RoomCodePayload;
  clue_submitted: RoundActionPayload & { clue: string; cardId?: string; targetRevision?: number };
  skip_round: RoundActionPayload & { cardId?: string };
  redraw_card: RoundActionPayload & { cardId: string };
  redraw_target: RoundActionPayload & {
    roundNumber: number;
    cardId: string;
    targetRevision: number;
    requestId: string;
  };
  guess_submitted: RoundActionPayload & { angle: number | string; cardId?: string };
  guess_preview: RoomCodePayload & {
    angle: number | string;
    roundNumber: number | string;
    cardId?: string;
  };
  next_round: RoundActionPayload;
  round_ready: RoundActionPayload & { ready?: boolean };
  set_round_pause: RoomCodePayload & { roundNumber: number | string; paused: boolean };
  card_rating: RoundActionPayload & { vote: RatingVote };
  send_reaction: RoundActionPayload & { reaction: Reaction };
  vote_rematch: RoomCodePayload & { vote?: boolean };
  rematch: RoomCodePayload;
}
export type ClientToServerEvents = {
  [K in keyof IncomingPayloads]: (payload: IncomingPayloads[K]) => void;
};
export type IncomingEvent = keyof ClientToServerEvents;
export interface ServerToClientEvents {
  room_created: (payload: RoomCreatedPayload) => void;
  join_success: (payload: JoinSuccessPayload) => void;
  join_error: (payload: { message: string; code?: string }) => void;
  join_pending: (payload: { roomCode: string; requestId: string }) => void;
  reconnect_success: (payload: ReconnectSuccessPayload) => void;
  watch_success: (payload: WatchSuccessPayload) => void;
  watch_error: (payload: { message: string }) => void;
  session_replaced: () => void;
  room_closed: () => void;
  join_request: (payload: { requestId: string; displayName: string }) => void;
  join_request_removed: (payload: { requestId: string }) => void;
  join_request_resolved: (payload: {
    reason: "cancelled" | "expired" | "rejected" | "game_finished";
  }) => void;
  player_joined: (payload: {
    players: PublicPlayer[];
    redrawAvailable: boolean;
    redrawReason?: RedrawReason | null;
  }) => void;
  player_removed: (payload: {
    playerId: string;
    displayName: string;
    players: PublicPlayer[];
    redrawAvailable: boolean;
    redrawReason?: RedrawReason | null;
  }) => void;
  player_disconnected: (payload: {
    playerId: string;
    displayName: string;
    wasPsychic: boolean;
  }) => void;
  ownership_transferred: (payload: { ownerId: string }) => void;
  kicked_from_room: (payload: { message: string }) => void;
  settings_updated: (payload: SettingsUpdatedPayload) => void;
  game_start_error: (payload: {
    message: string;
    reason: "team_min_players" | "team_needs_two" | "not_enough_players";
  }) => void;
  game_started: (payload: MatchStartedPayload) => void;
  rematch_started: (payload: MatchStartedPayload) => void;
  round_start: (payload: RoundStartPayload) => void;
  target_reveal: (payload: {
    targetAngle: number;
    /** Context supplied by upgraded servers so a delayed initial target cannot overwrite a change. */
    roundNumber?: number;
    cardId?: string;
    targetRevision?: number;
  }) => void;
  clue_broadcast: (payload: { clue: string; psychicName: string }) => void;
  timer_start: (payload: {
    endsAt: number;
    phase: "psychic" | "guessing";
    roundNumber: number;
  }) => void;
  guess_accepted: (payload: { roundNumber: number; angle: number }) => void;
  guess_rejected: (payload: { roundNumber: number | null; reason: string }) => void;
  card_redrawn: (payload: {
    roundNumber: number;
    previousCardId: string;
    card: PublicCard;
    redrawUsed: true;
  }) => void;
  /** Private acknowledgement to the clue giver; the new angle and counters arrive together. */
  target_redrawn: (payload: {
    requestId: string;
    roundNumber: number;
    cardId: string;
    previousTargetRevision: number;
    targetAngle: number;
    targetRedraw: TargetRedrawState;
  }) => void;
  player_guessed: (payload: {
    playerId: string;
    teamId?: string | null;
    allSubmitted: boolean;
  }) => void;
  team_guess_preview: (payload: {
    angle: number;
    roundNumber: number;
    activeTeamId: string | null;
    controllerId: string | null;
  }) => void;
  round_skipped: (payload: {
    psychicName: string;
    penalty: number;
    updatedScores: ScoreEntry[];
    updatedTeams: PublicTeam[];
    gameMode: GameMode;
    source: "skip" | "timeout";
  }) => void;
  reveal_phase: (payload: RevealData) => void;
  game_over: (payload: FinalState) => void;
  round_ready_updated: (payload: RoundReadyState) => void;
  card_rating_recorded: (payload: { vote: RatingVote }) => void;
  reaction_received: (payload: { playerId: string; reaction: Reaction }) => void;
  rematch_vote_updated: (payload: RematchState) => void;
  action_error: (payload: {
    event: IncomingEvent;
    code: string;
    /**
     * The team a rename rejection belongs to. Servers that predate this field omit it, and
     * the client then only shows the error on the editor that is waiting for an answer.
     */
    teamId?: string;
    /** Echoed for correlated actions such as a target change. */
    requestId?: string;
  }) => void;
}
