import type { GameIO, GameSocket } from "../types.js";
import { setupMembershipService } from "../services/membership.js";
import { setupSettingsService } from "../services/settings.js";
import { setupModerationService } from "../services/moderation.js";
import { setupMatchService } from "../services/match.js";
export function setupRoomHandlers(io: GameIO, socket: GameSocket) {
  setupMembershipService(io, socket);
  setupSettingsService(io, socket);
  setupModerationService(io, socket);
  setupMatchService(io, socket);
}
