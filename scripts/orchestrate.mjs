import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const packageDirectories = {
  root: rootDirectory,
  shared: path.join(rootDirectory, "shared"),
  client: path.join(rootDirectory, "client"),
  server: path.join(rootDirectory, "server"),
  e2e: path.join(rootDirectory, "e2e"),
};

const plans = {
  "install:all": [
    { mode: "serial", package: "root", command: "ci" },
    { mode: "serial", package: "shared", command: "ci" },
    { mode: "serial", package: "client", command: "ci" },
    { mode: "serial", package: "server", command: "ci" },
    { mode: "serial", package: "e2e", command: "ci" },
  ],
  "install:vercel": [
    { mode: "serial", package: "root", command: "ci" },
    { mode: "serial", package: "shared", command: "ci" },
    { mode: "serial", package: "client", command: "ci" },
  ],
  dev: [
    { mode: "serial", package: "shared", script: "build" },
    {
      mode: "parallel",
      tasks: [
        { package: "server", script: "dev" },
        { package: "client", script: "dev" },
      ],
    },
  ],
  lint: [
    { mode: "serial", package: "shared", script: "build" },
    { mode: "serial", package: "root", command: "lint:code" },
  ],
  typecheck: [
    { mode: "serial", package: "shared", script: "build" },
    { mode: "serial", package: "shared", script: "typecheck" },
    {
      mode: "parallel",
      tasks: [
        { package: "server", script: "typecheck" },
        { package: "client", script: "typecheck" },
      ],
    },
  ],
  test: [
    { mode: "serial", package: "shared", script: "build" },
    { mode: "serial", package: "root", command: "test:tooling" },
    { mode: "serial", package: "shared", script: "test" },
    {
      mode: "parallel",
      tasks: [
        { package: "server", script: "test" },
        { package: "client", script: "test" },
      ],
    },
  ],
  "test:e2e": [
    { mode: "serial", package: "shared", script: "build" },
    { mode: "serial", package: "server", script: "build" },
    { mode: "serial", package: "e2e", script: "test" },
  ],
  build: [
    { mode: "serial", package: "shared", script: "build" },
    {
      mode: "parallel",
      tasks: [
        { package: "server", script: "build" },
        { package: "client", script: "build" },
      ],
    },
  ],
  "build:client": [
    { mode: "serial", package: "shared", script: "build" },
    { mode: "serial", package: "client", script: "build" },
  ],
  "deploy:render": [
    { mode: "serial", package: "root", command: "ci" },
    { mode: "serial", package: "shared", command: "ci" },
    { mode: "serial", package: "server", command: "ci" },
    { mode: "serial", package: "shared", script: "build" },
    { mode: "serial", package: "server", script: "build" },
  ],
};

export function createPlan(command) {
  const plan = plans[command];
  if (!plan) {
    throw new Error(`Unknown orchestration command: ${command}`);
  }
  return structuredClone(plan);
}

export async function runSerial(tasks, execute) {
  for (const task of tasks) {
    await execute(task);
  }
}

export function resolveNpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
} = {}) {
  if (platform !== "win32") {
    return { executable: "npm", leadingArguments: [] };
  }

  const npmCli =
    npmExecPath ?? path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { executable: execPath, leadingArguments: [npmCli] };
}

function npmArguments(task) {
  return task.script
    ? ["run", task.script]
    : task.command === "ci"
      ? ["ci"]
      : ["run", task.command];
}

function launchTask(task) {
  const cwd = packageDirectories[task.package];
  if (!cwd) {
    throw new Error(`Unknown package: ${task.package}`);
  }

  const args = npmArguments(task);
  const { executable, leadingArguments } = resolveNpmInvocation();
  process.stdout.write(`\n[${task.package}] npm ${args.join(" ")}\n`);
  const child = spawn(executable, [...leadingArguments, ...args], {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  const promise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `code ${code}`;
      reject(new Error(`[${task.package}] npm ${args.join(" ")} exited with ${outcome}`));
    });
  });

  return {
    promise,
    terminate() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}

export async function runParallel(tasks, launch = launchTask) {
  const children = tasks.map(launch);
  try {
    await Promise.all(children.map(({ promise }) => promise));
  } catch (error) {
    for (const child of children) {
      child.terminate();
    }
    await Promise.allSettled(children.map(({ promise }) => promise));
    throw error;
  }
}

export async function executePlan(
  command,
  {
    executeSerialTask = async (task) => {
      await launchTask(task).promise;
    },
    executeParallelTasks = runParallel,
  } = {},
) {
  const plan = createPlan(command);
  for (const step of plan) {
    if (step.mode === "parallel") {
      await executeParallelTasks(step.tasks);
    } else {
      await executeSerialTask(step);
    }
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  executePlan(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
