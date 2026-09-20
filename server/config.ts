const environmentText = (name: string) => {
  const value = process.env[name];
  return value === "" ? undefined : value;
};
// Server configuration from environment variables
export const PORT = Number(process.env.PORT) || 3001;
export const NODE_ENV = environmentText("NODE_ENV") ?? "development";
export const DEPLOYMENT_ID =
  environmentText("RENDER_GIT_COMMIT") ??
  environmentText("VERCEL_GIT_COMMIT_SHA") ??
  environmentText("GIT_COMMIT") ??
  "local";
export const REDIS_URL = environmentText("REDIS_URL") ?? "";
export const POSTHOG_KEY = environmentText("POSTHOG_KEY") ?? "";
export const POSTHOG_HOST = environmentText("POSTHOG_HOST") ?? "https://us.i.posthog.com";
export const SENTRY_DSN = environmentText("SENTRY_DSN") ?? "";

export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : ["http://localhost:5173"];
