#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BUMP="${1:-patch}"
PUSH_MODE="${2:-push}"

if [[ "$PUSH_MODE" != "push" && "$PUSH_MODE" != "no-push" ]]; then
  echo "Usage: ./release.sh [patch|minor|major|X.Y.Z] [push|no-push]"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean. Commit or stash changes first."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Release must run from main branch. Current branch: $CURRENT_BRANCH"
  exit 1
fi

git fetch origin main --tags
LOCAL_MAIN="$(git rev-parse HEAD)"
REMOTE_MAIN="$(git rev-parse origin/main)"
if [[ "$LOCAL_MAIN" != "$REMOTE_MAIN" ]]; then
  echo "Local main is not up to date with origin/main. Pull/rebase first."
  exit 1
fi

NEXT_VERSION="$(node - "$BUMP" <<'NODE'
const fs = require("node:fs");

const bump = process.argv[2];
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const current = String(pkg.version || "").trim();
const semver = /^(\d+)\.(\d+)\.(\d+)$/;

if (!semver.test(current)) {
  throw new Error(`Unsupported current version: ${current}`);
}

function inc(version, type) {
  const match = version.match(semver);
  if (!match) {
    throw new Error(`Invalid semver: ${version}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor += 1;
    patch = 0;
  } else if (type === "patch") {
    patch += 1;
  } else {
    throw new Error(`Unsupported bump type: ${type}`);
  }
  return `${major}.${minor}.${patch}`;
}

let next = "";
if (semver.test(bump)) {
  next = bump;
} else {
  next = inc(current, bump);
}

if (!semver.test(next)) {
  throw new Error(`Invalid target version: ${next}`);
}

if (next === current) {
  throw new Error(`Version is already ${current}`);
}

process.stdout.write(next);
NODE
)"

TAG="v${NEXT_VERSION}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists. Choose another version."
  exit 1
fi

node - "$NEXT_VERSION" <<'NODE'
const fs = require("node:fs");

const version = process.argv[2];
for (const file of ["package.json", "ui/package.json"]) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}
NODE

git add package.json ui/package.json
git commit -m "chore(release): ${TAG}"
git tag -a "${TAG}" -m "Release ${TAG}"

if [[ "$PUSH_MODE" == "push" ]]; then
  git push origin main
  git push origin "${TAG}"
  echo "Release pushed: ${TAG}"
else
  echo "Release prepared locally: ${TAG}"
fi
