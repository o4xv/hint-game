# Version-one persistence fixtures

These JSON files were generated from the exact producer functions in commit `60287c6`, rather than by deleting fields from a modern snapshot.

The generation used the historical `roomManager.createRoom`/`addPlayer`, `gameEngine.calculatePsychicPoints`/`checkWinner`/`calculateAwards`, `roundLogic.triggerReveal` (and `resumeRecoveredRoom` for the abandoned result), then `persistence.serializeRoom`. Transport, telemetry and persistence side effects were inert; scoring and snapshot-producing functions were unmodified. `Date.now()` was fixed at1700000000000 and reconnect tokens replaced with explicit fixture tokens. The recorded rating has exactly the `{ playerId, vote }` shape written by that commit's `card_rating` handler.

- `v1-revealed-60287c6.json`: completed round below the winning score, with a stored rating.
- `v1-finished-60287c6.json`: completed winning match, singular winner, awards and round count.
- `v1-abandoned-60287c6.json`: recovery expiry leaves one player and emits the old insufficient-player final state.

Tests pass an explicit time near `savedAt` to isolate migration behavior from TTL expiration. All identity values are synthetic. These fixtures deliberately omit psychic breakdowns, winner lists, team/pause fields and rating regions because the historical producer omitted them.
