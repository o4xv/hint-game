import { memo, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { GuessResult } from "@hint/contracts";
import {
  clampAngle,
  DIAL,
  dialArc,
  dialWedge,
  needleColor,
  pointOnDial,
  positionToAngle,
} from "./dialGeometry";
const zones = [
  { outer: 24, inner: 16, color: "#6C5CE7", points: 1 },
  { outer: 16, inner: 6, color: "#FFE66D", points: 2 },
  { outer: 6, inner: 0, color: "#FF6B6B", points: 3 },
];

interface DialProps {
  angle?: number | null;
  targetAngle?: number | null;
  guesses?: GuessResult[];
  playerId?: string | null;
  /** Reveal selection: every other needle is dimmed while one is highlighted. */
  highlightPlayerId?: string | null;
  playerIndex?: number;
  interactive?: boolean;
  locked?: boolean;
  onChange?: (angle: number) => void;
  onDraft?: (angle: number) => void;
  onPreview?: (angle: number) => void;
  onTick?: () => void;
}

function Needle({
  angle,
  color,
  locked = false,
  label,
}: {
  angle: number;
  color: string;
  locked?: boolean;
  label?: string;
}) {
  const end = pointOnDial(angle);
  return (
    <g>
      {label && <title>{label}</title>}
      <line
        x1={DIAL.cx}
        y1={DIAL.cy}
        x2={end.x}
        y2={end.y}
        stroke="rgba(0,0,0,.72)"
        strokeWidth={8}
        strokeLinecap="round"
        className="dial-needle-shadow"
      />
      <line
        x1={DIAL.cx}
        y1={DIAL.cy}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={4}
        strokeLinecap="round"
        className="dial-needle-line"
      />
      <circle
        cx={DIAL.cx}
        cy={DIAL.cy}
        r={7}
        fill="#1A1A2E"
        stroke="#FFE66D"
        strokeWidth={2}
        className="dial-pivot"
      />
      <g className="dial-needle-handle">
        <circle
          cx={end.x}
          cy={end.y}
          r={17}
          fill="rgba(255,230,109,.24)"
          stroke="#FFE66D"
          strokeWidth={3}
          className="dial-handle-aura"
        />
        <circle
          cx={end.x}
          cy={end.y}
          r={10}
          fill={color}
          stroke="#000"
          strokeWidth={2}
          className="dial-handle-core"
        />
        {locked && (
          <text
            x={end.x}
            y={end.y + 5}
            textAnchor="middle"
            fill="#fff"
            stroke="#1A1A2E"
            strokeWidth={2}
            paintOrder="stroke fill"
            fontSize={16}
            fontWeight={900}
            className="dial-lock-mark"
          >
            ✓
          </text>
        )}
      </g>
    </g>
  );
}

export const Dial = memo(function Dial({
  angle = 90,
  targetAngle = null,
  guesses,
  playerId = null,
  highlightPlayerId = null,
  playerIndex = 0,
  interactive = false,
  locked = false,
  onChange,
  onDraft,
  onPreview,
  onTick,
}: DialProps) {
  const id = useId().replaceAll(":", "");
  const [drag, setDrag] = useState<{ pointerId: number; angle: number } | null>(null);
  const draft = useRef(angle ?? 90);
  const pointer = useRef<number | null>(null);
  const lastPreview = useRef(-Infinity);
  const enabled = interactive && !locked;
  const shownAngle = enabled && drag ? drag.angle : angle;

  function preview(next: number) {
    const now = Date.now();
    if (now - lastPreview.current < 50) return;
    lastPreview.current = now;
    onPreview?.(next);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!enabled || pointer.current !== event.pointerId) return;
    event.preventDefault();
    const next = positionToAngle(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    draft.current = next;
    setDrag({ pointerId: event.pointerId, angle: next });
    onDraft?.(next);
    preview(next);
  }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (!enabled || pointer.current !== null || event.button !== 0) return;
    pointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event);
  }
  function finish(event: PointerEvent<SVGSVGElement>) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (enabled) onChange?.(draft.current);
    setDrag(null);
  }
  function keyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (!enabled) return;
    const step = event.shiftKey ? 10 : 2;
    let next = angle ?? 90;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next += step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 180;
    else return;
    event.preventDefault();
    next = clampAngle(next);
    onDraft?.(next);
    onChange?.(next);
    preview(next);
    onTick?.();
  }

  return (
    <svg
      viewBox="-12 -12 404 214"
      width="100%"
      className={`dial-svg${enabled ? " interactive" : ""}${locked ? " is-locked is-waiting" : ""}${drag ? " is-dragging" : ""}`}
      role={enabled ? "slider" : "img"}
      tabIndex={enabled ? 0 : undefined}
      aria-label={
        enabled
          ? "مقياس التخمين. اسحب المؤشر أو استخدم أسهم لوحة المفاتيح لتغيير موضعه."
          : "مقياس الجولة"
      }
      aria-valuemin={enabled ? 0 : undefined}
      aria-valuemax={enabled ? 180 : undefined}
      aria-valuenow={enabled ? Math.round(shownAngle ?? 90) : undefined}
      aria-valuetext={
        enabled
          ? `المؤشر عند ${Math.round(((shownAngle ?? 90) / 180) * 100)} بالمئة من جهة اليسار`
          : undefined
      }
      aria-orientation={enabled ? "horizontal" : undefined}
      style={{ touchAction: enabled ? "none" : "auto" }}
      onPointerDown={start}
      onPointerMove={(event) => {
        move(event);
        if (pointer.current === event.pointerId) onTick?.();
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={keyDown}
    >
      <defs>
        <linearGradient id={`${id}-surface`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="100%" stopColor="#F1EEFF" />
        </linearGradient>
        <filter id={`${id}-shadow`} x="-20%" y="-25%" width="140%" height="155%">
          <feDropShadow dx="0" dy="5" stdDeviation="4" floodColor="#000" floodOpacity=".28" />
        </filter>
      </defs>
      <path
        d={dialWedge(0, 180)}
        fill={`url(#${id}-surface)`}
        filter={`url(#${id}-shadow)`}
        className="dial-surface"
      />
      <path
        d={dialArc(0, 180)}
        fill="none"
        stroke="#6C5CE7"
        strokeWidth={4}
        strokeLinecap="round"
      />
      <path
        d={dialArc(0, 180, 172)}
        fill="none"
        stroke="rgba(108,92,231,.2)"
        strokeWidth={1.5}
        className="dial-inner-rim"
      />
      <path d="M 10 190 L 370 190" stroke="#6C5CE7" strokeWidth={3} />
      {targetAngle !== null && (
        <g className="scoring-zones-group">
          {zones.map((zone) => (
            <path
              key={zone.points}
              d={dialWedge(
                clampAngle(targetAngle - zone.outer),
                clampAngle(targetAngle + zone.outer),
              )}
              fill={zone.color}
              stroke="rgba(26,26,46,.28)"
              strokeWidth={1.25}
              className={`dial-zone zone-pts-${zone.points}`}
            />
          ))}
          {zones.flatMap((zone) =>
            (zone.inner
              ? [
                  targetAngle - (zone.outer + zone.inner) / 2,
                  targetAngle + (zone.outer + zone.inner) / 2,
                ]
              : [targetAngle]
            )
              .filter((position) => position >= 0 && position <= 180)
              .map((position, index) => {
                const point = pointOnDial(position, 180 * 0.72);
                return (
                  <text
                    key={`${zone.points}-${index}`}
                    x={point.x}
                    y={point.y + 5}
                    textAnchor="middle"
                    fill="#fff"
                    stroke="#1A1A2E"
                    strokeWidth={2.5}
                    paintOrder="stroke fill"
                    fontSize={16}
                    fontWeight={900}
                    className="dial-zone-label"
                  >
                    {zone.points}
                  </text>
                );
              }),
          )}
        </g>
      )}
      {guesses
        ? guesses.map((guess, index) =>
            guess.angle === null ? null : (
              <g
                key={guess.playerId ?? guess.teamId ?? index}
                data-player-id={guess.playerId}
                data-needle={guess.displayName}
                className={
                  highlightPlayerId === null || guess.playerId === highlightPlayerId
                    ? undefined
                    : "is-dimmed"
                }
              >
                <Needle
                  angle={guess.angle}
                  color={needleColor(guess.playerId ?? guess.teamId, index)}
                  locked={guess.playerId === playerId}
                  label={guess.displayName}
                />
              </g>
            ),
          )
        : shownAngle !== null && (
            <Needle angle={shownAngle} color={needleColor(playerId, playerIndex)} locked={locked} />
          )}
    </svg>
  );
});
