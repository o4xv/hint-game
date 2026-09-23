import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Manual evidence capture for the answer-position change and the reveal sequence. CI skips it;
 * run locally with HINT_EVIDENCE=1 so the images land in docs/evidence.
 */
test.skip(!process.env.HINT_EVIDENCE, "Manual evidence capture; set HINT_EVIDENCE=1 to run.");
test.describe.configure({ mode: "serial" });

const here = dirname(fileURLToPath(import.meta.url));
const directory = resolve(here, "../../docs/evidence/target-redraw");

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

async function enterHome(page) {
  await page.addInitScript(suppressCoaching);
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "ابدأ اللعبة" }).click();
  await expect(page.getByLabel("اسم اللاعب")).toBeVisible();
}

async function createRoom(page, name) {
  await enterHome(page);
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

async function dragDialTo(page, angle) {
  const point = await page.locator(".dial-svg").evaluate((svg, target) => {
    const rect = svg.getBoundingClientRect();
    const radians = (target * Math.PI) / 180;
    const userX = 190 - 165 * Math.cos(radians);
    const userY = 190 - 165 * Math.sin(radians);
    return {
      x: rect.left + ((userX + 12) * rect.width) / 404,
      y: rect.top + ((userY + 12) * rect.height) / 214,
    };
  }, angle);
  const box = await page.locator(".dial-svg").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.95);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
}

test("captures the controls, the movement and every reveal stage", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await mkdir(directory, { recursive: true });
  const project = testInfo.project.name;
  const ownerContext = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  const guestContext = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  const shot = (page, name) =>
    page.screenshot({ path: resolve(directory, `${project}-${name}.png`) });
  try {
    const roomCode = await createRoom(owner, "ريم");
    await joinRoom(guest, roomCode, "خالد");
    await owner.locator(".lobby-settings-disclosure > summary").click();
    await owner.getByRole("button", { name: "نعم", exact: true }).click();
    await owner.waitForFunction(() => window.__hintTest.getState().psychicTimerEnabled);
    await owner.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await owner.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1);
    const ownerIsPsychic = await owner.evaluate(
      () => window.__hintTest.getState().round.psychicId === window.__hintTest.getState().playerId,
    );
    const psychic = ownerIsPsychic ? owner : guest;
    const guesser = ownerIsPsychic ? guest : owner;

    // 1. Both controls with a full allowance.
    await expect(psychic.getByText("متبقي: 3 من 3")).toBeVisible();
    await shot(psychic, "01-psychic-controls");

    // 2. The confirmed movement: captured while the bands travel, then once they land.
    await psychic.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
    await expect(psychic.locator(".dial-zones-rotor")).toHaveClass(/is-moving/, { timeout: 3000 });
    await shot(psychic, "02-position-moving");
    await psychic.waitForFunction(
      () => window.__hintTest.getState().round.targetRedraw.revision === 1,
    );
    await expect(psychic.locator(".dial-zones-rotor")).not.toHaveClass(/is-moving/);
    await expect(psychic.locator(".dial-zone-labels")).toHaveCSS("opacity", "1");
    await expect(psychic.getByText("باقي 2 · الدور القادم")).toBeVisible();
    await shot(psychic, "03-position-landed-and-used");
    const target = await psychic.evaluate(() => window.__hintTest.getState().round.targetAngle);

    // 3. The clue, then the guess, then each reveal stage on the guessing page.
    await psychic.getByLabel("التلميح").fill("تلميح الموضع الجديد");
    await psychic.getByRole("button", { name: "أرسل التلميح" }).click();
    await guesser.waitForFunction(() => window.__hintTest.getState().round.clue !== null);
    await dragDialTo(guesser, target);
    await shot(guesser, "04-guesser-before-reveal");
    await guesser.getByRole("button", { name: "تأكيد الإجابة" }).click();
    await expect(guesser.locator(".dial-zones-reveal")).toHaveClass(/is-visible/);
    await shot(guesser, "05-reveal-answer-zone");
    await guesser.waitForTimeout(300);
    await shot(guesser, "06-reveal-needles");
    await guesser.waitForTimeout(320);
    await shot(guesser, "07-reveal-scores");
    await guesser.waitForTimeout(400);
    await shot(guesser, "08-reveal-settled");

    // 4. The same round in reduced motion, and a narrow phone with the longest labels.
    await guesser.emulateMedia({ reducedMotion: "reduce" });
    await guesser.reload();
    await guesser.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1);
    await guesser.waitForTimeout(400);
    await shot(guesser, "09-reveal-reduced-motion");
    await guesser.setViewportSize({ width: 320, height: 568 });
    await shot(guesser, "10-reveal-narrow");
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test("captures the team allowance and the exhausted state", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const project = testInfo.project.name;
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () =>
      browser.newContext({
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const shot = (page, name) =>
    page.screenshot({ path: resolve(directory, `${project}-${name}.png`) });
  try {
    const roomCode = await createRoom(pages[0], "ريم");
    await joinRoom(pages[1], roomCode, "خالد");
    await joinRoom(pages[2], roomCode, "سارة");
    await joinRoom(pages[3], roomCode, "سلمان");
    await pages[0].locator(".lobby-settings-disclosure > summary").click();
    await pages[0].getByRole("button", { name: "فرق", exact: true }).click();
    await pages[1].waitForFunction(() => window.__hintTest.getState().gameMode === "teams");
    await pages[0].getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await pages[0].waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1);
    for (const round of [1, 2, 3]) {
      await Promise.all(
        pages.map((page) =>
          page.waitForFunction(
            (number) => window.__hintTest.getState().round.roundNumber === number,
            round,
          ),
        ),
      );
      const states = await Promise.all(
        pages.map((page) =>
          page.evaluate(() => {
            const state = window.__hintTest.getState();
            return {
              playerId: state.playerId,
              psychicId: state.round.psychicId,
              controllerId: state.round.controllerId,
            };
          }),
        ),
      );
      const psychicPage = pages[states.findIndex((state) => state.psychicId === state.playerId)];
      const controllerPage =
        pages[states.findIndex((state) => state.controllerId === state.playerId)];
      if (round === 1) await shot(psychicPage, "11-team-allowance");
      await psychicPage.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
      await psychicPage.waitForFunction(
        () => window.__hintTest.getState().round.targetRedraw.revision === 1,
      );
      if (round === 3) await shot(psychicPage, "12-team-allowance-spent");
      await psychicPage.getByLabel("التلميح").fill(`تلميح الجولة ${round}`);
      await psychicPage.getByRole("button", { name: "أرسل التلميح" }).click();
      await controllerPage.getByRole("button", { name: "تأكيد الإجابة" }).click();
      await expect(pages[0].locator(".reveal-screen")).toBeVisible();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
