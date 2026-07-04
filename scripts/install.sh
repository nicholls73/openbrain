#!/usr/bin/env bash
set -euo pipefail

OPENBRAIN_REPO_URL="${OPENBRAIN_REPO_URL:-https://github.com/nicholls73/openbrain}"
# Empty means: resolve to the latest published release at install time.
OPENBRAIN_REF="${OPENBRAIN_REF:-}"
OPENBRAIN_INSTALL_DIR="${OPENBRAIN_INSTALL_DIR:-$HOME/.local/share/openbrain/app}"
OPENBRAIN_BIN_DIR="${OPENBRAIN_BIN_DIR:-$HOME/.local/bin}"
OPENBRAIN_SOURCE_DIR="${OPENBRAIN_SOURCE_DIR:-}"

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
  local install_dir="$2"
  local tmp_dir="$3"

  tar -xzf "$tarball" -C "$tmp_dir"
  local extracted
  extracted="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d -name 'openbrain-*' | head -n 1)"
  [[ -n "$extracted" ]] || fail "could not find extracted OpenBrain source."
  rm -rf "$install_dir"
  mkdir -p "$install_dir"
  tar -C "$extracted" -cf - . | tar -C "$install_dir" -xf -
}

# Install a published release: download the release tarball and its checksum
# from the release assets and refuse to install on mismatch. Returns non-zero
# when the ref has no release assets (e.g. a branch).
download_release() {
  local tag="$1"
  local install_dir="$2"
  local base="${OPENBRAIN_REPO_URL}/releases/download/${tag}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  log "downloading release ${tag}"
  if ! curl -fsSL "${base}/openbrain-${tag}.tar.gz" -o "$tmp_dir/openbrain.tar.gz" ||
    ! curl -fsSL "${base}/openbrain-${tag}.tar.gz.sha256" -o "$tmp_dir/openbrain.tar.gz.sha256"; then
    rm -rf "$tmp_dir"
    return 1
  fi

  local expected actual
  expected="$(awk '{print $1}' "$tmp_dir/openbrain.tar.gz.sha256")"
  actual="$(sha256_of "$tmp_dir/openbrain.tar.gz")"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    rm -rf "$tmp_dir"
    fail "checksum mismatch for release ${tag}: expected '${expected}', got '${actual}'"
  fi
  log "checksum verified: ${actual}"

  extract_archive "$tmp_dir/openbrain.tar.gz" "$install_dir" "$tmp_dir"
  rm -rf "$tmp_dir"
}

# Unverified fallback for refs without release assets. The generic archive
# endpoint accepts branches, tags, and commit SHAs.
download_ref() {
  local ref="$1"
  local install_dir="$2"
  local archive_url="${OPENBRAIN_REPO_URL}/archive/${ref}.tar.gz"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  log "downloading ${archive_url}"
  curl -fsSL "$archive_url" -o "$tmp_dir/openbrain.tar.gz"
  extract_archive "$tmp_dir/openbrain.tar.gz" "$install_dir" "$tmp_dir"
  rm -rf "$tmp_dir"
}

download_source() {
  local install_dir="$1"

  if [[ -n "$OPENBRAIN_REF" ]]; then
    if download_release "$OPENBRAIN_REF" "$install_dir"; then
      return
    fi
    log "warning: ${OPENBRAIN_REF} has no release assets to verify; installing it unverified"
    download_ref "$OPENBRAIN_REF" "$install_dir"
    return
  fi

  local tag
  tag="$(latest_release_tag)"
  if [[ -n "$tag" ]]; then
    download_release "$tag" "$install_dir" || fail "failed to download release ${tag}"
    return
  fi

  log "warning: no published release found; installing unverified main branch"
  download_ref "main" "$install_dir"
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
  log "next: openbrain setup"
}

install_openbrain
