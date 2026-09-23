import { test, expect } from "@playwright/test";

async function sessionCredentials(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("hint_session");
    if (!raw) return null;
    const { roomCode, playerId, reconnectToken, displayName, isOwner } = JSON.parse(raw);
    return { roomCode, playerId, reconnectToken, displayName, isOwner };
  });
}
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

for (const externalActivation of [false, true]) {
  test(
    externalActivation
      ? "another tab activates an update without interrupting a production match"
      : "two production builds update on request, preserve the room, and reopen offline",
    async ({ browser, browserName }) => {
      test.skip(
        browserName !== "chromium",
        "Desktop WebKit offline emulation does not establish installed iOS PWA behavior.",
      );
      test.setTimeout(90_000);
      const client = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "client");
      const temporary = await mkdtemp(resolve(tmpdir(), "hint-pwa-"));
      const builds = [resolve(temporary, "a"), resolve(temporary, "b")];
      let activeBuild = builds[0];
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
          const path = resolve(activeBuild, `.${route}`);
          if (!path.startsWith(activeBuild + sep)) {
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
      let guestContext;
      try {
        for (const [index, outDir] of builds.entries()) {
          const result = spawnSync(
            process.execPath,
            [resolve(client, "node_modules/vite/bin/vite.js"), "build", "--outDir", outDir],
            {
              cwd: client,
              env: { ...process.env, VERCEL_GIT_COMMIT_SHA: index === 0 ? "pwa-a00" : "pwa-b00" },
              encoding: "utf8",
              windowsHide: true,
            },
          );
          expect(result.status, String(result.error ?? "") + result.stderr + result.stdout).toBe(0);
          expect(await readFile(resolve(outDir, "service-worker.js"), "utf8")).toContain(
            index === 0 ? "hint-runtime-pwa-a00" : "hint-runtime-pwa-b00",
          );
        }
        await new Promise((resolveListening) => {
          server.listen(0, "127.0.0.1", resolveListening);
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        await page.goto(origin);
        await page.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
        await page.getByLabel("اسم اللاعب").fill("اختبار التحديث");
        await page.getByRole("button", { name: "إنشاء غرفة", exact: true }).click();
        await expect(page.getByRole("heading", { name: "انتظار اللاعبين" })).toBeVisible();
        const code = await page.locator(".lobby-room-code").innerText();
        const session = await sessionCredentials(page);
        expect(session).toBeTruthy();
        expect(await page.evaluate(() => typeof window.__hintTest)).toBe("undefined");
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        await page.evaluate(() => caches.open("unrelated-app-cache"));
        let companion;
        let guest;
        if (externalActivation) {
          guestContext = await browser.newContext();
          guest = await guestContext.newPage();
          await guest.goto(`${origin}/room/${code}`);
          await guest.getByLabel("اسم اللاعب").fill("ضيف اختبار التحديث");
          await guest.getByRole("button", { name: "انضم", exact: true }).click();
          await expect(guest.getByRole("heading", { name: "انتظار اللاعبين" })).toBeVisible();
          companion = await context.newPage();
          // A second controlled document shares the worker without taking over the player's session.
          await companion.goto(`${origin}/offline.html`);
          await page.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
          await page.getByRole("dialog").getByRole("button", { name: "تخطي", exact: true }).click();
          await guest
            .getByRole("dialog")
            .getByRole("button", { name: "تخطي", exact: true })
            .click();
          await expect(page.getByLabel("التلميح", { exact: true })).toBeVisible();
          await page.evaluate(() => {
            window.__pwaDocumentMarker = "active-game";
          });
        }
        activeBuild = builds[1];
        await page.evaluate(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect
          .poll(() =>
            page.evaluate(async () =>
              Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
            ),
          )
          .toBe(true);
        if (externalActivation) {
          await expect(page.getByRole("button", { name: "تحديث", exact: true })).toHaveCount(0);
          await page.evaluate(() => {
            window.__pwaControllerChanged = false;
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              () => {
                window.__pwaControllerChanged = true;
              },
              { once: true },
            );
          });
          await expect
            .poll(() =>
              companion.evaluate(async () =>
                Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
              ),
            )
            .toBe(true);
          // Model the other tab accepting its update; this active tab has given no reload consent.
          await companion.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
          });
          await page.waitForFunction(() => window.__pwaControllerChanged);
          expect(await page.evaluate(() => window.__pwaDocumentMarker)).toBe("active-game");
          await expect(page.getByLabel("التلميح", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "تحديث", exact: true })).toHaveCount(0);
          // Leaving now goes through the in-game menu.
          await guest.getByRole("button", { name: "قائمة اللعبة", exact: true }).click();
          await guest.getByRole("button", { name: "مغادرة الغرفة", exact: true }).click();
          await guest.getByRole("button", { name: "مغادرة", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "النتائج النهائية", exact: true }),
          ).toBeVisible({ timeout: 35_000 }); // Existing server reconnect grace is30seconds.
        }
        await expect(page.getByRole("button", { name: "تحديث", exact: true })).toBeVisible();
        expect(await sessionCredentials(page)).toEqual(session);
        if (!externalActivation) await expect(page.locator(".lobby-room-code")).toHaveText(code);
        await Promise.all([
          page.waitForEvent("load"),
          page.getByRole("button", { name: "تحديث", exact: true }).click(),
        ]);
        await expect(
          page.getByRole("heading", {
            name: externalActivation ? "النتائج النهائية" : "انتظار اللاعبين",
            exact: true,
          }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const names = await caches.keys();
              return (
                names.includes("hint-runtime-pwa-b00") && !names.includes("hint-runtime-pwa-a00")
              );
            }),
          )
          .toBe(true);
        if (!externalActivation) await expect(page.locator(".lobby-room-code")).toHaveText(code);
        expect(await sessionCredentials(page)).toEqual(session);
        expect(await page.evaluate(() => caches.has("unrelated-app-cache"))).toBe(true);
        await context.setOffline(true);
        await page.goto(`${origin}/room/${code}`);
        await expect(page.getByRole("heading", { name: "استعادة المباراة" })).toBeVisible();
        expect(await sessionCredentials(page)).toEqual(session);
        await context.setOffline(false);
        await expect(page.locator(".recovery-overlay")).toHaveCount(0);
        await expect(
          page.getByRole("heading", {
            name: externalActivation ? "النتائج النهائية" : "انتظار اللاعبين",
            exact: true,
          }),
        ).toBeVisible();
        // The winner screen leaves through the in-game menu; the lobby keeps its own button.
        if (externalActivation) await page.getByRole("button", { name: "قائمة اللعبة" }).click();
        await page.getByRole("button", { name: "مغادرة الغرفة" }).click();
        await page.getByRole("button", { name: "مغادرة", exact: true }).click();
        await expect(page.getByRole("button", { name: "ابدأ اللعبة", exact: true })).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("hint_session"))).toBeNull();
      } finally {
        await guestContext?.close();
        await context?.close();
        await new Promise((resolveClosed) => {
          server.close(resolveClosed);
        });
        // Only remove the exact directory created by mkdtemp for this test.
        expect(temporary.startsWith(resolve(tmpdir()) + sep + "hint-pwa-")).toBe(true);
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
}
