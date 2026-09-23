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
  // Creating a room needs the server, not only the socket: wait for its readiness probe too.
  await page.waitForFunction(() => window.__hintTest?.serverReadiness.getStatus() === "ready");
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

    // Both secondary actions show their short allowances inside the buttons.
    await expect(psychic.getByRole("button", { name: "تغيير مكان الإجابة" })).toBeEnabled();
    await expect(psychic.getByRole("button", { name: "تغيير البطاقة" })).toBeEnabled();
    await expect(psychic.getByText("متبقي: 3 من 3")).toBeVisible();
    await expect(psychic.getByText("1 مجاني لكل دور")).toBeVisible();
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
    await expect(psychic.locator(".dial-zone-labels")).toHaveCSS("visibility", "hidden");
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
    await expect(psychic.locator(".dial-zone-labels")).toHaveCSS("visibility", "visible");
    await expect(psychic.getByRole("button", { name: "تغيير مكان الإجابة" })).toBeDisabled();
    await expect(psychic.getByText("باقي 2 · الدور القادم")).toBeVisible();
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
    /**
     * The frame the reveal paints must still be stage zero. This is read once instead of
     * asserted with a retrying matcher: the regression this guards against corrects itself
     * when the first timer moves the stage, so only the first paint can prove it. The answer
     * zone itself is read for the failure output but not asserted: a slow engine may already
     * have crossed the 180ms zone stage by the time Playwright reads the DOM, which is not a
     * defect, while the later stages have hundreds of milliseconds of margin.
     */
    const firstFrame = await guesser.evaluate(() => ({
      zones: Boolean(document.querySelector(".dial-zones-reveal.is-visible")),
      closest: Boolean(document.querySelector(".reveal-closest.is-visible")),
      score: Boolean(document.querySelector(".reveal-score-card.is-visible")),
      handoffInert: document.querySelector(".reveal-handoff")?.hasAttribute("inert") ?? null,
      otherNeedles: document.querySelectorAll("g[data-player-id]").length > 1,
    }));
    expect(firstFrame.closest, JSON.stringify(firstFrame)).toBe(false);
    expect(firstFrame.score, JSON.stringify(firstFrame)).toBe(false);
    expect(firstFrame.handoffInert, JSON.stringify(firstFrame)).toBe(true);
    expect(firstFrame.otherNeedles, JSON.stringify(firstFrame)).toBe(false);
    const stageAfter = await guesser.locator(".dial-stage").boundingBox();
    const dialAfter = await guesser.locator(".dial-svg").boundingBox();
    expect(Math.abs(stageAfter.y - stageBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialAfter.y - dialBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialAfter.width - dialBefore.width)).toBeLessThanOrEqual(1);

    await expect(guesser.locator(".reveal-score-card")).toContainText("+3");
    // The stages then arrive in order, each one only after the previous one is on screen.
    // Their exact spacing is asserted deterministically in the client unit tests, because a
    // background tab has its own timers throttled by the browser.
    await expect(guesser.locator(".dial-zones-reveal")).toHaveClass(/is-visible/);
    await expect(guesser.locator(".reveal-score-card")).toHaveClass(/is-visible/);
    await expect(guesser.locator(".reveal-handoff")).not.toHaveAttribute("inert", "");
    const scored = await snapshot(guesser);
    expect(scored.scores.some((player) => player.score > 0)).toBe(true);
  } finally {
    await ownerContext.close();
    await guestContext.close();
    await spectatorContext.close();
  }
});

test("a reconnected reveal opens settled without replaying the move or the sequence", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const owner = await ownerContext.newPage();
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
    const guesser = ownerIsPsychic ? guest : owner;

    // Move the position, then play the turn out so the round is revealed.
    await psychic.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
    await psychic.waitForFunction(
      () => window.__hintTest.getState().round.targetRedraw.revision === 1,
    );
    const target = await psychic.evaluate(() => window.__hintTest.getState().round.targetAngle);
    await psychic.getByLabel("التلميح").fill("تلميح للموضع الجديد");
    await psychic.getByRole("button", { name: "أرسل التلميح" }).click();
    await guesser.waitForFunction(() => window.__hintTest.getState().round.clue !== null);
    await dragDialTo(guesser, target);
    await guesser.getByRole("button", { name: "تأكيد الإجابة" }).click();
    await expect(guesser.locator(".reveal-score-card")).toHaveClass(/is-visible/);
    await expect(psychic.locator(".reveal-score-card")).toHaveClass(/is-visible/);

    /**
     * The clue giver's own page still holds the confirmed move, so its dial must keep the
     * authoritative angle without another sweep, without hiding the numbers and without a
     * landing pulse while the connection is restored.
     */
    const dialState = () =>
      psychic.evaluate(() => {
        const rotor = document.querySelector(".dial-zones-rotor");
        const labels = document.querySelector(".dial-zone-labels");
        return {
          style: rotor?.getAttribute("style") ?? null,
          moving: Boolean(rotor?.classList.contains("is-moving")),
          landing: Boolean(rotor?.classList.contains("is-landing")),
          labelsMoving: Boolean(labels?.classList.contains("is-moving")),
          scoreVisible: Boolean(document.querySelector(".reveal-score-card.is-visible")),
        };
      });

    // A reconnect on the open page must not replay the move or restart the settled sequence.
    await psychic.evaluate(() => {
      window.__hintTest.socket.disconnect();
      window.__hintTest.socket.connect();
    });
    await psychic.waitForFunction(
      () =>
        window.__hintTest?.getState().connection === "connected" &&
        window.__hintTest.getState().authoritativeRound > 0,
    );
    const rotation = Number(
      /rotate\((-?[\d.]+)deg\)/.exec(
        (await psychic.locator(".dial-zones-rotor").getAttribute("style")) ?? "",
      )?.[1],
    );
    expect(Math.abs(rotation - (target - 90))).toBeLessThan(0.01);
    await expect(psychic.locator(".reveal-score-card")).toHaveClass(/is-visible/);
    expect(await psychic.evaluate(() => window.__hintTest.getState().revealFresh)).toBe(false);
    // Sampled for well over one settle: the position may never move, blink or pulse again.
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      samples.push(await dialState());
      await psychic.waitForTimeout(100);
    }
    expect(new Set(samples.map((sample) => sample.style)).size).toBe(1);
    expect(samples.filter((sample) => sample.moving)).toEqual([]);
    expect(samples.filter((sample) => sample.landing)).toEqual([]);
    expect(samples.filter((sample) => sample.labelsMoving)).toEqual([]);
    expect(samples.filter((sample) => !sample.scoreVisible)).toEqual([]);

    // A reload restores the same settled result on the other page.
    await guesser.reload();
    await guesser.waitForFunction(
      () =>
        window.__hintTest?.getState().connection === "connected" &&
        window.__hintTest.getState().revealData !== null,
    );
    await expect(guesser.locator(".reveal-score-card")).toHaveClass(/is-visible/);
    await expect(guesser.locator(".reveal-handoff")).toHaveClass(/is-visible/);
    expect(await guesser.evaluate(() => window.__hintTest.getState().revealFresh)).toBe(false);
  } finally {
    await ownerContext.close();
    await guestContext.close();
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
        psychicPage.getByText(round === 3 ? "متبقي: 2 من 3" : "متبقي: 3 من 3"),
      ).toBeVisible();
      if (round === 1 || round === 2) {
        await psychicPage.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
        await psychicPage.waitForFunction(
          () => window.__hintTest.getState().round.targetRedraw.revision === 1,
        );
        await expect(psychicPage.getByText("باقي 2 · الدور القادم")).toBeVisible();
      } else {
        // The same team returned: its spent use stayed spent, and this turn may spend another.
        expect(teamsByTurn[0]).toBe(activeTeamId);
        await psychicPage.getByRole("button", { name: "تغيير مكان الإجابة" }).click();
        await psychicPage.waitForFunction(
          () => window.__hintTest.getState().round.targetRedraw.revision === 1,
        );
        await expect(psychicPage.getByText("باقي 1 · الدور القادم")).toBeVisible();
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
  const guestContext = await browser.newContext({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
  });
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
    expect(psychic.viewportSize()?.width).toBe(320);
    await expect(psychic.getByRole("button", { name: "تغيير مكان الإجابة" })).toBeVisible();
    await expect(psychic.getByText("متبقي: 3 من 3")).toBeVisible();
    await expect(psychic.getByText("1 مجاني لكل دور")).toBeVisible();
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
