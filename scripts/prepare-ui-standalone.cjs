const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  ensureDir(path.dirname(target));
  fs.cpSync(source, target, { recursive: true, force: true });
}

function main() {
  const root = path.resolve(__dirname, "..");
  const uiRoot = path.join(root, "ui");
  const nextRoot = path.join(uiRoot, ".next");
  const standaloneRoot = path.join(nextRoot, "standalone");
  const rootServerScript = path.join(standaloneRoot, "server.js");
  const nestedServerScript = path.join(standaloneRoot, "ui", "server.js");
  const standaloneAppRoot = fs.existsSync(rootServerScript)
    ? standaloneRoot
    : path.join(standaloneRoot, "ui");
  const serverScript = fs.existsSync(rootServerScript) ? rootServerScript : nestedServerScript;

  if (!fs.existsSync(serverScript)) {
    throw new Error(`Missing standalone server: ${serverScript}. Run "npm --prefix ui run build" first.`);
  }

  copyDirectory(path.join(nextRoot, "static"), path.join(standaloneAppRoot, ".next", "static"));
  copyDirectory(path.join(uiRoot, "public"), path.join(standaloneAppRoot, "public"));
  // Keep UI package metadata near standalone server for easier diagnostics.
  fs.copyFileSync(path.join(uiRoot, "package.json"), path.join(standaloneAppRoot, "package.json"));

  // eslint-disable-next-line no-console
  console.log("Prepared Next standalone assets for Electron.");
}

main();
