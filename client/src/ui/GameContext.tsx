import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { createSessionController } from "../session/controller";
import type { createSessionStore, SessionState } from "../session/store";
import type { UpdateControls } from "./UpdateBanner";

export interface GameRuntime {
  store: ReturnType<typeof createSessionStore>;
  controller: Pick<ReturnType<typeof createSessionController>, "send" | "recover">;
  leave: () => void;
  retry?: () => void;
  updates?: UpdateControls | null;
}
const Context = createContext<GameRuntime | null>(null);
export function GameProvider({ runtime, children }: { runtime: GameRuntime; children: ReactNode }) {
  return <Context.Provider value={runtime}>{children}</Context.Provider>;
}
export function useGame() {
  const runtime = useContext(Context);
  if (!runtime) throw new Error("GameProvider is required");
  return runtime;
}

/** Select a stable state field or primitive; local form/drag state stays in the component. */
export function useSession<Selection>(select: (state: SessionState) => Selection): Selection {
  const { store } = useGame();
  const getSnapshot = useCallback(() => select(store.getSnapshot()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
