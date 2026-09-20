// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { pointsForGuess } from "@hint/contracts";
import {
  FREE_PRACTICE_CARDS,
  HelpPanel,
  PRACTICE_INPUTS,
  PracticeWalkthrough,
  practiceResultText,
} from "../src/ui/Tutorial";
import { GameProvider } from "../src/ui/GameContext";
import { createSessionStore, initialSession } from "../src/session/store";

afterEach(cleanup);

function targetsOnDial() {
  return document.querySelectorAll(".dial-zone").length;
}

function nextStep() {
  fireEvent.click(screen.getByRole("button", { name: "التالي" }));
}

function walkToReveal() {
  nextStep();
  fireEvent.click(screen.getByRole("button", { name: "جرّب التخمين" }));
  fireEvent.click(screen.getByRole("button", { name: "اكشف الهدف" }));
}

it("walks the four steps with the real spectrum, clue card and dial", () => {
  render(<PracticeWalkthrough />);
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();
  expect(screen.getByText("بارد")).toBeTruthy();
  expect(screen.getByText("حار")).toBeTruthy();
  // Step one is the psychic's view: the secret zones are visible, with no needle to place.
  expect(targetsOnDial()).toBeGreaterThan(0);
  expect(screen.queryByRole("slider")).toBeNull();

  nextStep();
  expect(screen.getByText("الوسيط يعطي تلميحاً")).toBeTruthy();
  expect(screen.getByText("شاي ساخن")).toBeTruthy();
  // The guesser never sees the target before answering.
  expect(targetsOnDial()).toBe(0);

  fireEvent.click(screen.getByRole("button", { name: "جرّب التخمين" }));
  expect(screen.getByRole("slider")).toBeTruthy();
  expect(targetsOnDial()).toBe(0);

  fireEvent.click(screen.getByRole("button", { name: "اكشف الهدف" }));
  expect(screen.getByText("نكشف الهدف ونحسب النقاط")).toBeTruthy();
  expect(targetsOnDial()).toBeGreaterThan(0);
  // The authored walkthrough starts at the middle of the scale, 40° away from the target.
  expect(pointsForGuess(90, 130)).toBe(0);
  expect(screen.getByText(practiceResultText(0))).toBeTruthy();
  expect(screen.getByText("0 من 3 نقاط — لا بأس، هذه تجربة")).toBeTruthy();
});

it("keeps the target out of the accessibility tree until the reveal", () => {
  render(<PracticeWalkthrough />);
  const psychicView = screen.getByRole("img");
  expect(psychicView.getAttribute("aria-label")).toBe("مقياس الجولة");
  expect(psychicView.getAttribute("aria-label")).not.toContain("130");

  nextStep();
  expect(document.querySelectorAll(".dial-zone")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "جرّب التخمين" }));
  const slider = screen.getByRole("slider");
  expect(slider.getAttribute("aria-valuenow")).toBe("90");
  expect(slider.getAttribute("aria-valuetext")).not.toContain("130");
  expect(document.querySelectorAll(".dial-zone")).toHaveLength(0);
});

it("lets the keyboard move the needle and scores the free-play answer honestly", () => {
  render(<PracticeWalkthrough />);
  walkToReveal();
  fireEvent.click(screen.getByRole("button", { name: "جرّب بنفسك" }));
  expect(screen.getByText("جرّب بنفسك")).toBeTruthy();
  // Free play starts on a different authored card, and its target stays hidden.
  expect(screen.getByText("حفلة")).toBeTruthy();
  expect(document.querySelectorAll(".dial-zone")).toHaveLength(0);

  const slider = screen.getByRole("slider");
  expect(slider.getAttribute("aria-valuenow")).toBe("90");
  // Six shifted steps land on 150°, two degrees from this card's authored target of 152°.
  for (let index = 0; index < 6; index += 1)
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
  expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("150");

  fireEvent.click(screen.getByRole("button", { name: "تأكيد الإجابة" }));
  expect(pointsForGuess(150, 152)).toBe(3);
  expect(screen.getByText("إصابة دقيقة في القلب")).toBeTruthy();
  expect(screen.getByText(/3 من 3 نقاط/)).toBeTruthy();
  expect(targetsOnDial()).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "بطاقة أخرى" }));
  expect(document.querySelectorAll(".dial-zone")).toHaveLength(0);
  expect(screen.queryByText("إصابة دقيقة في القلب")).toBeNull();
});

it("teaches both modes with the roles, the score change and the next turn", async () => {
  render(<PracticeWalkthrough initialMode="individual" />);
  nextStep();
  fireEvent.click(screen.getByRole("button", { name: "جرّب التخمين" }));
  // Land the needle on the target so the team total has something to show.
  const slider = screen.getByRole("slider");
  slider.focus();
  for (let index = 0; index < 4; index += 1)
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "اكشف الهدف" }));
  expect(pointsForGuess(130, 130)).toBe(3);
  expect(screen.getByText("الوضع الفردي")).toBeTruthy();
  // Individual results keep every eligible guess on the dial and in the list.
  expect(document.querySelectorAll("[data-needle]")).toHaveLength(3);
  // Each other player appears once on the dial title and once in the result list.
  expect(screen.getAllByText("سارة")).toHaveLength(2);
  expect(screen.getAllByText("أحمد")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "الفرق" }));
  expect(screen.getByText("وضع الفرق")).toBeTruthy();
  // Both team rows name their own designated answerer.
  expect(screen.getAllByText(/يثبت الإجابة/)).toHaveLength(2);
  expect(document.querySelectorAll("[data-needle]")).toHaveLength(0);

  // The awarded points land in the active team's total, not in a sentence about them.
  const active = document.querySelector('.practice-team-row[data-team-turn="now"]');
  const next = document.querySelector('.practice-team-row[data-team-turn="next"]');
  expect(active?.textContent).toContain("ريم");
  expect(next?.textContent).toContain("نورة");
  await waitFor(() => {
    expect(active?.textContent).toContain("3 نقطة");
  });
  expect(next?.textContent).toContain("0 نقطة");

  // The turn moves to the next team with its own psychic and controller, and the total stays.
  fireEvent.click(screen.getByRole("button", { name: /الدور التالي/ }));
  const rotated = document.querySelector('.practice-team-row[data-team-turn="now"]');
  expect(rotated?.textContent).toContain("الصقور");
  expect(rotated?.textContent).toContain("سلمان");
  expect(rotated?.textContent).toContain("نورة");
  // The team that just scored keeps its total when the turn moves on.
  expect(
    document.querySelector('.practice-team-row[data-team-turn="next"]')?.textContent,
  ).toContain("3 نقطة");
  // The gained points stay with the team that scored, not with the newly active team.
  expect(
    document.querySelector('.practice-team-row[data-team-turn="next"]')?.textContent,
  ).toContain("+3");
  expect(
    document.querySelector('.practice-team-row[data-team-turn="now"]')?.textContent,
  ).not.toContain("+3");
  expect(
    document.querySelector('.practice-team-row[data-team-turn="next"]')?.textContent,
  ).toContain("النجوم");
  expect(screen.getByText(/الدور التالي: النجوم/)).toBeTruthy();
});

it("scores every authored free card against its own target and keeps the dial in step", () => {
  render(<PracticeWalkthrough />);
  walkToReveal();
  fireEvent.click(screen.getByRole("button", { name: "جرّب بنفسك" }));
  FREE_PRACTICE_CARDS.forEach((card, index) => {
    // The clue names the card that is currently on the dial.
    expect(screen.getByText(card.clue, { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإجابة" }));
    const rows = [...document.querySelectorAll(".practice-score-list li")];
    for (const entry of PRACTICE_INPUTS) {
      const row = rows.find((candidate) => candidate.textContent.includes(entry.displayName));
      expect(row, entry.displayName).toBeTruthy();
      // The row and the needle use the same angle and the same active target.
      expect(row?.textContent).toContain(`${pointsForGuess(entry.angle, card.target)} نقاط`);
      expect(document.querySelector(`[data-player-id="${entry.playerId}"]`)).toBeTruthy();
    }
    const mine = rows.find((candidate) => candidate.textContent.includes("أنت"));
    expect(mine?.textContent).toContain(`${pointsForGuess(90, card.target)} نقاط`);
    if (index < FREE_PRACTICE_CARDS.length - 1) {
      fireEvent.click(screen.getByRole("button", { name: "بطاقة أخرى" }));
      expect(document.querySelectorAll(".dial-zone")).toHaveLength(0);
    }
  });
});

it("gives each step guidance that matches what its dial can do", () => {
  render(<PracticeWalkthrough />);
  // Steps one and two explain the psychic's side and have no needle to drag.
  expect(screen.getByRole("status").textContent).toContain("سرّية");
  expect(screen.queryByText(/اسحب المؤشر/)).toBeNull();
  nextStep();
  expect(screen.getByRole("status").textContent).toContain("التلميح جاهز");
  expect(screen.queryByText(/اسحب المؤشر/)).toBeNull();
  // Only the guessing step asks for a drag, and the reveal asks for nothing.
  fireEvent.click(screen.getByRole("button", { name: "جرّب التخمين" }));
  expect(screen.getByRole("status").textContent).toContain("اسحب المؤشر");
  // Exactly one instruction: the step detail describes the idea, not the gesture again.
  expect(screen.getAllByText(/اسحب المؤشر/)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "اكشف الهدف" }));
  expect(screen.queryByText(/اسحب المؤشر/)).toBeNull();
});

it("does not touch the live session, the controller or the real round", () => {
  const store = createSessionStore({
    ...initialSession(),
    roomCode: "AB12",
    playerId: "me",
    currentScreen: "game-psychic",
    connection: "connected",
    round: {
      ...initialSession().round,
      roundNumber: 4,
      psychicId: "me",
      card: { id: "core-35", packId: "core", left: "بارد", right: "حار" },
      targetAngle: 130,
    },
  });
  const before = store.getSnapshot();
  const send = vi.fn();
  render(
    <GameProvider
      runtime={{
        store,
        controller: { send, recover: () => Promise.resolve(false) },
        leave: vi.fn(),
      }}
    >
      <PracticeWalkthrough live initialMode="teams" />
    </GameProvider>,
  );
  walkToReveal();
  fireEvent.click(screen.getByRole("button", { name: "جرّب بنفسك" }));
  fireEvent.click(screen.getByRole("button", { name: "تأكيد الإجابة" }));
  fireEvent.click(screen.getByRole("button", { name: "بطاقة أخرى" }));
  expect(send).not.toHaveBeenCalled();
  expect(store.getSnapshot()).toBe(before);
  // A live match keeps running: the panel says so instead of implying a pause.
  expect(screen.getByText(/لا يوقف المباراة/)).toBeTruthy();
});

it("restarts, closes and reopens on the first step", () => {
  const first = render(<PracticeWalkthrough />);
  nextStep();
  expect(screen.getByText("الوسيط يعطي تلميحاً")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "إعادة من البداية" }));
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();
  expect(screen.getByRole("button", { name: "السابق" }).hasAttribute("disabled")).toBe(true);
  first.unmount();
  render(<PracticeWalkthrough />);
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();
  // The compact header keeps the step readable for screen readers as well.
  expect(screen.getByLabelText("الخطوة 1 من 4")).toBeTruthy();
});

it("keeps the written rules one tap away from the practice round", () => {
  render(<HelpPanel />);
  expect(screen.getByText("الوسيط يرى الهدف")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "القواعد بالتفصيل" }));
  expect(screen.getByText("نقاط الوسيط")).toBeTruthy();
  // The practice round stays mounted to keep its progress, but it is hidden from the user.
  expect(screen.getByText("الوسيط يرى الهدف").closest("[hidden]")).not.toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "جرّب جولة" }));
  expect(screen.getByText("الوسيط يرى الهدف").closest("[hidden]")).toBeNull();
  // The replacement-versus-skip tip lives outside the four steps.
  expect(screen.getByText("ما الفرق بين تغيير البطاقة وتخطي الدور؟")).toBeTruthy();
});
