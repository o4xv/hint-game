import { Component, useEffect, type ReactNode } from "react";
import { useGame, useSession } from "./GameContext";
import { Entry, Landing, ConnectionStatus } from "./Entry";
import { Lobby } from "./Lobby";
import { PlayScene, Spectator } from "./PlayScene";
import { Waiting, Winner } from "./Results";
import { UpdateBanner } from "./UpdateBanner";
import { JoinRequests } from "./RoomControls";
import { GameMenuProvider } from "./GameMenu";
import { captureClientException } from "../session/telemetry";

interface ErrorBoundaryProps {
  children: ReactNode;
  recover: () => Promise<boolean>;
  leave: () => void;
}

interface ErrorBoundaryState {
  failed: boolean;
  recovering: boolean;
  recoveryFailed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, recovering: false, recoveryFailed: false };
  private mounted = false;
  /**
   * Identifies the attempt a recovery callback belongs to. Leaving, unmounting or
   * starting another attempt invalidates it, so a request that settles afterwards
   * cannot restore the crash screen the player already left.
   */
  private attempt = 0;
  static getDerivedStateFromError() {
    return { failed: true, recovering: false, recoveryFailed: false };
  }
  override componentDidMount() {
    this.mounted = true;
  }
  override componentWillUnmount() {
    this.mounted = false;
    this.attempt += 1;
  }
  override componentDidCatch(error: Error) {
    captureClientException(error);
  }
  private isCurrentAttempt(attempt: number) {
    return this.mounted && attempt === this.attempt;
  }
  /** Retry only after the server accepted the recovery; a failed attempt keeps the crash screen. */
  private retry = () => {
    if (this.state.recovering) return;
    const attempt = (this.attempt += 1);
    this.setState({ recovering: true, recoveryFailed: false });
    void this.props.recover().then(
      (recovered) => {
        if (!this.isCurrentAttempt(attempt)) return;
        this.setState(
          recovered
            ? { failed: false, recovering: false, recoveryFailed: false }
            : { failed: true, recovering: false, recoveryFailed: true },
        );
      },
      () => {
        if (!this.isCurrentAttempt(attempt)) return;
        this.setState({ failed: true, recovering: false, recoveryFailed: true });
      },
    );
  };
  /** Leaving invalidates the outstanding recovery before the controller settles it. */
  private leaveGame = () => {
    this.attempt += 1;
    this.props.leave();
    this.setState({ failed: false, recovering: false, recoveryFailed: false });
  };
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="screen">
        <h1>حدث خطأ غير متوقع</h1>
        <p>يمكنك محاولة استعادة المباراة.</p>
        {this.state.recoveryFailed && (
          <p role="alert">تعذّرت استعادة المباراة. تحقق من الاتصال وحاول مرة أخرى.</p>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={this.state.recovering}
          onClick={this.retry}
        >
          {this.state.recovering ? "جارٍ استعادة المباراة…" : "إعادة المحاولة"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={this.leaveGame}>
          العودة للبداية
        </button>
      </main>
    );
  }
}

function Recovery() {
  const { leave } = useGame();
  const state = useSession((state) => state);
  if (
    !state.roomCode ||
    !state.reconnectToken ||
    state.isSpectator ||
    state.connection === "connected"
  )
    return null;
  return (
    <section className="recovery-overlay" aria-label="استعادة الاتصال">
      <div className="card">
        <h2>استعادة المباراة</h2>
        <ConnectionStatus />
        <button type="button" className="btn btn-ghost" onClick={leave}>
          مغادرة الغرفة
        </button>
      </div>
    </section>
  );
}

export function App() {
  const { updates } = useGame();
  const screen = useSession((state) => state.currentScreen);
  const roundNumber = useSession((state) => state.round.roundNumber);
  const cardId = useSession((state) => state.round.card?.id ?? "");
  const isSpectator = useSession((state) => state.isSpectator);
  // A same-turn replacement is a new card for the same round, so the screen key follows
  // both: the dial draft, clue draft and any open dialog belong to the old card.
  const turnKey = `${roundNumber}:${cardId}`;
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>("#app main h1, #app main h2");
    if (!document.querySelector("dialog[open]") && heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    // Entering the reveal keeps the dial where it was: the results grow the page instead of
    // scrolling back to the top, which would hide the answer that is animating in.
    if (screen !== "reveal") window.scrollTo({ top: 0 });
  }, [screen]);
  let content: ReactNode;
  switch (screen) {
    case "landing":
      content = <Landing />;
      break;
    case "home":
      content = <Entry />;
      break;
    case "lobby":
      content = <Lobby />;
      break;
    case "game-player":
    case "game-psychic":
    case "reveal":
      // One scene for the clue, the guess and the reveal, so the dial never remounts mid-turn.
      content = <PlayScene key={turnKey} />;
      break;
    case "winner":
      // A spectator who left the deciding reveal sees the read-only standings.
      content = <Winner key={`winner-${roundNumber}`} spectator={isSpectator} />;
      break;
    case "spectator":
      content = <Spectator />;
      break;
    case "pending-join":
    case "waiting-next-round":
      content = <Waiting />;
      break;
  }
  return (
    <GameMenuProvider>
      {content}
      <JoinRequests />
      {updates && <UpdateBanner updates={updates} />}
      <Recovery />
    </GameMenuProvider>
  );
}
