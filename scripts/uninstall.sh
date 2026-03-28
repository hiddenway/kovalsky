#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${KOVALSKY_INSTALL_DIR:-$HOME/.local/share/kovalsky}"
BIN_DIR="${KOVALSKY_BIN_DIR:-$HOME/.local/bin}"
REMOVE_APPDATA="${KOVALSKY_REMOVE_APPDATA:-0}"
APPDATA_DIR="${KOVALSKY_APPDATA_DIR:-$HOME/.kovalsky}"

log() {
  printf '[kovalsky-uninstall] %s\n' "$*"
}

if [[ -f "$BIN_DIR/kovalsky" ]]; then
  rm -f "$BIN_DIR/kovalsky"
  log "Removed launcher: $BIN_DIR/kovalsky"
else
  log "Launcher not found: $BIN_DIR/kovalsky"
fi

if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  log "Removed install dir: $INSTALL_DIR"
else
  log "Install dir not found: $INSTALL_DIR"
fi

if [[ "$REMOVE_APPDATA" == "1" && -d "$APPDATA_DIR" ]]; then
  rm -rf "$APPDATA_DIR"
  log "Removed app data: $APPDATA_DIR"
fi

log "Done."
