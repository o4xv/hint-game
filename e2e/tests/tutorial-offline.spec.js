import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The practice round is the part of the app that must survive without a backend: it uses no
 * room, no socket and no server data. This journey proves it after a *cached* offline reopen,
 * which is stronger than keeping an already-loaded document in memory.
 *
 * Chromium only, matching the documented limit: desktop WebKit offline emulation does not
 * establish installed iOS PWA behaviour.
 */
test("a cached app reopens offline and still completes the practice round", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Desktop WebKit offline emulation does not establish installed iOS PWA behavior.",
  );
  test.setTimeout(120_000);
  const client = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "client");
  const temporary = await mkdtemp(resolve(tmpdir(), "hint-tutorial-offline-"));
  const build = resolve(temporary, "build");
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const route =
        pathname === "/" || /^\/(room|watch)\//.test(pathname) ? "/index.html" : pathname;
      const path = resolve(build, `.${route}`);
      if (!path.startsWith(build + sep)) {
        response.writeHead(400).end();
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  let context;
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(client, "node_modules/vite/bin/vite.js"), "build", "--outDir", build],
      {
        cwd: client,
        env: { ...process.env, VERCEL_GIT_COMMIT_SHA: "pwa-tutorial" },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(result.status, String(result.error ?? "") + result.stderr + result.stdout).toBe(0);
    await new Promise((resolveListening) => {
      server.listen(0, "127.0.0.1", resolveListening);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({ viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    await page.goto(origin);
    // Only a controlling service worker can serve the document after the network is gone.
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await expect(page.getByRole("button", { name: "شرح اللعبة", exact: true })).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "شرح اللعبة", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
    const practice = page.getByRole("dialog");
    await expect(practice.getByRole("heading", { name: "الوسيط يرى الهدف" })).toBeVisible();
    await practice.getByRole("button", { name: "التالي", exact: true }).click();
    await practice.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
    await practice.getByRole("slider").focus();
    for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowRight");
    await practice.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
    await expect(practice.getByText(/3 من 3 نقاط/)).toBeVisible();
    // Free play runs offline too, including its reveal.
    await practice.getByRole("button", { name: "جرّب بنفسك", exact: true }).click();
    await practice.getByRole("button", { name: "تأكيد الإجابة", exact: true }).click();
    await expect(practice.locator(".dial-zone").first()).toBeVisible();
    await practice.getByRole("button", { name: "بطاقة أخرى", exact: true }).click();
    await expect(practice.getByText("حقيبة سفر", { exact: true })).toBeVisible();
    await context.setOffline(false);
  } finally {
    await context?.close();
    await new Promise((resolveClosed) => {
      server.close(resolveClosed);
    });
    await rm(temporary, { recursive: true, force: true });
  }
});
