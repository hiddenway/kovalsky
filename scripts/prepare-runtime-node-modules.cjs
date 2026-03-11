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

function readPackageJsonCandidates(packageName) {
  const out = [];
  const seenRealPaths = new Set();

  const packageDir = packageDirForName(packageName);
  const topLevelPath = path.join(packageDir, "package.json");
  const topLevelPkg = readJsonFileSafe(topLevelPath);
  if (topLevelPkg) {
    out.push(topLevelPkg);
    try {
      seenRealPaths.add(fs.realpathSync(topLevelPath));
    } catch {
      // ignore realpath errors and keep best-effort candidate list
    }
  }

  const pnpmStoreDir = path.join(sourceDir, ".pnpm");
  if (!fs.existsSync(pnpmStoreDir)) {
    return out;
  }

  const packagePrefix = `${packageName.replace("/", "+")}@`;
  for (const entry of fs.readdirSync(pnpmStoreDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(packagePrefix)) {
      continue;
    }
    const candidatePath = path.join(pnpmStoreDir, entry.name, "node_modules", ...packageName.split("/"), "package.json");
    const pkg = readJsonFileSafe(candidatePath);
    if (!pkg) {
      continue;
    }

    try {
      const realPath = fs.realpathSync(candidatePath);
      if (seenRealPaths.has(realPath)) {
        continue;
      }
      seenRealPaths.add(realPath);
    } catch {
      // ignore realpath errors and still include candidate
    }

    out.push(pkg);
  }

  return out;
}

function collectRuntimePackageNames() {
  const queue = [...rootProductionDeps];
  const visited = new Set();
  const processQueue = () => {
    while (queue.length > 0) {
      const packageName = queue.shift();
      if (!packageName || visited.has(packageName)) {
        continue;
      }

      visited.add(packageName);
      const packageJsonCandidates = readPackageJsonCandidates(packageName);
      if (packageJsonCandidates.length === 0) {
        continue;
      }

      for (const pkg of packageJsonCandidates) {
        const dependencies = Object.keys(pkg.dependencies ?? {});
        const optionalDependencies = Object.keys(pkg.optionalDependencies ?? {});
        for (const depName of [...dependencies, ...optionalDependencies]) {
          if (!visited.has(depName)) {
            queue.push(depName);
          }
        }
      }
    }
  };

  processQueue();

  // Some dependencies are nested under openclaw and can be a newer version
  // than the top-level hoisted package. Include them explicitly so runtime
  // payload keeps required transitive deps (e.g. @snazzah/davey for @discordjs/voice@0.19.1).
  const openClawNestedVoicePath = path.join(
    sourceDir,
    "openclaw",
    "node_modules",
    "@discordjs",
    "voice",
    "package.json",
  );
  const openClawNestedVoicePkg = readJsonFileSafe(openClawNestedVoicePath);
  if (openClawNestedVoicePkg) {
    const dependencies = Object.keys(openClawNestedVoicePkg.dependencies ?? {});
    const optionalDependencies = Object.keys(openClawNestedVoicePkg.optionalDependencies ?? {});
    for (const depName of [...dependencies, ...optionalDependencies]) {
      if (!visited.has(depName)) {
        queue.push(depName);
      }
    }
  }
  processQueue();

  return visited;
}

const runtimePackages = collectRuntimePackageNames();
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

console.log(`Prepared runtime node_modules at ${targetDir}`);
