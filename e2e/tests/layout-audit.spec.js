import { test, expect } from "@playwright/test";

/**
 * Bounding-box audit for the phone layouts. Playwright's "visible" check says nothing about
 * whether an element is clipped, overlapped or pushed against a safe area, so this spec
 * measures the boxes and prints a report instead of only asserting presence.
 *
 * It is a diagnostic tool, not part of the default suite: run it with
 * `HINT_LAYOUT_AUDIT=1 npx playwright test layout-audit.spec.js --project=mobile-chromium`.
 */
test.skip(!process.env.HINT_LAYOUT_AUDIT, "Layout audit; set HINT_LAYOUT_AUDIT=1 to run.");
test.describe.configure({ mode: "serial" });

const suppressCoaching = () => {
  for (const key of [
    "hint_intro_seen",
    "hint_first_round_coach_v1",
    "hint_first_round_coach_v2_psychic",
    "hint_first_round_coach_v2_guesser",
    "hint_first_round_coach_v2_observer",
  ])
    localStorage.setItem(key, "1");
};

async function createRoom(page, name) {
  await page.addInitScript(suppressCoaching);
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "ابدأ اللعبة" }).click();
  await page.getByLabel("اسم اللاعب").fill(name);
  await page.getByRole("button", { name: "إنشاء غرفة", exact: true }).click();
  await expect(page.getByText("انتظار اللاعبين")).toBeVisible();
  return page.evaluate(() => window.__hintTest.getState().roomCode);
}

async function joinRoom(page, roomCode, name) {
  await page.addInitScript(suppressCoaching);
  await page.goto(`/room/${roomCode}`);
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByLabel("اسم اللاعب").fill(name);
  await page.getByLabel("كود الغرفة").fill(roomCode);
  await page.getByRole("button", { name: "انضم", exact: true }).click();
  await expect(page.getByText("انتظار اللاعبين")).toBeVisible();
}

/** Every visible box, its viewport-relative rect and whether it escapes the viewport. */
async function measure(page, selectors) {
  return page.evaluate((list) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const report = {};
    for (const selector of list) {
      const nodes = [...document.querySelectorAll(selector)];
      report[selector] = nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          text: (node.textContent ?? "").trim().slice(0, 60),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          bottom: Math.round(rect.bottom),
          right: Math.round(rect.right),
          color: style.color,
          background: style.backgroundColor,
          overflowY: style.overflowY,
          clippedBelow: Math.round(rect.bottom) > viewport.height,
          clippedRight: Math.round(rect.right) > viewport.width + 1,
        };
      });
    }
    return {
      viewport,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      report,
    };
  }, selectors);
}

function report(name, data) {
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(data, null, 2));
}

test("measures the lobby, gameplay and scoreboard boxes at 393x852", async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () =>
      browser.newContext({
        serviceWorkers: "block",
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    const roomCode = await createRoom(pages[0], "أبو مالك");
    await joinRoom(pages[1], roomCode, "tm44z");
    await joinRoom(pages[2], roomCode, "حمود الشمري");
    await joinRoom(pages[3], roomCode, "ريان");

    await pages[0].locator(".lobby-settings-disclosure > summary").click();
    await pages[0].getByRole("button", { name: "فرق", exact: true }).click();
    await pages[0].waitForFunction(() => window.__hintTest.getState().gameMode === "teams");

    report(
      "lobby teams",
      await measure(pages[0], [
        ".lobby-screen",
        ".lobby-header",
        ".lobby-teams",
        ".team-card",
        ".team-card-header",
        ".team-name-edit",
        ".team-card-meta",
        ".team-members li",
        ".lobby-roster",
        ".lobby-player-grid .player-badge",
        ".lobby-primary-action",
        ".lobby-settings-disclosure > summary",
      ]),
    );

    // Rename the first team so the editor's real layout is measured too.
    const card = pages[0].locator('[data-team-id="team-1"]');
    await card.getByRole("button", { name: "تعديل الاسم" }).click();
    report(
      "lobby rename editor",
      await measure(pages[0], [
        ".team-name-form",
        ".team-name-form .input",
        ".team-name-actions .btn-primary",
        ".team-name-actions .btn-ghost",
      ]),
    );
    await card.getByRole("button", { name: "إلغاء" }).click();

    await pages[0].getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1),
      ),
    );
    const roles = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const state = window.__hintTest.getState();
          return {
            psychic: state.round.psychicId === state.playerId,
            controller: state.round.controllerId === state.playerId,
          };
        }),
      ),
    );
    const psychic = pages[roles.findIndex((role) => role.psychic)];
    const controllerPage = pages[roles.findIndex((role) => role.controller)];

    report(
      "psychic before clue",
      await measure(psychic, [
        ".screen.game",
        ".game-header",
        ".game-header-timer",
        ".game-header-round",
        ".game-header-score",
        ".round-status",
        ".round-status-state",
        ".spectrum-card",
        ".dial-hint",
        ".dial-stage",
        ".dial-svg",
        ".game-action-area",
        ".game-action-area .input",
        ".game-action-area .btn",
      ]),
    );
    report(
      "controller before clue",
      await measure(controllerPage, [
        ".screen.game",
        ".game-header",
        ".game-header-timer",
        ".round-status",
        ".round-status-state",
        ".spectrum-card",
        ".round-clue-card",
        ".dial-hint",
        ".dial-stage",
        ".game-action-area",
      ]),
    );

    await psychic.getByLabel("التلميح").fill("شاي ساخن جداً");
    await psychic.getByRole("button", { name: "أرسل التلميح" }).click();
    await expect(controllerPage.getByRole("button", { name: "تأكيد الإجابة" })).toBeEnabled();
    report(
      "controller after clue",
      await measure(controllerPage, [
        ".round-status",
        ".spectrum-card",
        ".round-clue-card",
        ".round-clue-card p",
        ".dial-hint",
        ".game-action-area .btn-primary",
      ]),
    );
    report(
      "psychic after clue",
      await measure(psychic, [".round-status", ".round-clue-card", ".badge", ".game-header-timer"]),
    );

    await controllerPage.getByRole("button", { name: "تأكيد الإجابة" }).click();
    await expect(pages[0].locator(".reveal-screen")).toBeVisible();
    await pages[0].getByRole("button", { name: "قائمة اللعبة", exact: true }).click();
    await pages[0].getByRole("button", { name: "لوحة النتائج", exact: true }).click();
    report(
      "scoreboard",
      await measure(pages[0], [
        ".react-dialog",
        ".react-dialog h2",
        ".rules-dialog-close",
        ".scoreboard",
        ".scoreboard-row",
        ".scoreboard-row.is-mine",
        ".scoreboard-name",
        ".scoreboard-role",
      ]),
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("measures the practice round at 393x852", async ({ page }) => {
  await page.addInitScript(suppressCoaching);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الوسيط يرى الهدف" })).toBeVisible();
  report(
    "practice step 1",
    await measure(page, [
      ".react-dialog",
      ".help-panel",
      ".practice",
      ".practice-head",
      ".practice-heading",
      ".practice > .spectrum-card",
      ".practice .spectrum-card > span",
      ".practice > .round-clue-card",
      ".practice .dial-stage",
      ".practice .dial-svg",
      ".practice-actions",
      ".practice-actions .btn",
    ]),
  );
  await page.getByRole("button", { name: "التالي", exact: true }).click();
  await page.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
  await page.getByRole("button", { name: "الفرق", exact: true }).click();
  await page.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
  await page.waitForTimeout(600);
  report(
    "practice teams reveal",
    await measure(page, [
      ".practice",
      ".practice-mode",
      ".practice-team-row",
      ".practice-team-score",
      ".practice-gain",
      ".practice-turn-button",
      ".practice-actions .btn",
    ]),
  );
});
