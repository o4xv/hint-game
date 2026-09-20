import * as Sentry from "@sentry/browser";
import { redactNavigationBreadcrumb, redactRoomUrl } from "./privacy";

const dsn: unknown = import.meta.env.VITE_SENTRY_DSN;
export function initializeClientTelemetry() {
  if (typeof dsn !== "string" || !dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: __BUILD_ID__,
    sendDefaultPii: false,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category?.startsWith("ui.") || breadcrumb.category === "console") {
        const clean = { ...breadcrumb };
        delete clean.message;
        delete clean.data;
        return clean;
      }
      return redactNavigationBreadcrumb(breadcrumb);
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        const url = redactRoomUrl(event.request.url);
        if (url === undefined) delete event.request.url;
        else event.request.url = url;
      }
      return event;
    },
  });
}
export function captureClientException(error: unknown) {
  if (typeof dsn === "string" && dsn) Sentry.captureException(error);
}
