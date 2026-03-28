#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${KOVALSKY_REPO_URL:-https://github.com/hiddenway/kovalsky.git}"
BRANCH="${KOVALSKY_BRANCH:-main}"
INSTALL_DIR="${KOVALSKY_INSTALL_DIR:-$HOME/.local/share/kovalsky}"
BIN_DIR="${KOVALSKY_BIN_DIR:-$HOME/.local/bin}"
SKIP_DEPS="${KOVALSKY_SKIP_INSTALL_DEPS:-0}"
SKIP_BUILD="${KOVALSKY_SKIP_BUILD:-0}"
FORCE_INSTALL="${KOVALSKY_FORCE_INSTALL:-0}"
AUTO_CONFIGURE_PATH="${KOVALSKY_AUTO_CONFIGURE_PATH:-1}"

log() {
  printf '[kovalsky-install] %s\n' "$*"
}

die() {
  printf '[kovalsky-install] ERROR: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Missing required command: $cmd"
  fi
}

ensure_node() {
  need_cmd node
  local version major
  version="$(node -p "process.versions.node" 2>/dev/null || true)"
  if [[ -z "$version" ]]; then
    die "Unable to detect Node.js version."
  fi
  major="${version%%.*}"
  if [[ -z "$major" || "$major" -lt 20 ]]; then
    die "Node.js 20+ is required (found $version)."
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  need_cmd corepack
  log "pnpm not found, enabling through corepack..."
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10.17.1 --activate
  command -v pnpm >/dev/null 2>&1 || die "pnpm is still unavailable after corepack setup."
}

clone_or_update_repo() {
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Existing installation found at $INSTALL_DIR, updating..."
    git -C "$INSTALL_DIR" fetch --tags origin
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    return 0
  fi

  if [[ -d "$INSTALL_DIR" && "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" != "" ]]; then
    if [[ "$FORCE_INSTALL" == "1" ]]; then
      log "Removing non-empty install directory due to KOVALSKY_FORCE_INSTALL=1"
      rm -rf "$INSTALL_DIR"
    else
      die "Install directory exists and is not empty: $INSTALL_DIR (set KOVALSKY_FORCE_INSTALL=1 to overwrite)."
    fi
  fi

  log "Cloning $REPO_URL (branch: $BRANCH) to $INSTALL_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
}

ensure_path_in_shell_rc() {
  if [[ "$AUTO_CONFIGURE_PATH" != "1" ]]; then
    log "Skipping shell PATH auto-configuration (KOVALSKY_AUTO_CONFIGURE_PATH=$AUTO_CONFIGURE_PATH)."
    return 0
  fi

  local shell_name rc_file marker_start marker_end export_line
  shell_name="$(basename "${SHELL:-}")"
  marker_start="# >>> kovalsky path >>>"
  marker_end="# <<< kovalsky path <<<"
  export_line="export PATH=\"$BIN_DIR:\$PATH\""

  if [[ "$shell_name" == "zsh" ]]; then
    rc_file="$HOME/.zshrc"
  elif [[ "$shell_name" == "bash" ]]; then
    if [[ -f "$HOME/.bashrc" || ! -f "$HOME/.bash_profile" ]]; then
      rc_file="$HOME/.bashrc"
    else
      rc_file="$HOME/.bash_profile"
    fi
  else
    log "Unknown shell '$shell_name'; skipping PATH auto-configuration."
    return 0
  fi

  mkdir -p "$(dirname "$rc_file")"
  if [[ ! -f "$rc_file" ]]; then
    : > "$rc_file"
  fi

  if grep -Fq "$export_line" "$rc_file" || grep -Fq "$marker_start" "$rc_file"; then
    log "PATH already configured in $rc_file"
    return 0
  fi

  {
    printf '\n%s\n' "$marker_start"
    printf '%s\n' "$export_line"
    printf '%s\n' "$marker_end"
  } >> "$rc_file"
  log "Added $BIN_DIR to PATH in $rc_file"
}

write_launcher() {
  local launcher_path="$BIN_DIR/kovalsky"
  mkdir -p "$BIN_DIR"

  cat >"$launcher_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${KOVALSKY_INSTALL_DIR:-__INSTALL_DIR__}"
DEFAULT_BRANCH="${KOVALSKY_BRANCH:-main}"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf '[kovalsky] Missing required command: %s\n' "$cmd" >&2
    exit 1
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  need_cmd corepack
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10.17.1 --activate >/dev/null 2>&1
  command -v pnpm >/dev/null 2>&1 || {
    printf '[kovalsky] pnpm is unavailable.\n' >&2
    exit 1
  }
}

usage() {
  cat <<'USAGE'
Usage: kovalsky [command]

Commands:
  start      Start backend + UI dev servers (default)
  backend    Start backend only
  ui         Start UI only
  update     Pull latest code and install dependencies
  path       Print install directory
  help       Show this help

Environment overrides:
  KOVALSKY_BACKEND_PORT   Backend port (default: 18787)
  KOVALSKY_UI_PORT        UI port (default: 3764)
  KOVALSKY_NO_AUTO_OPEN   Set to 1 to disable automatic browser open
USAGE
}

[[ -d "$INSTALL_DIR" ]] || {
  printf '[kovalsky] Install directory not found: %s\n' "$INSTALL_DIR" >&2
  exit 1
}

ensure_pnpm
cmd="${1:-start}"
if [[ $# -gt 0 ]]; then
  shift
fi

DEFAULT_BACKEND_PORT="${KOVALSKY_BACKEND_PORT_DEFAULT:-18787}"
DEFAULT_UI_PORT="${KOVALSKY_UI_PORT_DEFAULT:-3764}"
BACKEND_HOST="${KOVALSKY_HOST:-127.0.0.1}"
UI_HOST="${KOVALSKY_UI_HOST:-127.0.0.1}"

resolve_backend_port() {
  printf '%s' "${KOVALSKY_PORT:-${KOVALSKY_BACKEND_PORT:-$DEFAULT_BACKEND_PORT}}"
}

resolve_ui_port() {
  printf '%s' "${PORT:-${KOVALSKY_UI_PORT:-$DEFAULT_UI_PORT}}"
}

open_browser_url() {
  local url="$1"
  if [[ "${KOVALSKY_NO_AUTO_OPEN:-0}" == "1" ]]; then
    return 0
  fi
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '$url'" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

case "$cmd" in
  start)
    cd "$INSTALL_DIR"
    backend_port="$(resolve_backend_port)"
    ui_port="$(resolve_ui_port)"
    backend_url="http://${BACKEND_HOST}:${backend_port}"
    ui_url="http://${UI_HOST}:${ui_port}"
    ui_open_url="${ui_url}/pipelines"
    backend_allowed_origins="${KOVALSKY_ALLOWED_ORIGINS:-http://localhost:${ui_port},http://127.0.0.1:${ui_port},${ui_url}}"

    printf '[kovalsky] Backend: %s\n' "$backend_url"
    printf '[kovalsky] UI: %s\n' "$ui_open_url"
    if [[ "${KOVALSKY_NO_AUTO_OPEN:-0}" != "1" ]]; then
      printf '[kovalsky] Opening browser...\n'
    fi

    KOVALSKY_PORT="$backend_port" KOVALSKY_ALLOWED_ORIGINS="$backend_allowed_origins" pnpm run dev:watch &
    backend_pid="$!"
    cleanup() {
      kill "$backend_pid" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT INT TERM
    (
      sleep 2
      open_browser_url "$ui_open_url" || true
    ) &
    NEXT_PUBLIC_KOVALSKY_BACKEND_URL="$backend_url" PORT="$ui_port" pnpm --dir ui run dev "$@"
    ;;
  backend)
    cd "$INSTALL_DIR"
    backend_port="$(resolve_backend_port)"
    ui_port="$(resolve_ui_port)"
    ui_url="http://${UI_HOST}:${ui_port}"
    backend_allowed_origins="${KOVALSKY_ALLOWED_ORIGINS:-http://localhost:${ui_port},http://127.0.0.1:${ui_port},${ui_url}}"
    printf '[kovalsky] Backend: http://%s:%s\n' "$BACKEND_HOST" "$backend_port"
    exec KOVALSKY_PORT="$backend_port" KOVALSKY_ALLOWED_ORIGINS="$backend_allowed_origins" pnpm run dev:watch "$@"
    ;;
  ui)
    cd "$INSTALL_DIR"
    backend_port="$(resolve_backend_port)"
    ui_port="$(resolve_ui_port)"
    backend_url="http://${BACKEND_HOST}:${backend_port}"
    printf '[kovalsky] UI: http://%s:%s/pipelines\n' "$UI_HOST" "$ui_port"
    exec NEXT_PUBLIC_KOVALSKY_BACKEND_URL="$backend_url" PORT="$ui_port" pnpm --dir ui run dev "$@"
    ;;
  update)
    need_cmd git
    cd "$INSTALL_DIR"
    git fetch --tags origin
    git checkout "$DEFAULT_BRANCH"
    git pull --ff-only origin "$DEFAULT_BRANCH"
    pnpm install
    ;;
  path)
    printf '%s\n' "$INSTALL_DIR"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf '[kovalsky] Unknown command: %s\n\n' "$cmd" >&2
    usage
    exit 1
    ;;
esac
EOF

  local escaped_install_dir
  escaped_install_dir="$(printf '%s' "$INSTALL_DIR" | sed 's/[\/&]/\\&/g')"
  sed -i.bak "s/__INSTALL_DIR__/$escaped_install_dir/g" "$launcher_path"
  rm -f "$launcher_path.bak"
  chmod +x "$launcher_path"
}

print_finish() {
  log "Installed successfully."
  log "Install dir: $INSTALL_DIR"
  log "Launcher: $BIN_DIR/kovalsky"
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    log "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
  fi
  log "Run: kovalsky start"
}

main() {
  need_cmd git
  need_cmd bash
  ensure_node
  ensure_pnpm
  clone_or_update_repo

  cd "$INSTALL_DIR"
  if [[ "$SKIP_DEPS" != "1" ]]; then
    log "Installing dependencies with pnpm..."
    pnpm install
  else
    log "Skipping dependency installation (KOVALSKY_SKIP_INSTALL_DEPS=1)."
  fi

  if [[ "$SKIP_BUILD" != "1" ]]; then
    log "Building backend..."
    pnpm run build
  else
    log "Skipping build (KOVALSKY_SKIP_BUILD=1)."
  fi

  write_launcher
  ensure_path_in_shell_rc
  print_finish
}

main "$@"
