#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  echo "[0/3] Switching Node.js via nvm (node)..."
  nvm use node
else
  echo "Warning: nvm is not available, using current Node.js from PATH." >&2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is not installed or not in PATH." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in PATH." >&2
  exit 1
fi

MODE="${1:-full}"
if [[ "$MODE" != "full" && "$MODE" != "--quick" ]]; then
  echo "Usage: ./build.sh [--quick]" >&2
  exit 1
fi

echo "[1/3] Installing dependencies..."
pnpm install

echo "[2/3] Building backend + UI runtime bundle..."
pnpm run build:app

if [[ "$MODE" == "--quick" ]]; then
  echo "[3/3] Building quick Electron package (zip only)..."
  pnpm exec electron-builder --mac zip --publish never
else
  echo "[3/3] Building Electron distributables..."
  pnpm run electron:dist
fi

echo "Done. Build artifacts are in: $ROOT_DIR/release"
