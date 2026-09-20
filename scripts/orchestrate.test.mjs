import assert from "node:assert/strict";
import test from "node:test";

async function loadOrchestrator(t) {
  try {
    return await import("./orchestrate.mjs");
  } catch (error) {
    t.assert.fail(`orchestrator could not be loaded: ${error.message}`);
  }
}

test("build does not start dependents before shared compilation finishes", async (t) => {
  const { executePlan } = await loadOrchestrator(t);
  const events = [];
  let finishShared;
  const sharedGate = new Promise((resolve) => {
    finishShared = resolve;
  });

  const execution = executePlan("build", {
    executeSerialTask: async (task) => {
      events.push(`serial:${task.package}:${task.script}`);
      await sharedGate;
    },
    executeParallelTasks: async (tasks) => {
      events.push(`parallel:${tasks.map((task) => task.package).join(",")}`);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["serial:shared:build"]);
  finishShared();
  await execution;
  assert.deepEqual(events, ["serial:shared:build", "parallel:server,client"]);
});

test("unit tests exclude browser journeys and test:e2e compiles its backend before Playwright", async (t) => {
  const { executePlan } = await loadOrchestrator(t);

  async function capture(command) {
    const visited = [];
    await executePlan(command, {
      executeSerialTask: async (task) =>
        visited.push(`${task.package}:${task.script ?? task.command}`),
      executeParallelTasks: async (tasks) => {
        visited.push(...tasks.map((task) => `${task.package}:${task.script}`));
      },
    });
    return visited;
  }

  assert.deepEqual(await capture("test"), [
    "shared:build",
    "root:test:tooling",
    "shared:test",
    "server:test",
    "client:test",
  ]);
  assert.deepEqual(await capture("test:e2e"), ["shared:build", "server:build", "e2e:test"]);
});

test("install:all performs clean installs in deterministic package order", async (t) => {
  const { executePlan } = await loadOrchestrator(t);
  const visited = [];

  await executePlan("install:all", {
    executeSerialTask: async (task) => visited.push(`${task.package}:${task.command}`),
    executeParallelTasks: async () => assert.fail("installs must not run in parallel"),
  });

  assert.deepEqual(visited, ["root:ci", "shared:ci", "client:ci", "server:ci", "e2e:ci"]);
});

test("deployment execution includes only the required dependency graph", async (t) => {
  const { executePlan } = await loadOrchestrator(t);

  async function capture(command) {
    const visited = [];
    await executePlan(command, {
      executeSerialTask: async (task) =>
        visited.push(`${task.package}:${task.command ?? task.script}`),
      executeParallelTasks: async () => assert.fail("deployment steps must be deterministic"),
    });
    return visited;
  }

  assert.deepEqual(await capture("deploy:render"), [
    "root:ci",
    "shared:ci",
    "server:ci",
    "shared:build",
    "server:build",
  ]);
  assert.deepEqual(await capture("install:vercel"), ["root:ci", "shared:ci", "client:ci"]);
  assert.deepEqual(await capture("build:client"), ["shared:build", "client:build"]);
});

test("serial execution stops at the first failed command", async (t) => {
  const { runSerial } = await loadOrchestrator(t);
  const visited = [];
  const tasks = [
    { package: "shared", script: "build" },
    { package: "server", script: "build" },
    { package: "client", script: "build" },
  ];

  await assert.rejects(
    runSerial(tasks, async (task) => {
      visited.push(task.package);
      if (task.package === "server") {
        throw new Error("server failed");
      }
    }),
    /server failed/,
  );
  assert.deepEqual(visited, ["shared", "server"]);
});

test("parallel execution terminates siblings after one command fails", async (t) => {
  const { runParallel } = await loadOrchestrator(t);
  const rejecters = new Map();
  const terminated = [];

  const execution = runParallel([{ package: "server" }, { package: "client" }], (task) => ({
    promise: new Promise((resolve, reject) => {
      rejecters.set(task.package, reject);
    }),
    terminate() {
      terminated.push(task.package);
      rejecters.get(task.package)(new Error(`${task.package} terminated`));
    },
  }));
  rejecters.get("server")(new Error("server failed"));

  await assert.rejects(execution, /server failed/);
  assert.deepEqual(terminated, ["server", "client"]);
});

test("Windows launches the npm JavaScript entry point without a command shell", async (t) => {
  const { resolveNpmInvocation } = await loadOrchestrator(t);

  assert.deepEqual(
    resolveNpmInvocation({
      platform: "win32",
      execPath: "C:\\Node\\node.exe",
      npmExecPath: "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js",
    }),
    {
      executable: "C:\\Node\\node.exe",
      leadingArguments: ["C:\\Node\\node_modules\\npm\\bin\\npm-cli.js"],
    },
  );
});

test("unknown commands are rejected before launching processes", async (t) => {
  const { executePlan } = await loadOrchestrator(t);

  await assert.rejects(executePlan("release"), /Unknown orchestration command: release/);
});
