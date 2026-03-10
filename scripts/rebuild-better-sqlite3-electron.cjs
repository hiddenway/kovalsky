const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function resolveElectronVersion() {
  const electronPkg = path.join(root, "node_modules", "electron", "package.json");
  if (!fs.existsSync(electronPkg)) {
    throw new Error('Electron is not installed. Run "pnpm install" first.');
  }
  const pkg = JSON.parse(fs.readFileSync(electronPkg, "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error("Cannot resolve Electron version from node_modules/electron/package.json");
  }
  return version;
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env,
  });
  return result.status === 0;
}

function rebuildForElectron() {
  const electronVersion = resolveElectronVersion();
  const env = {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_build_from_source: "true",
  };

  const localPnpmCli = path.join(root, "node_modules", "pnpm", "bin", "pnpm.cjs");
  if (fs.existsSync(localPnpmCli)) {
    if (run(process.execPath, [localPnpmCli, "rebuild", "better-sqlite3"], env)) {
      return;
    }
  }

  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (run(pnpmCmd, ["rebuild", "better-sqlite3"], env)) {
    return;
  }

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  if (run(npmCmd, ["rebuild", "better-sqlite3"], env)) {
    return;
  }

  throw new Error('Failed to rebuild "better-sqlite3" for Electron runtime.');
}

console.log("[electron-native] rebuilding better-sqlite3 for Electron ABI...");
rebuildForElectron();
console.log("[electron-native] better-sqlite3 rebuild complete.");

