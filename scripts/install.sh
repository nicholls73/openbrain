#!/usr/bin/env bash
set -euo pipefail

OPENBRAIN_REPO_URL="${OPENBRAIN_REPO_URL:-https://github.com/nicholls73/openbrain}"
OPENBRAIN_REF="${OPENBRAIN_REF:-main}"
OPENBRAIN_INSTALL_DIR="${OPENBRAIN_INSTALL_DIR:-$HOME/.local/share/openbrain/app}"
OPENBRAIN_BIN_DIR="${OPENBRAIN_BIN_DIR:-$HOME/.local/bin}"
OPENBRAIN_SOURCE_DIR="${OPENBRAIN_SOURCE_DIR:-}"

usage() {
  cat <<'EOF'
OpenBrain installer

Install:
  curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash

Environment:
  OPENBRAIN_REF          Git ref to install. Default: main
  OPENBRAIN_REPO_URL     GitHub repository URL. Default: https://github.com/nicholls73/openbrain
  OPENBRAIN_INSTALL_DIR  Install location. Default: ~/.local/share/openbrain/app
  OPENBRAIN_BIN_DIR      Directory for the openbrain executable. Default: ~/.local/bin
  OPENBRAIN_SOURCE_DIR   Local source directory for development/testing installs.

After install:
  openbrain init
  openbrain agents sync codex
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

log() {
  printf 'openbrain: %s\n' "$*"
}

fail() {
  printf 'openbrain: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

node_major() {
  node -e 'const major = Number(process.versions.node.split(".")[0]); process.stdout.write(String(major));'
}

ensure_node() {
  require_command node
  local major
  major="$(node_major)"
  if [[ "$major" -lt 22 ]]; then
    fail "Node.js 22 or newer is required. Found Node $(node --version)."
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    log "pnpm not found; enabling pnpm through corepack"
    corepack enable pnpm >/dev/null 2>&1 || true
  fi

  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Install it or enable it with corepack."
}

copy_local_source() {
  local source_dir="$1"
  local install_dir="$2"

  [[ -f "$source_dir/package.json" ]] || fail "OPENBRAIN_SOURCE_DIR must point at the OpenBrain repo root."
  rm -rf "$install_dir"
  mkdir -p "$install_dir"
  tar \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    -C "$source_dir" \
    -cf - . | tar -C "$install_dir" -xf -
}

download_source() {
  local install_dir="$1"
  local archive_url="${OPENBRAIN_REPO_URL}/archive/refs/heads/${OPENBRAIN_REF}.tar.gz"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  rm -rf "$install_dir"
  mkdir -p "$install_dir"

  log "downloading ${archive_url}"
  curl -fsSL "$archive_url" -o "$tmp_dir/openbrain.tar.gz"
  tar -xzf "$tmp_dir/openbrain.tar.gz" -C "$tmp_dir"
  local extracted
  extracted="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d -name 'openbrain-*' | head -n 1)"
  [[ -n "$extracted" ]] || fail "could not find extracted OpenBrain source."
  tar -C "$extracted" -cf - . | tar -C "$install_dir" -xf -
  rm -rf "$tmp_dir"
}

install_openbrain() {
  ensure_node
  ensure_pnpm

  if [[ -n "$OPENBRAIN_SOURCE_DIR" ]]; then
    log "installing from local source: $OPENBRAIN_SOURCE_DIR"
    copy_local_source "$OPENBRAIN_SOURCE_DIR" "$OPENBRAIN_INSTALL_DIR"
  else
    download_source "$OPENBRAIN_INSTALL_DIR"
  fi

  log "installing dependencies"
  (cd "$OPENBRAIN_INSTALL_DIR" && pnpm install --frozen-lockfile)

  log "building CLI"
  (cd "$OPENBRAIN_INSTALL_DIR" && pnpm build)

  mkdir -p "$OPENBRAIN_BIN_DIR"
  cat > "$OPENBRAIN_BIN_DIR/openbrain" <<EOF
#!/usr/bin/env bash
exec node "$OPENBRAIN_INSTALL_DIR/dist/cli.js" "\$@"
EOF
  chmod +x "$OPENBRAIN_BIN_DIR/openbrain"

  log "installed executable: $OPENBRAIN_BIN_DIR/openbrain"
  if [[ ":$PATH:" != *":$OPENBRAIN_BIN_DIR:"* ]]; then
    log "add this to your shell profile if openbrain is not found:"
    log "export PATH=\"$OPENBRAIN_BIN_DIR:\$PATH\""
  fi
  log "next: openbrain init && openbrain agents sync codex"
}

install_openbrain
