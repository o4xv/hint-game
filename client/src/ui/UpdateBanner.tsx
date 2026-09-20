import { useState, useSyncExternalStore } from "react";
import type { createPwaUpdates } from "../session/updates";
import { useSession } from "./GameContext";

export type UpdateControls = Pick<
  ReturnType<typeof createPwaUpdates>,
  "subscribe" | "getSnapshot" | "requestUpdate"
>;
export function UpdateBanner({ updates }: { updates: UpdateControls }) {
  const available = useSyncExternalStore(
    updates.subscribe,
    updates.getSnapshot,
    updates.getSnapshot,
  );
  const screen = useSession((state) => state.currentScreen);
  const phase = useSession((state) => state.phase);
  const [dismissed, setDismissed] = useState(false);
  if (!available || dismissed || phase === "playing" || screen === "reveal") return null;
  return (
    <aside id="update-banner" className="update-banner" role="status" aria-live="polite">
      <span>تحديث جديد متاح!</span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          updates.requestUpdate();
        }}
      >
        تحديث
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="إغلاق إشعار التحديث"
        onClick={() => {
          setDismissed(true);
        }}
      >
        ×
      </button>
    </aside>
  );
}
