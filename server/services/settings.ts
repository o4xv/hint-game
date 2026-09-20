import type { GameIO, GameSocket } from "../types.js";
import { onAction } from "../socketHandlers/boundary.js";
import { checkTeamName } from "@hint/contracts";

import { getRoom, getPublicPlayers, touchActivity, getPublicRoomMode } from "../roomManager.js";

import { validatePackIds } from "../data/cards.js";
import { trackGameplay } from "../telemetry.js";
import { GAME_MODES, ensureTeamState, getPublicTeams, rebalanceTeams } from "../teamEngine.js";
import { getPlayerForSocket } from "./membership.js";
export function setupSettingsService(io: GameIO, socket: GameSocket) {
  onAction(socket, "update_settings", ({ roomCode, winningScore }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    // winningScore validated by the shared schema.

    const room = getRoom(roomCode);
    if (room?.status !== "waiting") return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.ownerId) return;

    room.winningScore = winningScore;
    touchActivity(room);

    io.to(roomCode).emit("settings_updated", { winningScore });
  });
  onAction(socket, "update_packs", ({ roomCode, selectedPackIds }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const validated = validatePackIds(selectedPackIds);
    if (!validated) return;
    const room = getRoom(roomCode);
    if (room?.status !== "waiting") return;
    const player = getPlayerForSocket(room, socket.id);
    if (player?.id !== room.ownerId) return;
    room.selectedPackIds = validated;
    touchActivity(room);
    io.to(roomCode).emit("settings_updated", { selectedPackIds: validated });
    trackGameplay("pack_selection_updated", {
      playerId: player.id,
      roomId: room.code,
      packCount: validated.length,
    });
  });
  onAction(socket, "update_game_mode", ({ roomCode, gameMode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    if (!GAME_MODES.includes(gameMode)) return;
    const room = getRoom(roomCode);
    if (room?.status !== "waiting") return;
    const owner = getPlayerForSocket(room, socket.id);
    if (owner?.id !== room.ownerId) return;
    room.gameMode = gameMode;
    if (gameMode === "teams") rebalanceTeams(room, room.teamCount);
    else
      room.players.forEach((player) => {
        player.teamId = null;
      });
    touchActivity(room);
    io.to(room.code).emit("settings_updated", {
      ...getPublicRoomMode(room),
      players: getPublicPlayers(room),
    });
    trackGameplay("game_mode_updated", {
      playerId: owner.id,
      roomId: room.code,
      gameMode: room.gameMode,
      teamCount: room.teamCount,
    });
  });
  onAction(socket, "update_team_count", ({ roomCode, teamCount }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    const room = getRoom(roomCode);
    if (
      room?.status !== "waiting" ||
      !Number.isInteger(teamCount) ||
      teamCount < 2 ||
      teamCount > 4
    )
      return;
    const owner = getPlayerForSocket(room, socket.id);
    if (owner?.id !== room.ownerId) return;
    rebalanceTeams(room, teamCount);
    touchActivity(room);
    io.to(room.code).emit("settings_updated", {
      ...getPublicRoomMode(room),
      players: getPublicPlayers(room),
    });
  });
  onAction(socket, "assign_team", ({ roomCode, playerId, teamId }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const room = getRoom(roomCode);
    if (room?.status !== "waiting" || room.gameMode !== "teams") return;
    const owner = getPlayerForSocket(room, socket.id);
    const target = room.players.find((player) => player.id === playerId);
    if (owner?.id !== room.ownerId || !target || !room.teams.some((team) => team.id === teamId))
      return;
    target.teamId = teamId;
    touchActivity(room);
    io.to(room.code).emit("settings_updated", {
      teams: getPublicTeams(room),
      players: getPublicPlayers(room),
    });
  });
  onAction(socket, "rename_team", ({ roomCode, teamId, name }) => {
    roomCode = (roomCode || "").trim().toUpperCase();
    const reject = (code: string): void => {
      // The team is echoed so a host editing two teams at once sees the rejection on the
      // right card instead of on every open editor.
      socket.emit("action_error", { event: "rename_team", code, teamId });
    };
    const room = getRoom(roomCode);
    if (!room) {
      reject("TEAM_NOT_FOUND");
      return;
    }
    if (room.status !== "waiting") {
      reject("ROOM_NOT_WAITING");
      return;
    }
    const owner = getPlayerForSocket(room, socket.id);
    if (owner?.id !== room.ownerId) {
      reject("NOT_OWNER");
      return;
    }

    ensureTeamState(room);
    const team = room.teams.find((candidate) => candidate.id === teamId);
    if (!team) {
      reject("TEAM_NOT_FOUND");
      return;
    }
    const checked = checkTeamName(
      name,
      room.teams.filter((candidate) => candidate.id !== teamId).map((candidate) => candidate.name),
    );
    if (!checked.ok) {
      reject(`TEAM_NAME_${checked.issue.toUpperCase()}`);
      return;
    }

    // Accepting the current name still confirms the save for the editing client.
    if (team.name !== checked.name) {
      team.name = checked.name;
      touchActivity(room);
      trackGameplay("moderation_action", {
        playerId: owner.id,
        roomId: room.code,
        action: "rename_team",
      });
    }
    io.to(room.code).emit("settings_updated", { teams: getPublicTeams(room) });
  });
  onAction(socket, "toggle_psychic_timer", ({ roomCode }) => {
    roomCode = (roomCode || "").trim().toUpperCase();

    const room = getRoom(roomCode);
    if (room?.status !== "waiting") return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player?.id !== room.ownerId) return;

    room.psychicTimerEnabled = !room.psychicTimerEnabled;
    touchActivity(room);

    io.to(roomCode).emit("settings_updated", {
      psychicTimerEnabled: room.psychicTimerEnabled,
    });
  });
}
