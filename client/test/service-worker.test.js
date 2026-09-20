import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
function workerFixture({ assetStatus = 200 } = {}) {
  const listeners = new Map();
  const deleted = [];
  const cache = new Map();
  const scope = {
    location: { origin: "https://hint.test" },
    addEventListener: (event, listener) => listeners.set(event, listener),
    registration: {},
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  class WorkerRequest extends Request {
    constructor(url, options) {
      super(new URL(url, scope.location.origin), options);
    }
  }
  vm.runInNewContext(source, {
    self: scope,
    URL,
    Request: WorkerRequest,
    Response,
    caches: {
      open: async () => ({
        addAll: async () => {},
        put: async (key, value) => cache.set(key, value),
        match: async (key) => cache.get(key),
      }),
      keys: async () => ["another-app-cache", "hint-runtime-old", "hint-runtime-__BUILD_ID__"],
      delete: async (name) => {
        deleted.push(name);
        return true;
      },
      match: async (key) => cache.get(key),
    },
    fetch: async (request) =>
      new Response(
        new URL(request.url).pathname === "/" ? '<script src="/assets/game.js"></script>' : "",
        { status: new URL(request.url).pathname === "/" ? 200 : assetStatus },
      ),
  });
  return {
    deleted,
    async dispatch(event) {
      let completion;
      listeners.get(event)({
        waitUntil: (promise) => {
          completion = promise;
        },
      });
      await completion;
    },
  };
}
test("installation rejects an incomplete production shell instead of activating a broken offline build", async () => {
  const worker = workerFixture({ assetStatus: 503 });
  await assert.rejects(worker.dispatch("install"));
});
test("activation only removes obsolete Hint caches", async () => {
  const worker = workerFixture();
  await worker.dispatch("activate");
  assert.deepEqual(worker.deleted, ["hint-runtime-old"]);
});
