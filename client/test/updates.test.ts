import { afterEach, expect, it, vi } from "vitest";
import { createPwaUpdates } from "../src/session/updates";

afterEach(() => {
  vi.useRealTimers();
});

it("keeps an externally activated update available without forcing this tab to reload", async () => {
  const container = new EventTarget();
  const registration = Object.assign(new EventTarget(), {
    waiting: null,
    installing: null,
    update: () => Promise.resolve(),
  });
  const reload = vi.fn();
  const manager = createPwaUpdates({
    register: () => Promise.resolve(registration),
    container,
    page: new EventTarget(),
    document: new EventTarget(),
    hasController: () => true,
    isVisible: () => true,
    reload,
  });
  await manager.start();
  container.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
  expect(manager.getSnapshot()).toBe(true);
  manager.requestUpdate();
  manager.requestUpdate();
  expect(reload).toHaveBeenCalledTimes(1);
  manager.stop();
});

it("does not announce first service-worker control as a new app version", async () => {
  let controlled = false;
  const container = new EventTarget();
  const registration = Object.assign(new EventTarget(), {
    waiting: null,
    installing: null,
    update: () => Promise.resolve(),
  });
  const manager = createPwaUpdates({
    register: () => Promise.resolve(registration),
    container,
    page: new EventTarget(),
    document: new EventTarget(),
    hasController: () => controlled,
    isVisible: () => true,
    reload: vi.fn(),
  });
  await manager.start();
  controlled = true;
  container.dispatchEvent(new Event("controllerchange"));
  expect(manager.getSnapshot()).toBe(false);
  manager.stop();
});

it("announces an installed update even before the registration waiting property catches up", async () => {
  const worker = Object.assign(new EventTarget(), { state: "installing" });
  const registration = Object.assign(new EventTarget(), {
    waiting: null,
    installing: worker,
    update: () => Promise.resolve(),
  });
  const manager = createPwaUpdates({
    register: () => Promise.resolve(registration),
    container: new EventTarget(),
    page: new EventTarget(),
    document: new EventTarget(),
    hasController: () => true,
    isVisible: () => true,
    reload: vi.fn(),
  });
  await manager.start();
  worker.state = "installed";
  worker.dispatchEvent(new Event("statechange"));
  expect(manager.getSnapshot()).toBe(true);
  manager.stop();
});

it("only reloads once after an explicit update request, and cleans up observers", async () => {
  vi.useFakeTimers();
  const container = new EventTarget();
  const page = new EventTarget();
  const document = new EventTarget();
  const postMessage = vi.fn();
  const update = vi.fn(() => Promise.resolve());
  const registration = Object.assign(new EventTarget(), {
    waiting: { postMessage },
    installing: null,
    update,
  });
  const reload = vi.fn();
  const manager = createPwaUpdates({
    register: () => Promise.resolve(registration),
    container,
    page,
    document,
    hasController: () => true,
    isVisible: () => true,
    reload,
  });
  await manager.start();
  expect(manager.getSnapshot()).toBe(true);
  container.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
  manager.requestUpdate();
  expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  container.dispatchEvent(new Event("controllerchange"));
  container.dispatchEvent(new Event("controllerchange"));
  expect(reload).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(update).toHaveBeenCalledTimes(1);
  manager.stop();
  page.dispatchEvent(new Event("online"));
  expect(update).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores registration completion after cleanup", async () => {
  let resolve: (registration: null) => void = () => {
    /* assigned below */
  };
  const container = new EventTarget();
  const manager = createPwaUpdates({
    register: () =>
      new Promise<null>((settle) => {
        resolve = settle;
      }),
    container,
    page: new EventTarget(),
    document: new EventTarget(),
    hasController: () => false,
    isVisible: () => true,
    reload: vi.fn(),
  });
  const pending = manager.start();
  manager.stop();
  resolve(null);
  await pending;
  expect(manager.getSnapshot()).toBe(false);
});
