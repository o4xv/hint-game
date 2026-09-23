import { test, expect } from "@playwright/test";

/**
 * The answer-position change: one use per turn, three per player or team for the match, and
 * never a whisper of the new position to anyone but the clue giver.
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

function snapshot(page) {
  return page.evaluate(() => {
    const state = window.__hintTest.getState();
    return {
      roundNumber: state.round.roundNumber,
      angle: state.round.targetAngle,
      cardId: state.round.card?.id ?? null,
      timerEndsAt: state.round.timerEndsAt,
      targetRedraw: state.round.targetRedraw,
      psychicId: state.round.psychicId,
      playerId: state.playerId,
      scores: state.players.map((player) => ({ id: player.id, score: player.score })),
      teams: state.teams.map((team) => ({ id: team.id, score: team.score })),
      activeTeamId: state.round.activeTeamId,
      controllerId: state.round.controllerId,
    };
  });
}

/** Drags the dial so the needle lands on an exact angle, using the real pointer pipeline. */
async function dragDialTo(page, angle, { release = true } = {}) {
  const point = await page.locator(".dial-svg").evaluate((svg, target) => {
    const rect = svg.getBoundingClientRect();
    const radians = (target * Math.PI) / 180;
    // Mirror of dialGeometry.pointOnDial, expressed back into client coordinates.
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
  if (release) await page.mouse.up();
  return point;
}

test("an individual clue giver changes the answer position and the round still scores", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const spectatorContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  try {
    const roomCode = await createRoom(owner, "ريم");
    await joinRoom(guest, roomCode, "خالد");
    // The psychic timer is on, so the change can be checked against a live deadline.
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
    const before = await snapshot(psychic);
    expect(before.targetRedraw.supported).toBe(true);
    expect(before.targetRedraw).toMatchObject({ remaining: 3, usedThisRound: false, revision: 0 });

    // Both secondary actions are offered with equal weight, and their own explanations.
    await expect(psychic.getByRole("button", { name: "تغيير مكان الإجابة" })).toBeEnabled();
    await expect(psychic.getByRole("button", { name: "تغيير البطاقة" })).toBeEnabled();
    await expect(psychic.getByText("لك: ٣ / ٣")).toBeVisible();
    await expect(psychic.getByText(/مرة واحدة في الدور/)).toBeVisible();
    expect(await guesser.evaluate(() => window.__hintTest.getState().round.targetAngle)).toBeNull();

    const spectator = await spectatorContext.newPage();
    await spectator.goto(`/watch/${roomCode}`);
    await spectator.waitForFunction(() => window.__hintTest?.getState().isSpectator === true);
    expect(
      await spectator.evaluate(() => window.__hintTest.getState().round.targetAngle ?? null),
    ).toBeNull();

    // Read the position again immediately before the click: the request must be judged
    // against what the server holds at that instant.
    const immediate = await snapshot(psychic);
    expect(immediate.angle).toBe(before.angle);
    await psychic.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
    await psychic.waitForFunction(
      () => window.__hintTest.getState().round.targetRedraw.revision === 1,
    );
    const after = await snapshot(psychic);
    expect(Math.abs(after.angle - before.angle)).toBeGreaterThanOrEqual(45);
    expect(after.angle).toBeGreaterThanOrEqual(6);
    expect(after.angle).toBeLessThanOrEqual(174);
    expect(after.cardId).toBe(before.cardId);
    expect(after.timerEndsAt).toBe(before.timerEndsAt);
    expect(after.psychicId).toBe(before.psychicId);
    expect(after.targetRedraw).toMatchObject({ remaining: 2, usedThisRound: true, revision: 1 });
    expect(after.scores).toEqual(before.scores);

    // The confirmed position is what the scoring bands are pinned to, and the control closes.
    const rotor = await psychic.locator(".dial-zones-rotor").getAttribute("style");
    const rotation = Number(/rotate\((-?[\d.]+)deg\)/.exec(rotor ?? "")?.[1]);
    expect(Math.abs(rotation - (after.angle - 90))).toBeLessThan(0.01);
    await expect(psychic.locator(".dial-zones-rotor")).not.toHaveClass(/is-moving/);
    // The scoring numbers stay upright instead of rotating with the bands.
    await expect(psychic.locator(".dial-zone-labels")).toHaveClass(/is-visible/);
    await expect(psychic.getByRole("button", { name: "تغيير مكان الإجابة" })).toBeDisabled();
    await expect(psychic.getByText("استُخدم تغيير المكان في هذا الدور.")).toBeVisible();
    // The other players still know nothing about the new position.
    expect(await guesser.evaluate(() => window.__hintTest.getState().round.targetAngle)).toBeNull();

    await psychic.getByLabel("التلميح").fill("تلميح للموضع الجديد");
    await psychic.getByRole("button", { name: "أرسل التلميح" }).click();
    await guesser.waitForFunction(() => window.__hintTest.getState().round.clue !== null);

    // The dial keeps its place between guessing and reveal.
    const stageBefore = await guesser.locator(".dial-stage").boundingBox();
    const dialBefore = await guesser.locator(".dial-svg").boundingBox();
    await dragDialTo(guesser, after.angle);
    await guesser.getByRole("button", { name: "تأكيد الإجابة" }).click();
    await expect(guesser.locator(".reveal-screen")).toBeVisible();
    const stageAfter = await guesser.locator(".dial-stage").boundingBox();
    const dialAfter = await guesser.locator(".dial-svg").boundingBox();
    expect(Math.abs(stageAfter.y - stageBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialAfter.y - dialBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialAfter.width - dialBefore.width)).toBeLessThanOrEqual(1);

    await expect(guesser.locator(".reveal-score-card")).toContainText("+3");
    const scored = await snapshot(guesser);
    expect(scored.scores.some((player) => player.score > 0)).toBe(true);
  } finally {
    await ownerContext.close();
    await guestContext.close();
    await spectatorContext.close();
  }
});

test("a team shares one allowance across turns and keeps it away from other teams", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
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

    const teamsByTurn = [];
    for (const round of [1, 2, 3]) {
      await Promise.all(
        pages.map((page) =>
          page.waitForFunction(
            (number) => window.__hintTest.getState().round.roundNumber === number,
            round,
          ),
        ),
      );
      const states = await Promise.all(pages.map((page) => snapshot(page)));
      const psychicIndex = states.findIndex((state) => state.psychicId === state.playerId);
      const controllerIndex = states.findIndex((state) => state.controllerId === state.playerId);
      const psychicPage = pages[psychicIndex];
      const controllerPage = pages[controllerIndex];
      const activeTeamId = states[psychicIndex].activeTeamId;
      teamsByTurn.push(activeTeamId);

      await expect(
        psychicPage.getByText(round === 3 ? "للفريق: ٢ / ٣" : "للفريق: ٣ / ٣"),
      ).toBeVisible();
      await expect(psychicPage.getByText(/وبحد أقصى ٣ مرات لفريقك خلال المباراة/)).toBeVisible();
      if (round === 1 || round === 2) {
        await psychicPage.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
        await psychicPage.waitForFunction(
          () => window.__hintTest.getState().round.targetRedraw.revision === 1,
        );
        await expect(psychicPage.getByText("للفريق: ٢ / ٣")).toBeVisible();
      } else {
        // The same team returned: its spent use stayed spent, and this turn may spend another.
        expect(teamsByTurn[0]).toBe(activeTeamId);
        await psychicPage.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
        await psychicPage.waitForFunction(
          () => window.__hintTest.getState().round.targetRedraw.revision === 1,
        );
        await expect(psychicPage.getByText("للفريق: ١ / ٣")).toBeVisible();
      }
      // Only the active team pays, and the other team keeps its own full allowance.
      const changed = await snapshot(psychicPage);
      const otherTeam = changed.teams.find((team) => team.id !== activeTeamId);
      expect(changed.teams.find((team) => team.id === activeTeamId).score).toBe(
        states[psychicIndex].teams.find((team) => team.id === activeTeamId).score,
      );
      expect(otherTeam).toBeTruthy();

      await psychicPage.getByLabel("التلميح").fill(`تلميح الجولة ${round}`);
      await psychicPage.getByRole("button", { name: "أرسل التلميح" }).click();
      await controllerPage.getByRole("button", { name: "تأكيد الإجابة" }).click();
      await expect(pages[0].locator(".reveal-screen")).toBeVisible();
    }

    expect(new Set(teamsByTurn.slice(0, 2)).size).toBe(2);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("the new labels fit a narrow phone without overflow", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
  });
  const owner = await context.newPage();
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    const roomCode = await createRoom(owner, "ريم");
    await joinRoom(guest, roomCode, "خالد");
    await owner.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await owner.waitForFunction(() => window.__hintTest.getState().round.roundNumber === 1);
    const ownerIsPsychic = await owner.evaluate(
      () => window.__hintTest.getState().round.psychicId === window.__hintTest.getState().playerId,
    );
    const psychic = ownerIsPsychic ? owner : guest;
    await expect(psychic.getByRole("button", { name: "تغيير مكان الإجابة" })).toBeVisible();
    const overflow = await psychic.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const name of ["تغيير مكان الإجابة", "تغيير البطاقة"]) {
      const box = await psychic.getByRole("button", { name }).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(46);
    }
  } finally {
    await context.close();
    await guestContext.close();
  }
});
