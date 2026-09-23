import { z } from "zod";
import { GAME_MODES, REACTIONS, WINNING_SCORES } from "./index.js";
import type { IncomingEvent } from "./index.js";

// Bound before trimming/coercion, so even valid-looking oversized input is rejected.
const roomCode = z
  .string()
  .max(32)
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/);
const identifier = z.string().min(1).max(128);
const text = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !/[<>]/.test(value) &&
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127 && character.trim().length > 0;
      }),
  );
const numeric = z
  .union([
    z.number(),
    z
      .string()
      .min(1)
      .max(32)
      .refine((value) => value.trim().length > 0)
      .transform(Number),
  ])
  .pipe(z.number());
const winningScore = numeric.pipe(z.union(WINNING_SCORES.map((value) => z.literal(value))));
const angle = numeric.pipe(z.number().min(0).max(180));
const roundNumber = numeric.pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));
/** Monotonic per-round target revision; only the current turn's single change is allowed. */
const targetRevision = numeric.pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const selectedPackIds = z.array(z.string().min(1).max(64)).min(1).max(32);
/** Card ids stay opaque; the server compares them with the live round. */
const cardId = z.string().min(1).max(64);
const room = z.object({ roomCode });
const round = room.extend({ roundNumber: roundNumber.optional() });
const request = room.extend({ requestId: identifier });
const player = room.extend({ playerId: identifier });

export const incomingSchemas = {
  create_room: z.object({
    displayName: text,
    winningScore: winningScore.nullish().transform((value) => value ?? 20),
    selectedPackIds: selectedPackIds.optional(),
  }),
  join_room: room.extend({ displayName: text }),
  reconnect_player: room.extend({ reconnectToken: z.string().max(256).trim().min(1) }),
  leave_room: room,
  cancel_join_request: request,
  update_settings: room.extend({ winningScore }),
  update_packs: room.extend({ selectedPackIds }),
  update_game_mode: room.extend({ gameMode: z.enum(GAME_MODES) }),
  update_team_count: room.extend({ teamCount: numeric.pipe(z.number().int().min(2).max(4)) }),
  assign_team: player.extend({ teamId: z.enum(["team-1", "team-2", "team-3", "team-4"]) }),
  // The shared name rule trims and normalizes; this bound only rejects oversized input first.
  rename_team: room.extend({
    teamId: z.enum(["team-1", "team-2", "team-3", "team-4"]),
    name: z.string().max(96),
  }),
  toggle_psychic_timer: room,
  set_room_lock: room.extend({ locked: z.boolean() }),
  approve_join_request: request,
  reject_join_request: request,
  transfer_ownership: player,
  kick_player: player,
  start_game: room,
  watch_room: room,
  clue_submitted: round.extend({
    clue: text,
    cardId: cardId.optional(),
    targetRevision: targetRevision.optional(),
  }),
  skip_round: round.extend({ cardId: cardId.optional() }),
  redraw_card: round.extend({ cardId }),
  redraw_target: z.object({
    roomCode,
    roundNumber,
    cardId,
    targetRevision,
    requestId: identifier,
  }),
  guess_submitted: round.extend({ angle, cardId: cardId.optional() }),
  guess_preview: room.extend({ angle, roundNumber, cardId: cardId.optional() }),
  next_round: round,
  round_ready: round.extend({ ready: z.boolean().default(true) }),
  set_round_pause: room.extend({ roundNumber, paused: z.boolean() }),
  card_rating: round.extend({ vote: z.enum(["up", "down"]) }),
  send_reaction: round.extend({ reaction: z.enum(REACTIONS) }),
  vote_rematch: room.extend({ vote: z.boolean().default(true) }),
  rematch: room,
} satisfies Record<IncomingEvent, z.ZodType>;

export type ParsedIncoming<K extends IncomingEvent> = z.output<(typeof incomingSchemas)[K]>;
export function parseIncoming<K extends IncomingEvent>(
  event: K,
  payload: unknown,
): z.ZodSafeParseResult<ParsedIncoming<K>> {
  // Indexing the exhaustive schema map preserves the event-specific output relation.
  return incomingSchemas[event].safeParse(payload) as z.ZodSafeParseResult<ParsedIncoming<K>>;
}
