// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

let dispose: (() => void) | undefined;
afterEach(() => {
  if (typeof dispose === "function") dispose();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function audioFixture() {
  const resume = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const constructed = vi.fn();
  class MockAudioContext {
    state = "suspended";
    resume = resume;
    close = close;
    constructor() {
      constructed();
    }
  }
  vi.stubGlobal("AudioContext", MockAudioContext);
  return { constructed, resume, close };
}

it("waits for a user gesture and closes the context and listeners on disposal", async () => {
  const audio = audioFixture();
  const { initAudio } = await import("../src/session/audio");
  dispose = initAudio();
  expect(audio.constructed).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("pointerdown"));
  expect(audio.constructed).toHaveBeenCalledTimes(1);
  expect(audio.resume).toHaveBeenCalledTimes(1);
  dispose();
  expect(audio.close).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("keydown"));
  expect(audio.resume).toHaveBeenCalledTimes(1);
  dispose = undefined;
});

it("resumes previously activated audio on foreground restoration without creating audio in the background", async () => {
  const audio = audioFixture();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { initAudio } = await import("../src/session/audio");
  dispose = initAudio();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(audio.constructed).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("pointerdown"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(audio.resume).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(audio.constructed).toHaveBeenCalledTimes(1);
  expect(audio.resume).toHaveBeenCalledTimes(2);
});
