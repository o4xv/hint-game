import { describe, expect, it, vi } from "vitest";
import { attachSessionLifecycle } from "../src/session/lifecycle";

class DocumentFixture extends EventTarget {
  visibilityState = "visible";
  setVisibility(value: string) {
    this.visibilityState = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("foreground session reconciliation", () => {
  it("reconciles after a meaningful background interval, restored page, or network return", () => {
    const document = new DocumentFixture();
    const page = new EventTarget();
    const recover = vi.fn().mockResolvedValue(true);
    let now = 0;
    const detach = attachSessionLifecycle({ document, page }, recover, () => now);
    document.setVisibility("hidden");
    now = 2_000;
    document.setVisibility("visible");
    expect(recover).not.toHaveBeenCalled();
    document.setVisibility("hidden");
    now = 5_000;
    document.setVisibility("visible");
    expect(recover).toHaveBeenCalledTimes(1);
    document.setVisibility("visible");
    expect(recover).toHaveBeenCalledTimes(1);
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    page.dispatchEvent(new Event("online"));
    expect(recover).toHaveBeenCalledTimes(3);
    detach();
    document.setVisibility("hidden");
    now = 20_000;
    document.setVisibility("visible");
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    page.dispatchEvent(new Event("online"));
    expect(recover).toHaveBeenCalledTimes(3);
  });
});
