const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "node_modules");
const targetDir = path.join(root, ".runtime-node_modules");
const tempTag = `${Date.now()}-${process.pid}`;
const stagingDir = path.join(root, `.runtime-node_modules.__staging__${tempTag}`);
const backupDir = path.join(root, `.runtime-node_modules.__backup__${tempTag}`);
const stagingNodeModulesDir = path.join(stagingDir, "node_modules");
const OPENCLAW_REACTION_SUFFIX = path.join("openclaw", "extensions", "zalouser", "src", "reaction.ts");
const packageJsonPath = path.join(root, "package.json");
const packageJson = fs.existsSync(packageJsonPath)
  ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
  : {};
const devOnlyTopLevel = new Set(Object.keys(packageJson.devDependencies ?? {}));
const rootProductionDeps = Object.keys(packageJson.dependencies ?? {});
const openClawCriticalPackages = ["@discordjs/voice", "@snazzah/davey", "tslog"];
const codexPlatformPackageByTarget = {
  "linux:x64": "@openai/codex-linux-x64",
  "linux:arm64": "@openai/codex-linux-arm64",
  "darwin:x64": "@openai/codex-darwin-x64",
  "darwin:arm64": "@openai/codex-darwin-arm64",
  "win32:x64": "@openai/codex-win32-x64",
  "win32:arm64": "@openai/codex-win32-arm64",
};

function packageDirForName(packageName) {
  return path.join(sourceDir, ...packageName.split("/"));
}

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findPackageRootFromEntry(entryPath, expectedPackageName) {
  let currentDir = path.dirname(entryPath);
  while (true) {
    const candidateJsonPath = path.join(currentDir, "package.json");
    const candidatePkg = readJsonFileSafe(candidateJsonPath);
    if (candidatePkg && candidatePkg.name === expectedPackageName) {
      return currentDir;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }
    currentDir = parent;
  }
}

function resolveInstalledPackageDir(packageName, fromDir) {
  try {
    const resolvedEntry = require.resolve(packageName, { paths: [fromDir] });
    const rootDir = findPackageRootFromEntry(resolvedEntry, packageName);
    if (rootDir) {
      return rootDir;
    }
  } catch {
    // fallback below
  }

  const fallbackDir = packageDirForName(packageName);
  if (fs.existsSync(path.join(fallbackDir, "package.json"))) {
    return fallbackDir;
  }
  return null;
}

function getRuntimeDependenciesFromPackageDir(packageDir) {
  const pkg = readJsonFileSafe(path.join(packageDir, "package.json"));
  return new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.optionalDependencies ?? {}),
  ]);
}

function collectRuntimePackageNames() {
  const packageNames = new Set();
  const resolvedSpecifiers = new Set();
  const visitedDirs = new Set();
  const queue = [];
  const enqueueByName = (packageName, fromDir) => {
    if (!packageName) {
      return;
    }
    const resolvedDir = resolveInstalledPackageDir(packageName, fromDir);
    if (!resolvedDir) {
      return;
    }
    resolvedSpecifiers.add(packageName);

    let realDir = resolvedDir;
    try {
      realDir = fs.realpathSync(resolvedDir);
    } catch {
      // keep original path if realpath fails
    }

    if (visitedDirs.has(realDir)) {
      return;
    }

    queue.push(realDir);
  };

  for (const packageName of rootProductionDeps) {
    enqueueByName(packageName, root);
  }

  const openclawDir = resolveInstalledPackageDir("openclaw", root);
  if (openclawDir) {
    const openclawRuntimeDeps = getRuntimeDependenciesFromPackageDir(openclawDir);
    for (const packageName of openClawCriticalPackages) {
      if (!openclawRuntimeDeps.has(packageName)) {
        continue;
      }
      enqueueByName(packageName, openclawDir);
    }
  } else {
    for (const packageName of openClawCriticalPackages) {
      enqueueByName(packageName, root);
    }
  }

  while (queue.length > 0) {
    const packageDir = queue.shift();
    if (!packageDir || visitedDirs.has(packageDir)) {
      continue;
    }
    visitedDirs.add(packageDir);

    const pkg = readJsonFileSafe(path.join(packageDir, "package.json"));
    if (!pkg || typeof pkg.name !== "string" || !pkg.name.trim()) {
      continue;
    }
    packageNames.add(pkg.name.trim());

    const dependencies = Object.keys(pkg.dependencies ?? {});
    const optionalDependencies = Object.keys(pkg.optionalDependencies ?? {});
    for (const depName of [...dependencies, ...optionalDependencies]) {
      enqueueByName(depName, packageDir);
    }
  }

  return {
    packageNames,
    resolvedSpecifiers,
  };
}

function assertRuntimePathExists(targetPath, reason) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${reason}: ${targetPath}`);
  }
}

function assertResolvableFromPaths(specifier, lookupPaths, reason) {
  for (const lookupPath of lookupPaths) {
    if (!lookupPath || !fs.existsSync(lookupPath)) {
      continue;
    }
    try {
      require.resolve(specifier, { paths: [lookupPath] });
      return;
    } catch {
      // try next lookup root
    }
  }

  const lookupDescription = lookupPaths.filter(Boolean).join(", ");
  throw new Error(`${reason}: '${specifier}' (lookup roots: ${lookupDescription})`);
}

function verifyOpenClawRuntimeLayout(nodeModulesDir) {
  const openclawDir = path.join(nodeModulesDir, "openclaw");
  assertRuntimePathExists(openclawDir, "openclaw package missing in runtime node_modules");
  const openclawDeps = getRuntimeDependenciesFromPackageDir(openclawDir);
  const entryCandidates = [
    path.join(openclawDir, "openclaw.mjs"),
    path.join(openclawDir, "dist", "entry.js"),
    path.join(openclawDir, "dist", "entry.mjs"),
  ];
  if (!entryCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`openclaw runtime entry missing. Checked: ${entryCandidates.join(", ")}`);
  }

  if (openclawDeps.has("tslog")) {
    assertRuntimePathExists(path.join(nodeModulesDir, "tslog", "package.json"), "tslog package missing in runtime node_modules");
  }

  if (openclawDeps.has("@snazzah/davey")) {
    assertRuntimePathExists(
      path.join(nodeModulesDir, "@snazzah", "davey", "package.json"),
      "@snazzah/davey package missing in runtime node_modules",
    );
  }

  const voiceDirCandidates = [
    path.join(openclawDir, "node_modules", "@discordjs", "voice"),
    path.join(nodeModulesDir, "@discordjs", "voice"),
  ];
  const voiceDir = voiceDirCandidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  if (openclawDeps.has("@discordjs/voice") && !voiceDir) {
    throw new Error("@discordjs/voice package missing in runtime node_modules");
  }
  const voiceDeps = voiceDir ? getRuntimeDependenciesFromPackageDir(voiceDir) : new Set();
  if (voiceDir && voiceDeps.has("@snazzah/davey")) {
    assertResolvableFromPaths(
      "@snazzah/davey",
      [voiceDir, openclawDir, nodeModulesDir],
      "openclaw runtime is missing @snazzah/davey for @discordjs/voice resolution",
    );
  }
}

function detectCodexPlatformPackage() {
  const key = `${process.platform}:${process.arch}`;
  return codexPlatformPackageByTarget[key] ?? null;
}

function verifyCodexRuntimeLayout(nodeModulesDir) {
  const codexDir = path.join(nodeModulesDir, "@openai", "codex");
  if (!fs.existsSync(path.join(codexDir, "package.json"))) {
    return;
  }

  const expectedPlatformPackage = detectCodexPlatformPackage();
  if (!expectedPlatformPackage) {
    return;
  }

  const expectedPackagePath = path.join(nodeModulesDir, ...expectedPlatformPackage.split("/"), "package.json");
  assertRuntimePathExists(
    expectedPackagePath,
    `codex optional platform package missing (${expectedPlatformPackage}) in runtime node_modules`,
  );

  assertResolvableFromPaths(
    `${expectedPlatformPackage}/package.json`,
    [codexDir, nodeModulesDir],
    `codex optional platform package is not resolvable (${expectedPlatformPackage})`,
  );
}

const runtimePackageSelection = collectRuntimePackageNames();
const runtimePackages = new Set([
  ...runtimePackageSelection.packageNames,
  ...runtimePackageSelection.resolvedSpecifiers,
]);
const runtimeScopes = new Set(
  [...runtimePackages]
    .filter((name) => name.startsWith("@"))
    .map((name) => name.split("/")[0]),
);

function shouldIncludeRuntimeEntry(entry) {
  if (entry === sourceDir) {
    return true;
  }

  const relative = path.relative(sourceDir, entry);
  if (!relative) {
    return true;
  }

  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 0) {
    return true;
  }

  if (parts[0] === ".bin") {
    return true;
  }

  if (parts.includes(".cache") || parts.includes(".ignored")) {
    return false;
  }

  const topLevel = parts[0];
  if (topLevel === ".pnpm" || topLevel === ".store") {
    return false;
  }

  if (parts[0].startsWith("@")) {
    if (parts.length === 1) {
      return runtimeScopes.has(parts[0]);
    }
    const scopedPackage = `${parts[0]}/${parts[1]}`;
    if (!runtimePackages.has(scopedPackage)) {
      return false;
    }
    if (parts.length === 2 && devOnlyTopLevel.has(scopedPackage)) {
      return false;
    }
    return true;
  }

  if (!runtimePackages.has(topLevel)) {
    return false;
  }

  // Keep runtime payload focused on production dependencies.
  if (parts.length === 1 && devOnlyTopLevel.has(topLevel)) {
    return false;
  }

  return true;
}

function rmDirWithRetries(dirPath, strict) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.rmSync(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 150,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (strict && lastError) {
    throw lastError;
  }
}

function cleanupStaleRuntimeTemps() {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith(".runtime-node_modules.__")) {
      continue;
    }
    rmDirWithRetries(path.join(root, entry.name), false);
  }
}

function collectOpenClawReactionFiles(nodeModulesDir) {
  const candidates = [];
  const direct = path.join(nodeModulesDir, OPENCLAW_REACTION_SUFFIX);
  if (fs.existsSync(direct)) {
    candidates.push(direct);
  }

  const ignored = path.join(nodeModulesDir, ".ignored", OPENCLAW_REACTION_SUFFIX);
  if (fs.existsSync(ignored)) {
    candidates.push(ignored);
  }

  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  if (!fs.existsSync(pnpmDir)) {
    return candidates;
  }

  for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith("openclaw@")) {
      continue;
    }
    const candidate = path.join(pnpmDir, entry.name, "node_modules", OPENCLAW_REACTION_SUFFIX);
    if (fs.existsSync(candidate)) {
      candidates.push(candidate);
    }
  }

  return [...new Set(candidates)];
}

function sanitizeOpenClawReactionEmojiLiterals(nodeModulesDir) {
  const reactionFiles = collectOpenClawReactionFiles(nodeModulesDir);
  if (reactionFiles.length === 0) {
    return;
  }

  const replacements = new Map([
    ["👍", "\\u{1F44D}"],
    ["❤️", "\\u{2764}\\u{FE0F}"],
    ["😂", "\\u{1F602}"],
    ["😮", "\\u{1F62E}"],
    ["😢", "\\u{1F622}"],
    ["😡", "\\u{1F621}"],
  ]);

  for (const filePath of reactionFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    let next = source;
    for (const [from, to] of replacements.entries()) {
      next = next.split(from).join(to);
    }
    if (next !== source) {
      fs.writeFileSync(filePath, next, "utf8");
    }
  }
}

function pruneBrokenSymlinksRecursively(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        const symlinkTarget = fs.readlinkSync(fullPath);
        const resolvedTarget = path.resolve(path.dirname(fullPath), symlinkTarget);
        if (!fs.existsSync(resolvedTarget)) {
          fs.unlinkSync(fullPath);
        }
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }
}

function pruneRuntimeSourceMaps(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith(".map")) {
        fs.rmSync(fullPath, { force: true });
      }
    }
  }
}

if (!fs.existsSync(sourceDir)) {
  throw new Error(`node_modules not found: ${sourceDir}`);
}

cleanupStaleRuntimeTemps();
rmDirWithRetries(stagingDir, false);
rmDirWithRetries(backupDir, false);
sanitizeOpenClawReactionEmojiLiterals(sourceDir);

// Copy runtime dependencies into a non-special folder so electron-builder
// does not prune/transitively drop modules required by backend child process.
fs.cpSync(sourceDir, stagingNodeModulesDir, {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
  filter: shouldIncludeRuntimeEntry,
});
sanitizeOpenClawReactionEmojiLiterals(stagingNodeModulesDir);
pruneBrokenSymlinksRecursively(stagingNodeModulesDir);
pruneRuntimeSourceMaps(stagingNodeModulesDir);
verifyOpenClawRuntimeLayout(stagingNodeModulesDir);
verifyCodexRuntimeLayout(stagingNodeModulesDir);

// Ensure metadata from pnpm install is available in runtime fallback folder.
const modulesMeta = path.join(root, "node_modules", ".modules.yaml");
if (fs.existsSync(modulesMeta)) {
  fs.copyFileSync(modulesMeta, path.join(stagingNodeModulesDir, ".modules.yaml"));
}

if (fs.existsSync(targetDir)) {
  fs.renameSync(targetDir, backupDir);
}
fs.renameSync(stagingDir, targetDir);
rmDirWithRetries(backupDir, false);
if (fs.existsSync(stagingDir)) {
  rmDirWithRetries(stagingDir, false);
}
verifyOpenClawRuntimeLayout(path.join(targetDir, "node_modules"));
verifyCodexRuntimeLayout(path.join(targetDir, "node_modules"));

console.log(`Prepared runtime node_modules at ${targetDir}`);
