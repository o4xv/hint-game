// ─── Input Sanitization ───

function stripControls(s: string) {
  // Remove control characters (0x00-0x1F except tab \t \n, and 0x7F)
  return Array.from(s)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join("");
}

function clean(raw: unknown, maxLen: number) {
  let s = typeof raw === "string" ? raw : "";
  // Reject outright if contains HTML angle brackets
  if (/<|>/.test(s)) return null;
  s = stripControls(s);
  s = s.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

export function sanitizeDisplayName(raw: unknown) {
  return clean(raw, 20);
}

export function sanitizeClue(raw: unknown) {
  return clean(raw, 50);
}
