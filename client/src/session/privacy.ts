import type { Breadcrumb } from "@sentry/browser";

export function redactRoomUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(value, "https://hint.invalid");
    url.pathname = url.pathname
      .replace(/\/(room|watch)\/[A-Za-z0-9]{4}(?=\/|$)/gi, "/$1/:code")
      .replace(/\/api\/room\/[A-Za-z0-9]{4}(?=\/|$)/gi, "/api/room/:code");
    url.search = "";
    url.hash = "";
    return absolute ? url.toString() : url.pathname;
  } catch {
    return undefined;
  }
}

export function redactNavigationBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.category !== "navigation" || !breadcrumb.data) return breadcrumb;
  const data: Record<string, unknown> = { ...breadcrumb.data };
  for (const field of ["from", "to", "url"]) {
    if (typeof data[field] === "string") data[field] = redactRoomUrl(data[field]);
  }
  return { ...breadcrumb, data };
}
