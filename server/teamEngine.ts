import { present } from "./invariants.js";
import type { Player, Room } from "./types.js";
import type { PublicTeam } from "@hint/contracts";
const TEAM_COLORS = ["#6C5CE7", "#00B894", "#E17055", "#0984E3"];
const TEAM_NAMES = ["الفريق ١", "الفريق ٢", "الفريق ٣", "الفريق ٤"];

export const GAME_MODES = Object.freeze(["individual", "teams"]);

/** Keeps a new team from inheriting another team's custom name. */
function defaultTeamName(index: number, taken: readonly string[]) {
  const used = new Set(taken);
  const preferred = TEAM_NAMES[index] ?? `الفريق ${index + 1}`;
  if (!used.has(preferred)) return preferred;
  const spare = TEAM_NAMES.find((candidate) => !used.has(candidate));
  if (spare) return spare;
  let suffix = TEAM_NAMES.length + 1;
  while (used.has(`الفريق ${suffix}`)) suffix += 1;
  return `الفريق ${suffix}`;
}

/** Rebuilding teams keeps surviving names, colors and scores; only new teams get defaults. */
export function createTeams(count = 2, previous: PublicTeam[] = []) {
  const teams: PublicTeam[] = [];
  for (let index = 0; index < count; index++) {
    const id = `team-${index + 1}`;
    const existing = previous.find((team) => team.id === id);
    teams.push({
      id,
      name:
        existing && existing.name.length > 0
          ? existing.name
          : defaultTeamName(
              index,
              teams.map((team) => team.name),
            ),
      color:
        existing && existing.color.length > 0
          ? existing.color
          : (TEAM_COLORS[index] ?? present(TEAM_COLORS[0])),
      score: Number(existing?.score) || 0,
    });
  }
  return teams;
}

export function ensureTeamState(room: Room) {
  room.gameMode = GAME_MODES.includes(room.gameMode) ? room.gameMode : "individual";
  room.teamCount =
    Number.isInteger(room.teamCount) && room.teamCount >= 2 && room.teamCount <= 4
      ? room.teamCount
      : 2;
  room.teams = createTeams(room.teamCount, room.teams);
  room.teamTurnIndex = Number.isInteger(room.teamTurnIndex) ? room.teamTurnIndex : 0;
  for (const player of room.players) player.teamId ??= null;
  return room;
}

export function getPublicTeams(room: Room) {
  ensureTeamState(room);
  return room.teams.map((team) => ({ ...team }));
}

export function rebalanceTeams(room: Room, count = room.teamCount) {
  room.teamCount = Math.max(2, Math.min(4, count || 2));
  room.teams = createTeams(room.teamCount, room.teams);
  room.players.forEach((player, index) => {
    player.teamId = present(room.teams[index % room.teamCount]).id;
  });
  room.teamPsychicIndexes = {};
  room.teamControllerIndexes = {};
  room.teamTurnIndex = 0;
  return room.teams;
}

export function assignPlayerToSmallestTeam(room: Room, player: Player) {
  ensureTeamState(room);
  const counts = new Map(room.teams.map((team) => [team.id, 0]));
  for (const candidate of room.players) {
    if (candidate.teamId && counts.has(candidate.teamId))
      counts.set(candidate.teamId, (counts.get(candidate.teamId) ?? 0) + 1);
  }
  const target = room.teams.reduce(
    (best, team) => ((counts.get(team.id) ?? 0) < (counts.get(best.id) ?? 0) ? team : best),
    present(room.teams[0]),
  );
  player.teamId = target.id;
  return target.id;
}

export function validateTeamSetup(room: Room, { connectedOnly = true } = {}) {
  ensureTeamState(room);
  const players = room.players.filter(
    (player) => !player.awaitingNextRound && (!connectedOnly || player.isConnected),
  );
  if (room.gameMode !== "teams") return { valid: true, players };
  if (players.length < 4)
    return {
      valid: false,
      reason: "team_min_players" as const,
      shortage: Math.max(1, 4 - players.length),
    };
  const invalidTeam = room.teams.find(
    (team) => players.filter((player) => player.teamId === team.id).length < 2,
  );
  if (invalidTeam) {
    const members = players.filter((player) => player.teamId === invalidTeam.id).length;
    return {
      valid: false,
      reason: "team_needs_two" as const,
      teamId: invalidTeam.id,
      shortage: Math.max(1, 2 - members),
    };
  }
  return { valid: true, players };
}

function nextRotatingMember(
  room: Room,
  teamId: string,
  field: "teamPsychicIndexes" | "teamControllerIndexes",
  excludedIds = new Set<string>(),
) {
  const members = room.players.filter(
    (player) =>
      player.teamId === teamId &&
      player.isConnected &&
      !player.awaitingNextRound &&
      !excludedIds.has(player.id),
  );
  if (!members.length) return null;
  const indexes = room[field];
  const index = (indexes[teamId] ?? 0) % members.length;
  indexes[teamId] = index + 1;
  return members[index];
}

export function getNextTeamRound(room: Room) {
  ensureTeamState(room);
  const eligibleTeams = room.teams.filter(
    (team) =>
      room.players.filter(
        (player) => player.teamId === team.id && player.isConnected && !player.awaitingNextRound,
      ).length >= 2,
  );
  if (!eligibleTeams.length) return null;

  let activeTeam = null;
  for (let offset = 0; offset < room.teams.length; offset++) {
    const index = (room.teamTurnIndex + offset) % room.teams.length;
    const candidate = room.teams[index];
    if (candidate && eligibleTeams.some((team) => team.id === candidate.id)) {
      activeTeam = candidate;
      room.teamTurnIndex = (index + 1) % room.teams.length;
      break;
    }
  }
  if (!activeTeam) return null;
  const psychic = nextRotatingMember(room, activeTeam.id, "teamPsychicIndexes");
  const controller = psychic
    ? nextRotatingMember(room, activeTeam.id, "teamControllerIndexes", new Set([psychic.id]))
    : null;
  if (!psychic || !controller) return null;
  return { activeTeam, psychic, controller };
}

export function checkTeamWinner(room: Room) {
  return getTeamWinners(room)[0] ?? null;
}

export function getTeamWinners(room: Room) {
  ensureTeamState(room);
  const eligible = room.teams.filter((team) => team.score >= room.winningScore);
  if (!eligible.length) return [];
  const topScore = Math.max(...eligible.map((team) => team.score));
  return eligible.filter((team) => team.score === topScore);
}

export function resetTeamScores(room: Room) {
  ensureTeamState(room);
  room.teams.forEach((team) => {
    team.score = 0;
  });
  room.teamTurnIndex = 0;
  room.teamPsychicIndexes = {};
  room.teamControllerIndexes = {};
}
