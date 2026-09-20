import { test, expect } from "@playwright/test";

// The interactive explanation is a required feature, so every browser project walks it:
// progression, keyboard play, honest scoring, isolation from the live match and offline use.

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

async function openPractice(page) {
  await page.addInitScript(suppressCoaching);
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "الوسيط يرى الهدف" })).toBeVisible();
}

/** Counts the target's scoring bands, which only exist while the target is on screen. */
function zoneCount(page) {
  return page.locator(".dial-zone").count();
}

test("walks the practice round, keeps the target hidden and scores the answer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openPractice(page);

  // Step one is the psychic's view: the bands are visible and no needle can be moved.
  expect(await zoneCount(page)).toBeGreaterThan(0);
  await expect(page.getByRole("slider")).toHaveCount(0);

  await page.getByRole("button", { name: "التالي", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الوسيط يعطي تلميحاً" })).toBeVisible();
  await expect(page.getByText("شاي ساخن", { exact: true })).toBeVisible();
  expect(await zoneCount(page)).toBe(0);

  await page.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
  const slider = page.getByRole("slider");
  await expect(slider).toBeVisible();
  expect(await zoneCount(page)).toBe(0);
  await expect(slider).toHaveAttribute("aria-valuenow", "90");
  await expect(slider).not.toHaveAttribute("aria-valuetext", /130/);

  // Keyboard play must work exactly like the real dial.
  await slider.focus();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "130");
  await page.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
  await expect(page.getByText("إصابة دقيقة في القلب")).toBeVisible();
  await expect(page.getByText(/3 من 3 نقاط/)).toBeVisible();
  expect(await zoneCount(page)).toBeGreaterThan(0);

  // Free play keeps a different authored card and hides its target until the answer is in.
  await page.getByRole("button", { name: "جرّب بنفسك", exact: true }).click();
  await expect(page.getByText("حفلة")).toBeVisible();
  expect(await zoneCount(page)).toBe(0);
  await page.getByRole("button", { name: "تأكيد الإجابة", exact: true }).click();
  expect(await zoneCount(page)).toBeGreaterThan(0);
  await expect(page.getByText(/خارج مناطق النقاط/)).toBeVisible();

  // Restart returns to the first step, and the written rules stay one tap away.
  await page.getByRole("tab", { name: "القواعد بالتفصيل" }).click();
  await expect(page.getByText("نقاط الوسيط")).toBeVisible();
  await page.getByRole("tab", { name: "جرّب جولة" }).click();
  await expect(page.getByRole("heading", { name: "جرّب بنفسك" })).toBeVisible();
});

test("practice survives reduced motion and closing restores focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 393, height: 852 });
  await openPractice(page);
  // Every teaching step is reachable without waiting for a decorative animation.
  await page.getByRole("button", { name: "التالي", exact: true }).click();
  await page.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
  await page.getByRole("slider").focus();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
  await expect(page.getByText(/من 3 نقاط/)).toBeVisible();
  // The teams demonstration keeps its state change without any motion.
  await page.getByRole("button", { name: "الفرق", exact: true }).click();
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("نقطة");
  await page.getByRole("button", { name: /الدور التالي/ }).click();
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("الصقور");
  await page.getByRole("button", { name: "إغلاق شرح اللعبة", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Focus returns to the control that opened the panel.
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "")).toContain(
    "شرح اللعبة",
  );
});

test("teaches both modes with real role wording and never emits gameplay events", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(suppressCoaching);
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  // Record everything the page sends so the practice round can be proven silent.
  await page.evaluate(() => {
    window.__hintEmits = [];
    const socket = window.__hintTest.socket;
    const emit = socket.emit.bind(socket);
    socket.emit = (...args) => {
      window.__hintEmits.push(args[0]);
      return emit(...args);
    };
  });
  await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
  await page.getByRole("button", { name: "الفرق", exact: true }).click();
  await page.getByRole("button", { name: "التالي", exact: true }).click();
  await page.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
  await page.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
  await expect(page.getByRole("heading", { name: "وضع الفرق" })).toBeVisible();
  // Each team row names its own psychic and designated answerer.
  await expect(page.getByText(/يثبت الإجابة/)).toHaveCount(2);
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("ريم");
  await expect(page.locator('.practice-team-row[data-team-turn="next"]')).toContainText("نورة");
  // The awarded points land in the scoring team's total before the turn moves on.
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("نقطة");
  await page.getByRole("button", { name: /الدور التالي/ }).click();
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("الصقور");
  await page.getByRole("button", { name: "كل لاعب", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الوضع الفردي" })).toBeVisible();
  const emits = await page.evaluate(() => window.__hintEmits);
  expect(emits).toEqual([]);
  expect(await page.evaluate(() => window.__hintTest.getState().roomCode)).toBeNull();
});

test("a live round continues behind help and is untouched after the practice round", async ({
  browser,
}) => {
  // Two people means two browser contexts: one shared profile would let the second tab take
  // over the first player's seat instead of joining its own.
  test.setTimeout(120_000);
  const contexts = await Promise.all([
    browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } }),
    browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } }),
  ]);
  const [owner, guest] = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    await owner.addInitScript(suppressCoaching);
    await owner.goto("/");
    await owner.waitForFunction(() => window.__hintTest?.socket.connected);
    await owner.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await owner.getByLabel("اسم اللاعب").fill("المضيف");
    await owner.getByRole("button", { name: "إنشاء غرفة", exact: true }).click();
    await expect(owner.getByText("انتظار اللاعبين")).toBeVisible();
    const roomCode = await owner.evaluate(() => window.__hintTest.getState().roomCode);
    await guest.addInitScript(suppressCoaching);
    await guest.goto(`/room/${roomCode}`);
    await guest.getByLabel("اسم اللاعب").fill("الضيف");
    await guest.getByLabel("كود الغرفة").fill(roomCode);
    await guest.getByRole("button", { name: "انضم", exact: true }).click();
    await expect(guest.getByText("انتظار اللاعبين")).toBeVisible();
    await owner.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await Promise.all(
      [owner, guest].map((page) =>
        page.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1),
      ),
    );
    const psychic = await owner.evaluate(
      () => window.__hintTest.getState().round.psychicId === window.__hintTest.getState().playerId,
    );
    const psychicPage = psychic ? owner : guest;
    const guesserPage = psychic ? guest : owner;

    // Open help mid-round, play the practice round, and leave the live round exactly as it was.
    const before = await guesserPage.evaluate(() => {
      const state = window.__hintTest.getState();
      return {
        round: state.round.roundNumber,
        cardId: state.round.card?.id ?? null,
        angle: state.round.myAngle,
        psychicId: state.round.psychicId,
        screen: state.currentScreen,
      };
    });
    await guesserPage.getByRole("button", { name: "قائمة اللعبة", exact: true }).click();
    await guesserPage.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
    await expect(guesserPage.getByText(/لا يوقف المباراة/)).toBeVisible();
    // The live dial sits behind the dialog, so every practice interaction is scoped to it.
    const practice = guesserPage.getByRole("dialog");
    await practice.getByRole("button", { name: "التالي", exact: true }).click();
    await practice.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
    await practice.getByRole("slider").focus();
    await guesserPage.keyboard.press("ArrowRight");
    await practice.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
    await expect(practice.getByText(/من 3 نقاط/)).toBeVisible();

    // The practice round stays open while the real match runs its whole cycle behind it:
    // the clue lands, the psychic reconnects, the guess is submitted, the reveal starts and
    // the host opens round two.
    await psychicPage.getByLabel("التلميح").fill("تلميح أثناء الشرح");
    await psychicPage.getByRole("button", { name: "أرسل التلميح", exact: true }).click();
    await expect(practice).toBeVisible();
    await psychicPage.reload();
    await psychicPage.waitForFunction((id) => {
      const state = window.__hintTest?.getState();
      return Boolean(
        state &&
        state.playerId === id &&
        state.connection === "connected" &&
        state.authoritativeRound > 0 &&
        state.round.clue,
      );
    }, before.psychicId);
    await expect(practice).toBeVisible();
    expect(
      await psychicPage.evaluate(() => window.__hintTest.getState().round.targetAngle),
    ).not.toBeNull();

    // The guesser finishes the round while the dialog is still open.
    await guesserPage.evaluate(() => {
      const state = window.__hintTest.getState();
      window.__hintTest.socket.emit("guess_submitted", {
        roomCode: state.roomCode,
        roundNumber: state.round.roundNumber,
        angle: 100,
        cardId: state.round.card?.id,
      });
    });
    await expect(owner.locator(".reveal-screen")).toBeVisible();
    await expect(practice).toBeVisible();
    await owner.getByRole("button", { name: "ابدأ الآن", exact: true }).click();
    await Promise.all(
      [owner, guest].map((page) =>
        page.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 2),
      ),
    );
    await expect(practice).toBeVisible();

    // Closing help returns to the live state that advanced behind it, not to a stale screen.
    await guesserPage.getByRole("button", { name: "إغلاق القائمة", exact: true }).click();
    await expect(guesserPage.getByRole("dialog")).toHaveCount(0);
    const live = await guesserPage.evaluate(() => {
      const state = window.__hintTest.getState();
      return {
        round: state.round.roundNumber,
        cardId: state.round.card?.id ?? null,
        clue: state.round.clue,
        psychicId: state.round.psychicId,
        controllerId: state.round.controllerId,
        activeTeamId: state.round.activeTeamId,
        screen: state.currentScreen,
        isPsychic: state.round.psychicId === state.playerId,
      };
    });
    const authoritative = await psychicPage.evaluate(() => {
      const state = window.__hintTest.getState();
      return {
        round: state.round.roundNumber,
        cardId: state.round.card?.id ?? null,
        clue: state.round.clue,
        psychicId: state.round.psychicId,
        controllerId: state.round.controllerId,
        activeTeamId: state.round.activeTeamId,
      };
    });
    // The visible state is the authoritative round, and the screen matches the held role.
    expect(live).toMatchObject(authoritative);
    expect(live.round).toBe(2);
    expect(live.screen).toBe(live.isPsychic ? "game-psychic" : "game-player");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("a loaded page still runs the practice round with no network", async ({ browser }) => {
  // The document is already in memory, so this proves only that the practice round needs no
  // backend round trip; it runs in both engines. Cached offline *reopening* of the practice
  // round is a separate production-build journey in tutorial-offline.spec.js.
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.addInitScript(suppressCoaching);
    await page.goto("/");
    await page.waitForFunction(() => window.__hintTest?.socket.connected);
    await context.setOffline(true);
    await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
    await expect(page.getByRole("heading", { name: "الوسيط يرى الهدف" })).toBeVisible();
    await page.getByRole("button", { name: "التالي", exact: true }).click();
    await page.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
    await page.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
    await expect(page.getByText(/من 3 نقاط/)).toBeVisible();
    await page.getByRole("button", { name: "جرّب بنفسك", exact: true }).click();
    await page.getByRole("button", { name: "تأكيد الإجابة", exact: true }).click();
    expect(await zoneCount(page)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
