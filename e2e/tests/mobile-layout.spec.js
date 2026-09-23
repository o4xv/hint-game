import { test, expect } from "@playwright/test";

/**
 * Phone layout regressions from the installed-PWA playtest: a rename control that was invisible
 * on a white card, a start action floating over the roster, a detached timer, repeated waiting
 * text, an oversized waiting clue card and a scoreboard highlight clipped by its scroll box.
 *
 * These are box measurements, not presence checks: an element can "be visible" and still sit
 * under another one, outside the viewport or against an edge.
 */

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

async function enterHome(page, name) {
  await page.addInitScript(suppressCoaching);
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
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

async function noHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, JSON.stringify(widths)).toBeLessThanOrEqual(widths.client + 1);
}

async function box(locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect;
}

async function expectInViewport(locator, { minHeight = 44 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const rect = await box(locator);
  const viewport = locator.page().viewportSize();
  expect(rect.height, "touch target").toBeGreaterThanOrEqual(minHeight - 0.5);
  expect(rect.y).toBeGreaterThanOrEqual(-0.5);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 0.5);
}

/**
 * Where the dial's handle sits for a given angle, in CSS pixels. The dial's viewBox starts at
 * -12 and is 404 units wide, with its pivot at (190, 190) and a 180-unit radius.
 */
async function dialPoint(page, angle) {
  const box = await page.locator(".practice .dial-svg").boundingBox();
  if (!box) throw new Error("missing dial");
  const scale = box.width / 404;
  const cx = box.x + (190 + 12) * scale;
  const cy = box.y + (190 + 12) * scale;
  const radius = 180 * scale;
  const radians = (angle * Math.PI) / 180;
  return { x: cx - radius * Math.cos(radians), y: cy - radius * Math.sin(radians) };
}

/** What actually receives a touch at a point, and whether the footer owns it. */
function hitTest(page, point) {
  return page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    const dial = document.querySelector(".practice .dial-svg");
    const footer = document.querySelector(".practice-actions");
    return {
      dial: Boolean(top && dial && dial.contains(top)),
      footer: Boolean(top && footer && footer.contains(top)),
      target: top ? `${top.tagName.toLowerCase()}.${top.getAttribute("class") ?? ""}` : "none",
    };
  }, point);
}

async function openPracticeGuessingStep(page) {
  await page.addInitScript(suppressCoaching);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
  const practice = page.getByRole("dialog");
  await practice.getByRole("button", { name: "التالي", exact: true }).click();
  await practice.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
  return practice;
}

test("a short screen scrolls the lesson body and keeps the footer reachable", async ({ page }) => {
  await page.addInitScript(suppressCoaching);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
  const practice = page.getByRole("dialog");
  await practice.getByRole("button", { name: "التالي", exact: true }).click();
  await practice.getByRole("button", { name: "جرّب التخمين", exact: true }).click();

  // The lesson scrolls; the footer keeps its own space and never leaves the screen.
  await expectInViewport(page.getByRole("button", { name: "اكشف الهدف", exact: true }));
  const scrolled = await page.locator(".practice-body").evaluate((element) => ({
    scroll: element.scrollHeight,
    client: element.clientHeight,
  }));
  expect(scrolled.scroll, JSON.stringify(scrolled)).toBeGreaterThan(scrolled.client);

  // Scrolling the lesson brings the whole dial above the footer.
  await page.locator(".practice .dial-svg").scrollIntoViewIfNeeded();
  const dial = await box(page.locator(".practice .dial-svg"));
  const body = await box(page.locator(".practice-body"));
  const footer = await box(page.locator(".practice-actions"));
  expect(dial.y).toBeGreaterThanOrEqual(body.y - 0.5);
  expect(dial.y + dial.height).toBeLessThanOrEqual(footer.y + 0.5);
  await noHorizontalOverflow(page);

  // Enlarged text keeps the same promise: the body scrolls, the action stays usable.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  const enlarged = await page.locator(".practice-body").evaluate((element) => ({
    scroll: element.scrollHeight,
    client: element.clientHeight,
  }));
  expect(enlarged.scroll, JSON.stringify(enlarged)).toBeGreaterThan(enlarged.client);
  await expectInViewport(page.getByRole("button", { name: "اكشف الهدف", exact: true }));
  await noHorizontalOverflow(page);
});

for (const reduced of [false, true]) {
  const label = reduced ? "reduced motion" : "ordinary motion";
  test(`the practice footer keeps the whole dial clear (${label})`, async ({ page }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
    const practice = await openPracticeGuessingStep(page);
    const slider = practice.getByRole("slider");

    // The dial must arrive fully visible, without scrolling the lesson first.
    const dialStage = await box(page.locator(".practice .dial-stage"));
    const body = await box(page.locator(".practice-body"));
    const footer = await box(page.locator(".practice-actions"));
    const parts = {
      head: await box(page.locator(".practice-head")),
      heading: await box(page.locator(".practice-heading")),
      spectrum: await box(page.locator(".practice .spectrum-card")),
      clue: await box(page.locator(".practice .round-clue-card")),
      hint: await box(page.locator(".practice-hint")),
      stage: dialStage,
      svg: await box(page.locator(".practice .dial-svg")),
      body,
      footer,
    };
    expect(dialStage.y + dialStage.height, JSON.stringify(parts)).toBeLessThanOrEqual(
      body.y + body.height + 0.5,
    );
    expect(dialStage.y + dialStage.height).toBeLessThanOrEqual(footer.y + 0.5);

    for (const angle of [0, 90, 180]) {
      // Real pointer input at the endpoint the user would touch.
      const target = await dialPoint(page, angle);
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      await page.mouse.move(target.x + 0.5, target.y + 0.5, { steps: 2 });
      await page.mouse.up();
      const value = Number(await slider.getAttribute("aria-valuenow"));
      expect(
        Math.abs(value - angle),
        `${angle}° pointer drag landed on ${value}°`,
      ).toBeLessThanOrEqual(3);

      // The handle the drag just placed must be the topmost thing at its own centre.
      const handle = await dialPoint(page, value);
      const hit = await hitTest(page, handle);
      expect(hit.footer, `${angle}° handle was covered by ${hit.target}`).toBe(false);
      expect(hit.dial, `${angle}° handle hit ${hit.target} instead of the dial`).toBe(true);
    }

    // Playing with the dial never reveals the answer by itself.
    await expect(page.locator(".practice-reveal")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "اكشف الهدف", exact: true })).toBeVisible();
  });

  test(`touching the dial endpoints never reveals the answer (${label})`, async ({ page }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
    const practice = await openPracticeGuessingStep(page);
    const slider = practice.getByRole("slider");
    for (const angle of [0, 180, 90]) {
      const target = await dialPoint(page, angle);
      await page.touchscreen.tap(target.x, target.y);
      const value = Number(await slider.getAttribute("aria-valuenow"));
      expect(Math.abs(value - angle), `${angle}° tap landed on ${value}°`).toBeLessThanOrEqual(3);
      const hit = await hitTest(page, await dialPoint(page, value));
      expect(hit.footer, `${angle}° touch was covered by ${hit.target}`).toBe(false);
    }
    await expect(page.locator(".practice-reveal")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "اكشف الهدف", exact: true })).toBeVisible();
  });
}

/** Relative luminance contrast, so "the control is readable" is a measurement. */
function contrast(foreground, background) {
  const parse = (value) => value.match(/\d+/g).map(Number);
  const luminance = (value) => {
    const [r, g, b] = parse(value).map((channel) => {
      const scaled = channel / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [first, second] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (first + 0.05) / (second + 0.05);
}

test("the lobby keeps rename readable, cards compact and the start action clear of the roster", async ({
  browser,
}) => {
  test.setTimeout(120_000);
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
    const roomCode = await enterHome(pages[0], "أبو مالك");
    await joinRoom(pages[1], roomCode, "tm44z");
    await joinRoom(pages[2], roomCode, "حمود الشمري");
    await joinRoom(pages[3], roomCode, "ريان");
    await pages[0].locator(".lobby-settings-disclosure > summary").click();
    await pages[0].getByRole("button", { name: "فرق", exact: true }).click();
    await pages[0].waitForFunction(() => window.__hintTest.getState().gameMode === "teams");

    const edit = pages[0].locator('[data-team-id="team-1"] .team-name-edit');
    await expect(edit).toBeVisible();
    await expectInViewport(edit);
    const styles = await edit.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor };
    });
    // The button sits on a white card: white-on-transparent was the reported defect.
    expect(contrast(styles.color, "rgb(255, 255, 255)")).toBeGreaterThan(4.5);

    // A compact header keeps the card short instead of one control per row.
    const header = await box(pages[0].locator('[data-team-id="team-1"] .team-card-header'));
    expect(header.height).toBeLessThanOrEqual(64);
    const memberRow = await box(
      pages[0].locator('[data-team-id="team-1"] .team-members li').first(),
    );
    expect(memberRow.height).toBeLessThanOrEqual(40);

    const start = pages[0].getByRole("button", { name: "ابدأ اللعبة", exact: true });
    await expectInViewport(start);
    const bar = await pages[0].locator(".lobby-action-bar").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, position: style.position };
    });
    // The bar must be an opaque surface; a floating button over the roster was the defect.
    expect(bar.position).toBe("sticky");
    expect(bar.background).not.toBe("rgba(0, 0, 0, 0)");

    const chip = await box(pages[0].locator(".lobby-player-grid .player-badge").first());
    expect(chip.height).toBeLessThanOrEqual(100);
    await noHorizontalOverflow(pages[0]);

    // Enlarged text must not introduce sideways scrolling or hide the primary action.
    await pages[0].evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await noHorizontalOverflow(pages[0]);
    await expectInViewport(start);
    await pages[0].evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("the game header anchors the timer and keeps one explanation per role", async ({
  browser,
}) => {
  test.setTimeout(120_000);
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
    const roomCode = await enterHome(pages[0], "أبو مالك");
    await joinRoom(pages[1], roomCode, "tm44z");
    await joinRoom(pages[2], roomCode, "حمود الشمري");
    await joinRoom(pages[3], roomCode, "ريان");
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
          return state.round.psychicId === state.playerId;
        }),
      ),
    );
    const psychic = pages[roles.findIndex(Boolean)];

    // The header owns its own 6px rhythm; the safe-area inset belongs to the shell alone.
    const headerPadding = await psychic
      .locator(".game-header")
      .evaluate((element) => getComputedStyle(element).paddingTop);
    expect(headerPadding).toBe("6px");

    // The concise allowance is visible inside the button; the detailed reason stays accessible.
    await expect(psychic.getByText("1 مجاني لكل دور")).toBeVisible();
    await expect(psychic.locator("#card-redraw-note.sr-only")).toHaveCount(1);
    expect(await psychic.locator("#card-redraw-note").textContent()).toMatch(/تغيير/);
    const statusText = await psychic.locator(".round-status-state").textContent();
    expect(statusText ?? "").not.toContain("تغيير");

    await expectInViewport(psychic.getByRole("button", { name: "أرسل التلميح", exact: true }));
    for (const action of await psychic.locator(".psychic-secondary-actions .btn").all())
      await expectInViewport(action);
    await noHorizontalOverflow(psychic);

    await psychic.getByLabel("التلميح").fill("شاي ساخن جداً");
    await psychic.getByRole("button", { name: "أرسل التلميح", exact: true }).click();
    await expect(psychic.locator(".game-header-timer .timer")).toBeVisible();
    const headerBox = await box(psychic.locator(".game-header"));
    const timerBox = await box(psychic.locator(".game-header-timer"));
    // The countdown sits with the round it belongs to, not against the screen edge.
    expect(timerBox.width).toBeGreaterThan(20);
    expect(timerBox.x).toBeGreaterThanOrEqual(headerBox.x + 4);
    expect(timerBox.x + timerBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("the practice round spans, fits and demonstrates the team turn on a phone", async ({
  page,
}) => {
  await page.addInitScript(suppressCoaching);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await page.waitForFunction(() => window.__hintTest?.socket.connected);
  await page.getByRole("button", { name: "شرح اللعبة", exact: true }).click();
  await expect(page.getByRole("heading", { name: "الوسيط يرى الهدف" })).toBeVisible();

  // The shared cards keep their intrinsic layout inside the practice panel.
  const spectrum = await box(page.locator(".practice .spectrum-card"));
  const endpoints = await page.locator(".practice .spectrum-card > span").all();
  const [right, left] = await Promise.all(endpoints.map((endpoint) => box(endpoint)));
  expect(right.x).toBeGreaterThan(spectrum.x + spectrum.width / 2);
  expect(left.x + left.width).toBeLessThan(spectrum.x + spectrum.width / 2);
  expect(spectrum.height).toBeLessThanOrEqual(90);
  const clue = await box(page.locator(".practice .round-clue-card"));
  expect(clue.height).toBeLessThanOrEqual(110);

  // Navigation stays reachable without scrolling past the lesson.
  await expectInViewport(page.getByRole("button", { name: "التالي", exact: true }));
  await expectInViewport(page.getByRole("button", { name: "السابق", exact: true }));
  await expectInViewport(page.getByRole("button", { name: "إعادة من البداية", exact: true }));
  await noHorizontalOverflow(page);

  // The teams demonstration adds the points to the total and then moves the turn.
  await page.getByRole("button", { name: "التالي", exact: true }).click();
  await page.getByRole("button", { name: "الفرق", exact: true }).click();
  await page.getByRole("button", { name: "جرّب التخمين", exact: true }).click();
  const slider = page.getByRole("slider");
  await slider.focus();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "اكشف الهدف", exact: true }).click();
  const activeRow = page.locator('.practice-team-row[data-team-turn="now"]');
  await expect(activeRow).toContainText("3 نقطة");
  await expect(activeRow).toContainText("+3");
  await expect(page.getByRole("button", { name: "جرّب بنفسك", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /الدور التالي/ }).click();
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("الصقور");
  await expect(page.locator('.practice-team-row[data-team-turn="now"]')).toContainText("نورة");
  await expect(page.locator('.practice-team-row[data-team-turn="next"]')).toContainText("3 نقطة");
  await noHorizontalOverflow(page);
});

test("the scoreboard highlight survives its scroll box and rows stay even", async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([
    browser.newContext({ serviceWorkers: "block", viewport: { width: 393, height: 852 } }),
    browser.newContext({ serviceWorkers: "block", viewport: { width: 393, height: 852 } }),
    browser.newContext({ serviceWorkers: "block", viewport: { width: 393, height: 852 } }),
    browser.newContext({ serviceWorkers: "block", viewport: { width: 393, height: 852 } }),
  ]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    const roomCode = await enterHome(pages[0], "أبو مالك");
    await joinRoom(pages[1], roomCode, "tm44z");
    await joinRoom(pages[2], roomCode, "حمود الشمري");
    await joinRoom(pages[3], roomCode, "اللاعب 4 صاحب الاسم الطويل جداً");
    await pages[0].locator(".lobby-settings-disclosure > summary").click();
    await pages[0].getByRole("button", { name: "فرق", exact: true }).click();
    await pages[0].waitForFunction(() => window.__hintTest.getState().gameMode === "teams");
    await pages[0].getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1),
      ),
    );
    const psychic =
      pages[
        (
          await Promise.all(
            pages.map((page) =>
              page.evaluate(
                () =>
                  window.__hintTest.getState().round.psychicId ===
                  window.__hintTest.getState().playerId,
              ),
            ),
          )
        ).findIndex(Boolean)
      ];
    await psychic.getByLabel("التلميح").fill("تلميح قصير");
    await psychic.getByRole("button", { name: "أرسل التلميح", exact: true }).click();
    await pages[0].getByRole("button", { name: "قائمة اللعبة", exact: true }).click();
    await pages[0].getByRole("button", { name: "لوحة النتائج", exact: true }).click();

    const dialog = await box(pages[0].locator(".react-dialog"));
    const viewport = pages[0].viewportSize();
    expect(dialog.y).toBeGreaterThanOrEqual(0);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(viewport.height + 0.5);
    await expectInViewport(pages[0].getByRole("button", { name: "إغلاق القائمة", exact: true }));

    const mine = pages[0].locator(".scoreboard-row.is-mine");
    await expect(mine).toBeVisible();
    const shadow = await mine.evaluate((element) => {
      const style = getComputedStyle(element);
      return { boxShadow: style.boxShadow, outline: style.outlineStyle };
    });
    // An outside outline is clipped by the scroll container; an inset ring is not.
    expect(shadow.boxShadow).toContain("inset");
    expect(shadow.outline).toBe("none");

    const rowBoxes = [];
    for (const row of await pages[0].locator(".scoreboard-row:not(.scoreboard-header)").all())
      rowBoxes.push(await box(row));
    const tallest = Math.max(...rowBoxes.map((rect) => rect.height));
    const shortest = Math.min(...rowBoxes.map((rect) => rect.height));
    expect(tallest - shortest).toBeLessThanOrEqual(24);
    // The name column must stay usable with long Arabic names.
    for (const name of await pages[0].locator(".scoreboard-entry-name").all()) {
      const metrics = await name.evaluate((element) => ({
        scroll: element.scrollWidth,
        width: element.clientWidth,
      }));
      expect(metrics.scroll, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.width + 1);
    }
    await noHorizontalOverflow(pages[0]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
