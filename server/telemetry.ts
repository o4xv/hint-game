import crypto from "node:crypto";
import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";
import { DEPLOYMENT_ID, NODE_ENV, POSTHOG_HOST, POSTHOG_KEY, SENTRY_DSN } from "./config.js";

const SAFE_FIELDS = new Set([
  "roomStatus",
  "roundNumber",
  "packId",
  "packCount",
  "playerCount",
  "vote",
  "reaction",
  "action",
  "joinMode",
  "storageStatus",
  "reason",
  "durationMs",
  "positive",
  "cardId",
  "targetRegion",
  "approved",
  "isOwner",
  "gameMode",
  "teamCount",
  "winningScore",
  "environment",
  "deployment",
]);

let posthog: PostHog | null = null;
const anonymousSalt = crypto.randomBytes(32);

export function redactRequestUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  if (!value) return value;
  try {
    const url = new URL(value, "https://hint.invalid");
    url.pathname = url.pathname
      .replace(/\/(room|watch)\/[A-Za-z0-9]{4}(?=\/|$)/gi, "/$1/:code")
      .replace(/\/api\/room\/[A-Za-z0-9]{4}(?=\/|$)/gi, "/api/room/:code");
    url.search = "";
    url.hash = "";
    return /^[a-z][a-z\d+.-]*:/i.test(value) ? url.toString() : url.pathname;
  } catch {
    return undefined;
  }
}

export function initializeTelemetry() {
  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: NODE_ENV,
      release: DEPLOYMENT_ID,
      sendDefaultPii: false,
      beforeSend(event) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.query_string;
          const redacted = redactRequestUrl(event.request.url);
          if (redacted === undefined) delete event.request.url;
          else event.request.url = redacted;
        }
        return event;
      },
    });
  }
  if (POSTHOG_KEY) {
    posthog = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST, flushAt: 10, flushInterval: 5000 });
  }
}

function anonymousId(value: unknown) {
  return crypto
    .createHmac("sha256", anonymousSalt)
    .update(typeof value === "string" || typeof value === "number" ? String(value) : "unknown")
    .digest("hex")
    .slice(0, 24);
}

export function sanitizeTelemetryProperties(properties: Record<string, unknown> = {}) {
  const safe: Record<string, string | number | boolean> = {
    environment: NODE_ENV,
    deployment: DEPLOYMENT_ID,
  };
  for (const [key, value] of Object.entries(properties)) {
    if (
      SAFE_FIELDS.has(key) &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    )
      safe[key] = value;
  }
  return safe;
}

export function getTelemetryDistinctId({ roomId, playerId }: Record<string, unknown> = {}) {
  return anonymousId(roomId ?? playerId);
}

export function buildGameplayCapture(
  event: string,
  { playerId, roomId, ...properties }: Record<string, unknown> = {},
) {
  return {
    distinctId: getTelemetryDistinctId({ roomId, playerId }),
    event,
    properties: sanitizeTelemetryProperties(properties),
  };
}

export function trackGameplay(event: string, context: Record<string, unknown> = {}) {
  const capture = buildGameplayCapture(event, context);
  posthog?.capture(capture);
  return capture;
}

export function getTelemetryHealth() {
  return {
    posthog: POSTHOG_KEY ? "configured" : "disabled",
    sentry: SENTRY_DSN ? "configured" : "disabled",
  };
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  console.error("[hint-server]", error instanceof Error ? error.stack : error);
  if (!SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    scope.setTags({ environment: NODE_ENV, deployment: DEPLOYMENT_ID });
    for (const [key, value] of Object.entries(context)) {
      if (SAFE_FIELDS.has(key)) scope.setExtra(key, value);
    }
    Sentry.captureException(error);
  });
}

export async function shutdownTelemetry() {
  await posthog?.shutdown();
  await Sentry.close(2000);
}
