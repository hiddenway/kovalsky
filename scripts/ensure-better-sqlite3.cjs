const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function hasBindingFile(packageRoot) {
  const candidates = [
    path.join(packageRoot, "build", "Release", "better_sqlite3.node"),
    path.join(packageRoot, "build", "Debug", "better_sqlite3.node"),
    path.join(packageRoot, "out", "Release", "better_sqlite3.node"),
    path.join(packageRoot, "out", "Debug", "better_sqlite3.node"),
    path.join(packageRoot, "lib", "binding", `node-v${process.versions.modules}`, "better_sqlite3.node"),
  ];

  return candidates.some((candidate) => fs.existsSync(candidate));
}

function checkLoadableBinding(projectRoot) {
  const probe = spawnSync(process.execPath, ["-e", "require('better-sqlite3')"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (probe.status === 0) {
    return { ok: true, reason: "" };
  }

  const reason = `${probe.stderr || ""}\n${probe.stdout || ""}`.trim();
  return { ok: false, reason };
}

function isRecoverableBindingError(reason) {
  const text = String(reason || "");
  return [
    "Could not locate the bindings file",
    "was compiled against a different Node.js version",
    "NODE_MODULE_VERSION",
    "ERR_DLOPEN_FAILED",
    "better_sqlite3.node",
  ].some((pattern) => text.includes(pattern));
}

function runRebuild(projectRoot) {
  const localPnpmCli = path.join(projectRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  if (fs.existsSync(localPnpmCli)) {
    const tryLocalPnpm = spawnSync(process.execPath, [localPnpmCli, "rebuild", "better-sqlite3"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });

    if (tryLocalPnpm.status === 0) {
      return;
    }
  }

  const tryNpm = spawnSync(npmCmd, ["rebuild", "better-sqlite3"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (tryNpm.status === 0) {
    return;
  }

  const tryPnpm = spawnSync(pnpmCmd, ["rebuild", "better-sqlite3"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (tryPnpm.status === 0) {
    return;
  }

  throw new Error(
    'Failed to rebuild "better-sqlite3". Ensure build tools are installed and run "pnpm rebuild better-sqlite3".',
  );
}

function ensureBetterSqlite3Binding() {
  const projectRoot = path.resolve(__dirname, "..");
  const packageRoot = path.join(projectRoot, "node_modules", "better-sqlite3");

  if (!fs.existsSync(packageRoot)) {
    throw new Error('Package "better-sqlite3" is not installed. Run "pnpm install" first.');
  }

  const probe = checkLoadableBinding(projectRoot);
  if (probe.ok) {
    return;
  }

  if (!isRecoverableBindingError(probe.reason) && hasBindingFile(packageRoot)) {
    throw new Error(probe.reason || 'Failed to load "better-sqlite3" for unknown reason.');
  }

  runRebuild(projectRoot);

  const probeAfter = checkLoadableBinding(projectRoot);
  if (!probeAfter.ok) {
    throw new Error(
      `"better-sqlite3" rebuild finished but module is still not loadable.\n${probeAfter.reason || ""}`.trim(),
    );
  }
}

ensureBetterSqlite3Binding();
