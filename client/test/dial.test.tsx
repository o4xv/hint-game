// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dial } from "../src/ui/Dial";
import { positionToAngle } from "../src/ui/dialGeometry";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function touch(element: Element, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
  });
  fireEvent(element, event);
}

function captureFixture(element: Element) {
  let captured: number | null = null;
  const set = vi.fn((id: number) => {
    captured = id;
  });
  const release = vi.fn((id: number) => {
    captured = null;
    touch(element, "lostpointercapture", 0, 0, id);
  });
  Object.defineProperties(element, {
    setPointerCapture: { value: set },
    hasPointerCapture: { value: (id: number) => captured === id },
    releasePointerCapture: { value: release },
  });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 404, 214));
  return { set, release };
}

describe("dial controls", () => {
  it("keeps touch drafts local, bounds preview traffic, and preserves drag through parent updates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let parentRenders = 0;
    const onChange = vi.fn();
    const onPreview = vi.fn();
    function Parent({ angle }: { angle: number }) {
      parentRenders++;
      return <Dial angle={angle} interactive onChange={onChange} onPreview={onPreview} />;
    }
    const view = render(<Parent angle={90} />);
    const dial = screen.getByRole("slider");
    captureFixture(dial);
    touch(dial, "pointerdown", 22, 202);
    for (let index = 1; index <= 100; index++) {
      vi.setSystemTime(1000 + index * 5);
      touch(dial, "pointermove", 22 + index * 3.6, 22);
    }
    expect(onPreview).toHaveBeenCalledTimes(11); // Initial preview plus at most one per50ms.
    expect(onChange).not.toHaveBeenCalled();
    expect(parentRenders).toBe(1);
    const dragged = dial.getAttribute("aria-valuenow");
    view.rerender(<Parent angle={20} />);
    expect(dial.getAttribute("aria-valuenow")).toBe(dragged);
    touch(dial, "pointerup", 382, 22);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(parentRenders).toBe(2);
  });

  it("finishes a cancelled touch once, ignores other pointers, and accepts a new drag", () => {
    const onChange = vi.fn();
    render(<Dial interactive onChange={onChange} />);
    const dial = screen.getByRole("slider");
    const capture = captureFixture(dial);
    touch(dial, "pointerdown", 22, 202);
    touch(dial, "pointermove", 382, 202, 2);
    expect(dial.getAttribute("aria-valuenow")).toBe("0");
    touch(dial, "pointermove", 202, 22);
    touch(dial, "pointercancel", 202, 22);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(90);
    expect(capture.release).toHaveBeenCalledExactlyOnceWith(1);
    touch(dial, "pointerup", 202, 22);
    expect(onChange).toHaveBeenCalledTimes(1);
    touch(dial, "pointerdown", 382, 202, 2);
    touch(dial, "pointerup", 382, 202, 2);
    expect(onChange).toHaveBeenLastCalledWith(180);
    expect(capture.set).toHaveBeenCalledTimes(2);
  });

  it("does not capture touches or emit previews on a read-only dial", () => {
    const onPreview = vi.fn();
    render(<Dial onPreview={onPreview} />);
    const dial = screen.getByRole("img");
    const capture = captureFixture(dial);
    touch(dial, "pointerdown", 22, 202);
    touch(dial, "pointermove", 382, 202);
    expect(capture.set).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(dial.getAttribute("style")).toContain("touch-action: auto");
  });
  it("preserves the left-to-right angle convention with the padded viewbox", () => {
    const rect = { left: 0, top: 0, width: 404, height: 214 };
    expect(positionToAngle(22, 202, rect)).toBe(0);
    expect(positionToAngle(202, 22, rect)).toBe(90);
    expect(positionToAngle(382, 202, rect)).toBe(180);
    expect(positionToAngle(22, 210, rect)).toBe(0);
  });
  it("supports arrow, shifted arrow, Home and End keys without reversing RTL semantics", () => {
    const onChange = vi.fn();
    render(<Dial angle={90} interactive onChange={onChange} />);
    const dial = screen.getByRole("slider");
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(88);
    fireEvent.keyDown(dial, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(dial, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(dial, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(180);
  });
  it("does not expose controls on observer and locked dials", () => {
    const onChange = vi.fn();
    const view = render(<Dial angle={65} onChange={onChange} />);
    expect(screen.queryByRole("slider")).toBeNull();
    view.rerender(<Dial angle={65} interactive locked onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("img"), { key: "End" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
