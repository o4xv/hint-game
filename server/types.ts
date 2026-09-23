import type { Server, Socket } from "socket.io";
import type {
  Award,
  FinalState,
  GameMode,
  GuessResult,
  IncomingEvent,
  PublicCard,
  PublicPlayer,
  PublicTeam,
  RatingVote,
  RevealData,
  RoomStatus,
  RoundStatus,
  ServerToClientEvents,
} from "@hint/contracts";
export type RawIncomingEvents = Record<IncomingEvent, (payload: unknown) => void>;
export interface SocketData {
  watchingRoomCode?: string;
}
export type GameIO = Server<
  RawIncomingEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
export type GameSocket = Socket<
  RawIncomingEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
export type TimeoutHandle = ReturnType<typeof setTimeout>;
export interface Player extends PublicPlayer {
  socketId: string | null;
  reconnectToken: string;
  disconnectTimeout: TimeoutHandle | null;
}
export interface JoinRequest {
  id: string;
  socketId: string;
  displayName: string;
  requestedAt: number;
  timeout: TimeoutHandle | null;
}
export interface Card extends PublicCard {
  editorial?: { anchors: string[]; suitability: number[] };
}
export interface Round {
  roundNumber: number;
  psychicId: string | null;
  card: PublicCard | null;
  targetAngle: number | null;
  clue: string | null;
  status: RoundStatus;
  guesses: { playerId: string; angle: number; points: number }[];
  usedCardIds: string[];
  psychicOrder: string[];
  psychicIndex: number;
  pausedPsychicTimerRemaining: number | null;
  revealData: RevealData | null;
  ratings: { playerId: string; vote: RatingVote; targetRegion: string }[];
  activeTeamId: string | null;
  controllerId: string | null;
  previewAngle: number | null;
  shouldPromptRating: boolean;
  /** One free card replacement per turn; older snapshots default it to false. */
  redrawUsed: boolean;
  /**
   * Increments once when the answer position changes. It is the round's single source of
   * truth for "this turn already moved the target"; do not add a separate boolean.
   */
  targetRevision: number;
}
export interface HistoryRound {
  roundNumber: number;
  psychicId: string | null;
  psychicPoints: number | null;
  guesses: { playerId: string; angle?: number; points?: number; distance: number }[];
  cardId?: string;
  packId?: string;
  gameMode?: GameMode;
  teamId?: string | null;
  controllerId?: string | null;
}
export type TimerKind = "guess" | "psychic" | "round-ready";
export interface TimerDescriptor {
  kind: TimerKind;
  endsAt: number;
}
export interface Room {
  code: string;
  ownerId: string;
  status: RoomStatus;
  winningScore: number;
  psychicTimerEnabled: boolean;
  roomLocked: boolean;
  snapshotVersion: number;
  selectedPackIds: string[];
  gameMode: GameMode;
  teamCount: number;
  teams: PublicTeam[];
  teamTurnIndex: number;
  teamPsychicIndexes: Record<string, number>;
  teamControllerIndexes: Record<string, number>;
  roundReadyPlayerIds: string[];
  roundAdvanceEndsAt: number | null;
  roundAdvancePausedRemainingMs: number | null;
  rematchVoteIds: string[];
  lastActivity: number;
  matchStartedAt: number | null;
  roundStartedAt: number | null;
  joinRequests: JoinRequest[];
  players: Player[];
  currentRound: Round;
  /** Answer-position changes spent per player across the match (individual mode). */
  targetRedrawsUsedByPlayer: Record<string, number>;
  /** Answer-position changes spent per team across the match (team mode). */
  targetRedrawsUsedByTeam: Record<string, number>;
  timer: TimeoutHandle | null;
  timerEndsAt: number | null;
  timerDescriptor: TimerDescriptor | null;
  recoveryPending: boolean;
  recoveryTimeout: TimeoutHandle | null;
  matchHistory: HistoryRound[];
  finalState: FinalState | null;
}
export interface PersistenceAdapter {
  save(room: Room): Promise<void> | void;
  remove(code: string): Promise<void> | void;
}
export type { Award, GuessResult };
