import { test, expect } from "@playwright/test";

const saved = {
  roomCode: "Q9Q9",
  playerId: "previous-player",
  reconnectToken: "previous-token",
  displayName: "لاعب سابق",
  isOwner: false,
};

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

test("an old PWA visit opens fresh instead of recovering and prefilling the old room", async ({
  page,
}) => {
  await page.addInitScript((session) => {
    localStorage.setItem(
      "hint_session",
      JSON.stringify({ ...session, lastActiveAt: Date.now() - 31 * 60_000 }),
    );
  }, saved);
  await page.goto(`/room/${saved.roomCode}`);
  await expect(page.getByRole("button", { name: "ابدأ اللعبة" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await page.evaluate(() => localStorage.getItem("hint_session"))).toBeNull();
  await page.getByRole("button", { name: "ابدأ اللعبة" }).dispatchEvent("click");
  await expect(page.getByLabel("كود الغرفة")).toHaveValue("");
});

test("a rejected reconnect clears the old room address and input", async ({ page }) => {
  await page.addInitScript((session) => {
    localStorage.setItem("hint_session", JSON.stringify({ ...session, lastActiveAt: Date.now() }));
  }, saved);
  await page.goto(`/room/${saved.roomCode}`);
  await expect(page.getByRole("button", { name: "ابدأ اللعبة" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.getByRole("button", { name: "ابدأ اللعبة" }).dispatchEvent("click");
  await expect(page.getByLabel("كود الغرفة")).toHaveValue("");
  expect(await page.evaluate(() => localStorage.getItem("hint_session"))).toBeNull();
});

test("leaving from the in-game menu closes it before returning home", async ({ browser }) => {
  test.setTimeout(90_000);
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  try {
    await owner.addInitScript(suppressCoaching);
    await guest.addInitScript(suppressCoaching);
    await owner.goto("/");
    await owner.waitForFunction(() => window.__hintTest?.socket.connected);
    await owner.waitForFunction(() => window.__hintTest?.serverReadiness.getStatus() === "ready");
    await owner.getByRole("button", { name: "ابدأ اللعبة" }).click();
    await owner.getByLabel("اسم اللاعب").fill("خالد");
    await owner.getByRole("button", { name: "إنشاء غرفة", exact: true }).click();
    await expect(owner.getByText("انتظار اللاعبين")).toBeVisible();
    const roomCode = await owner.evaluate(() => window.__hintTest.getState().roomCode);

    await guest.goto(`/room/${roomCode}`);
    await guest.waitForFunction(() => window.__hintTest?.socket.connected);
    await guest.getByLabel("اسم اللاعب").fill("فهد");
    await guest.getByRole("button", { name: "انضم", exact: true }).click();
    await expect(guest.getByText("انتظار اللاعبين")).toBeVisible();
    await owner.getByRole("button", { name: "ابدأ اللعبة", exact: true }).click();
    await expect(guest.getByRole("button", { name: "قائمة اللعبة" })).toBeVisible();

    await guest.getByRole("button", { name: "قائمة اللعبة" }).click();
    await guest.getByRole("button", { name: "مغادرة الغرفة" }).click();
    await guest.getByRole("button", { name: "مغادرة", exact: true }).click();
    await expect(guest.getByRole("button", { name: "ابدأ اللعبة" })).toBeVisible();
    await expect(guest.getByRole("dialog")).toHaveCount(0);
    expect(new URL(guest.url()).pathname).toBe("/");
    expect(await guest.evaluate(() => localStorage.getItem("hint_session"))).toBeNull();
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});
