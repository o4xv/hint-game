export const DIAL = {
  width: 380,
  height: 190,
  cx: 190,
  cy: 190,
  radius: 180,
  padding: 12,
} as const;
export const clampAngle = (angle: number): number => Math.max(0, Math.min(180, angle));

/** Twelve distinct needle colours so a full room never recycles one mid-round. */
export const NEEDLE_COLORS = [
  "#6C5CE7",
  "#00B894",
  "#E17055",
  "#0984E3",
  "#D63031",
  "#00CEC9",
  "#FD79A8",
  "#E1B12C",
  "#9B59B6",
  "#2D98DA",
  "#E84393",
  "#16A085",
] as const;

/**
 * A needle keeps its colour for the whole match because the colour comes from the player
 * id, not from the order guesses happen to arrive in.
 */
export function needleColor(playerId: string | null | undefined, fallbackIndex = 0): string {
  if (!playerId) return NEEDLE_COLORS[Math.max(0, fallbackIndex) % NEEDLE_COLORS.length] ?? "";
  let hash = 0;
  for (const character of playerId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return NEEDLE_COLORS[hash % NEEDLE_COLORS.length] ?? NEEDLE_COLORS[0];
}
export function pointOnDial(angle: number, radius: number = DIAL.radius) {
  const radians = (angle * Math.PI) / 180;
  return { x: DIAL.cx - radius * Math.cos(radians), y: DIAL.cy - radius * Math.sin(radians) };
}
export function dialArc(startAngle: number, endAngle: number, radius: number = DIAL.radius) {
  const start = pointOnDial(startAngle, radius);
  const end = pointOnDial(endAngle, radius);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
}
export function dialWedge(startAngle: number, endAngle: number) {
  return `M ${DIAL.cx} ${DIAL.cy} L ${dialArc(startAngle, endAngle).slice(2)} Z`;
}
export function positionToAngle(
  x: number,
  y: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  if (rect.width <= 0 || rect.height <= 0) return 90;
  const relativeX =
    ((x - rect.left) * (DIAL.width + 2 * DIAL.padding)) / rect.width - DIAL.padding - DIAL.cx;
  const relativeY =
    ((y - rect.top) * (DIAL.height + 2 * DIAL.padding)) / rect.height - DIAL.padding - DIAL.cy;
  return clampAngle(180 - (Math.atan2(Math.max(0, -relativeY), relativeX) * 180) / Math.PI);
}
