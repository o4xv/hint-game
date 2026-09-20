import { useEffect, useState, type SyntheticEvent } from "react";
import { useGame, useSession } from "./GameContext";
import { Rules } from "./Rules";

export function ConnectionStatus() {
  const { controller, retry } = useGame();
  const status = useSession((state) => state.connection);
  if (status === "connected") return null;
  return (
    <div className="server-readiness" role="status" aria-live="polite">
      <span>
        {status === "offline"
          ? "لا يوجد اتصال بالإنترنت"
          : status === "recovering"
            ? "جارٍ استعادة المباراة…"
            : status === "waking"
              ? "جاري تجهيز اللعبة… قد يستغرق الخادم المجاني لحظات"
              : status === "unavailable"
                ? "تعذّر تشغيل الخادم الآن"
                : "جارٍ الاتصال…"}
      </span>
      <button
        type="button"
        className="server-readiness-retry"
        onClick={() => {
          if (retry) retry();
          else void controller.recover();
        }}
      >
        إعادة المحاولة
      </button>
    </div>
  );
}

export function Landing() {
  const { store } = useGame();
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return (
    <main className="screen landing-screen">
      <h1 className="sr-only">هنت</h1>
      <div className="landing-logo" aria-hidden="true" />
      <div className="landing-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            store.dispatch({ type: "navigate", screen: "home" });
          }}
        >
          ابدأ اللعبة
        </button>
        <Rules />
        {isIOS && !standalone && (
          <p className="install-hint">↑ اضغط زر المشاركة ثم "إضافة إلى الشاشة الرئيسية"</p>
        )}
      </div>
      <ConnectionStatus />
    </main>
  );
}

export function Entry() {
  const { store, controller } = useGame();
  const state = useSession((state) => state);
  const [name, setName] = useState(state.displayName ?? "");
  const [code, setCode] = useState(state.joinCode ?? "");
  const [pending, setPending] = useState<"create" | "join" | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const ready = state.connection === "connected";
  if (pending !== null && !ready) setPending(null);
  const busy = pending !== null && state.joinError === null;

  useEffect(() => {
    if (!pending || !ready || state.joinError) return;
    const deadline = window.setTimeout(() => {
      setPending(null);
      setRequestError("لم يصل رد من الخادم. حاول مرة أخرى.");
    }, 15_000);
    return () => {
      window.clearTimeout(deadline);
    };
  }, [pending, ready, state.joinError]);

  function submit(mode: "create" | "join") {
    const displayName = name.trim();
    if (!ready || busy || !displayName || (mode === "join" && code.length !== 4)) return;
    store.dispatch({ type: "clear-error" });
    setRequestError(null);
    store.dispatch({ type: "identity", data: { displayName } });
    setPending(mode);
    if (mode === "create")
      controller.send("create_room", {
        displayName,
        winningScore: state.winningScore,
        selectedPackIds: state.selectedPackIds,
      });
    else controller.send("join_room", { displayName, roomCode: code });
  }
  function formSubmitted(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(code.length === 4 ? "join" : "create");
  }

  return (
    <main className="screen entry-screen">
      <header className="entry-header">
        <button
          type="button"
          className="icon-button"
          aria-label="رجوع"
          onClick={() => {
            store.dispatch({ type: "navigate", screen: "landing" });
          }}
        >
          →
        </button>
        <h1>ابدأ هنت</h1>
      </header>
      <form className="card entry-card" noValidate onSubmit={formSubmitted}>
        <label htmlFor="player-name">اسم اللاعب</label>
        <input
          className="input"
          id="player-name"
          autoComplete="nickname"
          enterKeyHint="next"
          maxLength={20}
          placeholder="اكتب اسمك"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || !name.trim() || busy}
          onClick={() => {
            submit("create");
          }}
        >
          {busy && pending === "create" ? "جارٍ إنشاء الغرفة…" : "إنشاء غرفة"}
        </button>
        <div className="entry-divider">
          <span>أو انضم بكود</span>
        </div>
        <div className="entry-join-row">
          <input
            className="input room-code-input"
            id="room-code"
            aria-label="كود الغرفة"
            autoComplete="one-time-code"
            inputMode="text"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={4}
            placeholder="ABCD"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
            }}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!ready || !name.trim() || code.length !== 4 || busy}
          >
            {busy && pending === "join" ? "جارٍ الانضمام…" : "انضم"}
          </button>
        </div>
        <p className="entry-error" role="alert">
          {state.joinError ?? requestError}
        </p>
      </form>
      <ConnectionStatus />
    </main>
  );
}
