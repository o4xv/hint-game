// ═══════════════════════════════════════════════════
//  هنت  —  Sound Effects
// ═══════════════════════════════════════════════════

let ctx: AudioContext | null = null;
let activated = false;

function getCtx() {
  if (!activated) return null;
  if (!ctx) {
    try {
      const legacy = window as Window & { webkitAudioContext?: typeof AudioContext };
      const Constructor =
        typeof window.AudioContext === "function" ? window.AudioContext : legacy.webkitAudioContext;
      if (!Constructor) return null;
      ctx = new Constructor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {
      /* Playback can resume on the next user gesture. */
    });
  }
  return ctx.state === "running" ? ctx : null;
}

// ─── Helpers ───

function note(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  type: OscillatorType,
  gain: number,
  extra?: (osc: OscillatorNode, gain: GainNode, time: number) => void,
) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain || 0.15, startTime);
  g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  if (extra) extra(osc, g, startTime);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

// ─── Sound Functions ───

// ─── Dial tick (pure sine click, 80ms throttle) ───

let lastTick = 0;

/**
 * Dial drag tick — AudioBuffer source, zero decode delay.
 * Throttled to fire at most once every 80ms.
 */
export function playTick() {
  const c = getCtx();
  if (!c) return;

  const now = performance.now();
  if (now - lastTick < 80) return;
  lastTick = now;

  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 800;
  const g = c.createGain();
  g.gain.setValueAtTime(0.15, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.03);
  osc.connect(g);
  g.connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.03);
}

// ─── UI Sounds ───

/**
 * Hint submit — same click-lock sound as guess lock
 */
export function playHintSubmit() {
  playGuessLock();
}

/**
 * Guess lock — two quick mechanical clicks with pitch drop
 */
export function playGuessLock() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;

  [800, 650].forEach((freq, i) => {
    const start = t + i * 0.06;
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.06, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.04);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.04);
  });

  // Body thud
  const bosc = c.createOscillator();
  bosc.type = "sine";
  bosc.frequency.value = 100;
  const bg = c.createGain();
  bg.gain.setValueAtTime(0.1, t);
  bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  bosc.connect(bg);
  bg.connect(c.destination);
  bosc.start(t);
  bosc.stop(t + 0.1);
}

/**
 * Join room — soft welcome chime 440→660Hz, 200ms
 */
export function playJoinRoom() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(440, t);
  osc.frequency.linearRampToValueAtTime(660, t + 0.2);
  const g = c.createGain();
  g.gain.setValueAtTime(0.1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.25);
}

/**
 * Create room — rising tone 300→600Hz, 300ms
 */
export function playCreateRoom() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.linearRampToValueAtTime(600, t + 0.3);
  const g = c.createGain();
  g.gain.setValueAtTime(0.1, t);
  g.gain.linearRampToValueAtTime(0.1, t + 0.15);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.35);
}

/**
 * New round — attention pop + ascending two-tone
 */
export function playNewRound() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // Pop — brief noise burst
  const ns = Math.floor(c.sampleRate * 0.04);
  const nb = c.createBuffer(1, ns, c.sampleRate);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < ns; i++)
    nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.005));
  const nsrc = c.createBufferSource();
  nsrc.buffer = nb;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.06, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  nsrc.connect(ng);
  ng.connect(c.destination);
  nsrc.start(t);
  nsrc.stop(t + 0.04);

  // Ascending two-tone
  note(c, 523, t + 0.03, 0.15, "sine", 0.08);
  note(c, 659, t + 0.12, 0.15, "sine", 0.08);
}

/**
 * Timer warning — 3 rising beeps at 10s remaining
 */
export function playTimerWarning() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  note(c, 440, t, 0.08, "sine", 0.12);
  note(c, 550, t + 0.15, 0.08, "sine", 0.12);
  note(c, 660, t + 0.3, 0.08, "sine", 0.12);
}

/**
 * Role assigned (psychic) — mystical rising tone, 500ms
 */
export function playRoleAssigned() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(260, t);
  osc.frequency.linearRampToValueAtTime(520, t + 0.3);
  osc.frequency.linearRampToValueAtTime(520, t + 0.5);
  const g = c.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.linearRampToValueAtTime(0.1, t + 0.1);
  g.gain.setValueAtTime(0.1, t + 0.4);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.55);
}

/**
 * Player join — soft bubble pop, 80ms
 */
export function playPlayerJoin() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, t);
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.04);
  osc.frequency.exponentialRampToValueAtTime(400, t + 0.08);
  const g = c.createGain();
  g.gain.setValueAtTime(0.07, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.09);
}

/**
 * Reveal swoosh — dramatic sweep
 */
export function playReveal() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;

  // Noise component that sweeps
  const bufferSize = Math.floor(c.sampleRate * 0.8);
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 3;
  filter.frequency.setValueAtTime(200, t);
  filter.frequency.exponentialRampToValueAtTime(2000, t + 0.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.linearRampToValueAtTime(0.1, t + 0.15);
  g.gain.linearRampToValueAtTime(0.1, t + 0.6);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
  src.connect(filter);
  filter.connect(g);
  g.connect(c.destination);
  src.start(t);
  src.stop(t + 0.8);

  // Low rumble
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(60, t);
  osc.frequency.exponentialRampToValueAtTime(300, t + 0.5);
  const og = c.createGain();
  og.gain.setValueAtTime(0.001, t);
  og.gain.linearRampToValueAtTime(0.07, t + 0.1);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
  osc.connect(og);
  og.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.7);
}

/**
 * Score pop — points: 0 | 1 | 2 | 3
 */
export function playScore(points: number) {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;

  if (points >= 3) {
    // Triumphant — three ascending tones C5 E5 G5
    note(c, 523, t, 0.25, "triangle", 0.12);
    note(c, 659, t + 0.07, 0.25, "triangle", 0.12);
    note(c, 784, t + 0.14, 0.3, "triangle", 0.14);
  } else if (points >= 2) {
    // Two positive chimes E5 G5
    note(c, 659, t, 0.22, "sine", 0.1);
    note(c, 784, t + 0.06, 0.22, "sine", 0.1);
  } else if (points >= 1) {
    // Single soft chime C5
    note(c, 523, t, 0.2, "sine", 0.1);
  } else {
    // Descending womp — two low tones dropping G3→E3
    note(c, 196, t, 0.25, "sine", 0.08);
    note(c, 165, t + 0.1, 0.25, "sine", 0.08);
  }
}

/**
 * Game winner — celebratory ascending scale
 */
export function playWinner() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const notes = [523, 587, 659, 698, 784, 880, 988, 1047]; // C5 to C6
  const duration = 0.12;
  const gap = 0.1;

  notes.forEach((freq, i) => {
    const start = t + i * gap;
    note(c, freq, start, duration, "square", 0.08);
  });

  // Second run higher and softer
  const notes2 = [659, 784, 880, 988, 1047, 1175, 1319, 1397];
  notes2.forEach((freq, i) => {
    const start = t + notes.length * gap + 0.2 + i * gap * 0.7;
    note(c, freq, start, duration * 0.8, "triangle", 0.06);
  });

  // Bass hit at the start
  note(c, 131, t, 0.6, "sine", 0.1);
}

/**
 * Prime audio: resume context + preload tick buffer
 */
export function initAudio() {
  const activate = () => {
    activated = true;
    getCtx();
  };
  const foreground = () => {
    if (document.visibilityState === "visible" && activated) getCtx();
  };
  document.addEventListener("visibilitychange", foreground);
  document.addEventListener("pointerdown", activate);
  document.addEventListener("keydown", activate);
  return () => {
    document.removeEventListener("visibilitychange", foreground);
    document.removeEventListener("pointerdown", activate);
    document.removeEventListener("keydown", activate);
    const previous = ctx;
    ctx = null;
    activated = false;
    if (previous && previous.state !== "closed")
      void previous.close().catch(() => {
        /* Already disposed by the browser. */
      });
  };
}
