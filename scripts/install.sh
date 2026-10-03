#!/usr/bin/env bash
set -euo pipefail

OPENBRAIN_REPO_URL="${OPENBRAIN_REPO_URL:-https://github.com/nicholls73/openbrain}"
# Empty means: resolve to the latest published release at install time.
OPENBRAIN_REF="${OPENBRAIN_REF:-}"
OPENBRAIN_INSTALL_DIR="${OPENBRAIN_INSTALL_DIR:-$HOME/.local/share/openbrain/app}"
OPENBRAIN_BIN_DIR="${OPENBRAIN_BIN_DIR:-$HOME/.local/bin}"
OPENBRAIN_SOURCE_DIR="${OPENBRAIN_SOURCE_DIR:-}"
OPENBRAIN_SKIP_BIN="${OPENBRAIN_SKIP_BIN:-0}"
OPENBRAIN_INSTALL_DIR="${OPENBRAIN_INSTALL_DIR%/}"
INSTALL_PARENT="$(dirname "$OPENBRAIN_INSTALL_DIR")"
INSTALL_LOCK_DIR="${OPENBRAIN_INSTALL_DIR}.install.lock"
STAGING_DIR=""
BACKUP_DIR=""
LAUNCHER_TMP=""
DOWNLOAD_TMP_DIR=""
LOCK_OWNED=0
PUBLISHING=0

usage() {
  cat <<'EOF'
OpenBrain installer

Install:
  curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash

Environment:
  OPENBRAIN_REF          Git ref to install. Default: the latest release, with
                         its SHA-256 checksum verified. Branch or tag refs
                         without release assets install unverified.
  OPENBRAIN_REPO_URL     GitHub repository URL. Default: https://github.com/nicholls73/openbrain
  OPENBRAIN_INSTALL_DIR  Install location. Default: ~/.local/share/openbrain/app
  OPENBRAIN_BIN_DIR      Directory for the openbrain executable. Default: ~/.local/bin
  OPENBRAIN_SOURCE_DIR   Local source directory for development/testing installs.
  OPENBRAIN_SKIP_BIN     Set to 1 to preserve an existing executable wrapper.

After install:
  openbrain setup
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

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ "$status" -ne 0 && "$PUBLISHING" == "1" && -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
    if ! rm -rf "$OPENBRAIN_INSTALL_DIR"; then
      log "could not remove incomplete installation; previous installation remains at $BACKUP_DIR"
    elif mv "$BACKUP_DIR" "$OPENBRAIN_INSTALL_DIR"; then
      log "restored previous installation"
      BACKUP_DIR=""
    else
      log "could not restore previous installation from $BACKUP_DIR"
    fi
  fi

  [[ -z "$STAGING_DIR" ]] || rm -rf "$STAGING_DIR"
  [[ -z "$LAUNCHER_TMP" ]] || rm -f "$LAUNCHER_TMP"
  [[ -z "$DOWNLOAD_TMP_DIR" ]] || rm -rf "$DOWNLOAD_TMP_DIR"

  if [[ "$LOCK_OWNED" == "1" && "$(cat "$INSTALL_LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "$INSTALL_LOCK_DIR"
  fi

  return "$status"
}

acquire_install_lock() {
  mkdir -p "$INSTALL_PARENT"

  if ! mkdir "$INSTALL_LOCK_DIR" 2>/dev/null; then
    local owner
    owner="$(cat "$INSTALL_LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ "$owner" =~ ^[0-9]+$ ]]; then
      fail "another OpenBrain installation may be active (pid $owner); if it stopped, verify that before removing $INSTALL_LOCK_DIR"
    fi
    fail "another OpenBrain installation may be initializing; verify that it stopped before removing $INSTALL_LOCK_DIR"
  fi

  LOCK_OWNED=1
  printf '%s\n' "$$" > "$INSTALL_LOCK_DIR/pid"
}

recover_interrupted_install() {
  for stale_stage in "${OPENBRAIN_INSTALL_DIR}".staging.*; do
    [[ -e "$stale_stage" ]] || continue
    rm -rf "$stale_stage"
  done

  if [[ ! -e "$OPENBRAIN_INSTALL_DIR" ]]; then
    for local_backup in "${OPENBRAIN_INSTALL_DIR}".backup.*; do
      if [[ -d "$local_backup" ]] && mv "$local_backup" "$OPENBRAIN_INSTALL_DIR"; then
        log "restored previous installation after interrupted update"
        return
      fi
    done
  else
    for local_backup in "${OPENBRAIN_INSTALL_DIR}".backup.*; do
      [[ -e "$local_backup" ]] || continue
      rm -rf "$local_backup"
    done
  fi
}

copy_local_source() {
  local source_dir="$1"
  local staging_dir="$2"

  [[ -f "$source_dir/package.json" ]] || fail "OPENBRAIN_SOURCE_DIR must point at the OpenBrain repo root."
  tar \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    -C "$source_dir" \
    -cf - . | tar -C "$staging_dir" -xf -
}

repo_slug() {
  printf '%s' "${OPENBRAIN_REPO_URL#https://github.com/}"
}

latest_release_tag() {
  curl -fsSL "https://api.github.com/repos/$(repo_slug)/releases/latest" 2>/dev/null |
    grep -m1 '"tag_name"' |
    sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

extract_archive() {
  local tarball="$1"
  local staging_dir="$2"
  local tmp_dir="$3"

  tar -xzf "$tarball" -C "$tmp_dir"
  local extracted
  extracted="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d -name 'openbrain-*' | head -n 1)"
  [[ -n "$extracted" ]] || fail "could not find extracted OpenBrain source."
  tar -C "$extracted" -cf - . | tar -C "$staging_dir" -xf -
}

# Install a published release: download the release tarball and its checksum
# from the release assets and refuse to install on mismatch. Returns non-zero
# when the ref has no release assets (e.g. a branch).
download_release() {
  local tag="$1"
  local staging_dir="$2"
  local base="${OPENBRAIN_REPO_URL}/releases/download/${tag}"
  DOWNLOAD_TMP_DIR="$(mktemp -d)"

  log "downloading release ${tag}"
  if ! curl -fsSL "${base}/openbrain-${tag}.tar.gz" -o "$DOWNLOAD_TMP_DIR/openbrain.tar.gz" ||
    ! curl -fsSL "${base}/openbrain-${tag}.tar.gz.sha256" -o "$DOWNLOAD_TMP_DIR/openbrain.tar.gz.sha256"; then
    rm -rf "$DOWNLOAD_TMP_DIR"
    DOWNLOAD_TMP_DIR=""
    return 1
  fi

  local expected actual
  expected="$(awk '{print $1}' "$DOWNLOAD_TMP_DIR/openbrain.tar.gz.sha256")"
  actual="$(sha256_of "$DOWNLOAD_TMP_DIR/openbrain.tar.gz")"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    rm -rf "$DOWNLOAD_TMP_DIR"
    DOWNLOAD_TMP_DIR=""
    fail "checksum mismatch for release ${tag}: expected '${expected}', got '${actual}'"
  fi
  log "checksum verified: ${actual}"

  extract_archive "$DOWNLOAD_TMP_DIR/openbrain.tar.gz" "$staging_dir" "$DOWNLOAD_TMP_DIR"
  rm -rf "$DOWNLOAD_TMP_DIR"
  DOWNLOAD_TMP_DIR=""
}

# Unverified fallback for refs without release assets. The generic archive
# endpoint accepts branches, tags, and commit SHAs.
download_ref() {
  local ref="$1"
  local staging_dir="$2"
  local archive_url="${OPENBRAIN_REPO_URL}/archive/${ref}.tar.gz"
  DOWNLOAD_TMP_DIR="$(mktemp -d)"

  log "downloading ${archive_url}"
  curl -fsSL "$archive_url" -o "$DOWNLOAD_TMP_DIR/openbrain.tar.gz"
  extract_archive "$DOWNLOAD_TMP_DIR/openbrain.tar.gz" "$staging_dir" "$DOWNLOAD_TMP_DIR"
  rm -rf "$DOWNLOAD_TMP_DIR"
  DOWNLOAD_TMP_DIR=""
}

download_source() {
  local staging_dir="$1"

  if [[ -n "$OPENBRAIN_REF" ]]; then
    if download_release "$OPENBRAIN_REF" "$staging_dir"; then
      return
    fi
    log "warning: ${OPENBRAIN_REF} has no release assets to verify; installing it unverified"
    download_ref "$OPENBRAIN_REF" "$staging_dir"
    return
  fi

  local tag
  tag="$(latest_release_tag)"
  if [[ -n "$tag" ]]; then
    download_release "$tag" "$staging_dir" || fail "failed to download release ${tag}"
    return
  fi

  log "warning: no published release found; installing unverified main branch"
  download_ref "main" "$staging_dir"
}

prepare_launcher() {
  [[ "$OPENBRAIN_SKIP_BIN" == "1" ]] && return

  mkdir -p "$OPENBRAIN_BIN_DIR"
  [[ ! -d "$OPENBRAIN_BIN_DIR/openbrain" ]] || fail "executable path is a directory: $OPENBRAIN_BIN_DIR/openbrain"
  LAUNCHER_TMP="$(mktemp "$OPENBRAIN_BIN_DIR/.openbrain.XXXXXX")"
  cat > "$LAUNCHER_TMP" <<EOF
#!/usr/bin/env bash
exec node "$OPENBRAIN_INSTALL_DIR/dist/cli.js" "\$@"
EOF
  chmod +x "$LAUNCHER_TMP"
}

validate_staged_cli() {
  local expected_version actual_version
  expected_version="$(cd "$STAGING_DIR" && node -p 'require("./package.json").version')"
  actual_version="$(cd "$STAGING_DIR" && node ./dist/cli.js --version)"
  [[ "$actual_version" == "$expected_version" ]] ||
    fail "staged CLI version mismatch: expected '${expected_version}', got '${actual_version}'"
}

publish_installation() {
  if [[ -e "$OPENBRAIN_INSTALL_DIR" ]]; then
    BACKUP_DIR="${OPENBRAIN_INSTALL_DIR}.backup.$$.$RANDOM"
    PUBLISHING=1
    mv "$OPENBRAIN_INSTALL_DIR" "$BACKUP_DIR"
  fi

  PUBLISHING=1
  mv "$STAGING_DIR" "$OPENBRAIN_INSTALL_DIR"
  STAGING_DIR=""

  if [[ "$OPENBRAIN_SKIP_BIN" != "1" ]]; then
    mv -f "$LAUNCHER_TMP" "$OPENBRAIN_BIN_DIR/openbrain"
    LAUNCHER_TMP=""
  fi

  PUBLISHING=0
  local previous_install="$BACKUP_DIR"
  BACKUP_DIR=""
  if [[ -n "$previous_install" ]]; then
    rm -rf "$previous_install" || log "could not remove previous installation at $previous_install"
  fi
}

install_openbrain() {
  case "$OPENBRAIN_INSTALL_DIR" in
    ""|"."|".."|*/.|*/..)
      fail "OPENBRAIN_INSTALL_DIR must name an application directory, not a filesystem root or dot directory."
      ;;
  esac

  ensure_node
  ensure_pnpm
  acquire_install_lock
  recover_interrupted_install
  STAGING_DIR="$(mktemp -d "${OPENBRAIN_INSTALL_DIR}.staging.XXXXXX")"

  if [[ -n "$OPENBRAIN_SOURCE_DIR" ]]; then
    log "installing from local source: $OPENBRAIN_SOURCE_DIR"
    copy_local_source "$OPENBRAIN_SOURCE_DIR" "$STAGING_DIR"
  else
    download_source "$STAGING_DIR"
  fi

  log "installing dependencies"
  (cd "$STAGING_DIR" && pnpm install --frozen-lockfile)

  log "building CLI"
  (cd "$STAGING_DIR" && pnpm build)

  log "validating staged CLI"
  validate_staged_cli
  prepare_launcher
  publish_installation

  if [[ "$OPENBRAIN_SKIP_BIN" != "1" ]]; then
    log "installed executable: $OPENBRAIN_BIN_DIR/openbrain"
    if [[ ":$PATH:" != *":$OPENBRAIN_BIN_DIR:"* ]]; then
      log "add this to your shell profile if openbrain is not found:"
      log "export PATH=\"$OPENBRAIN_BIN_DIR:\$PATH\""
    fi
  fi
  log "next: openbrain setup"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install_openbrain
