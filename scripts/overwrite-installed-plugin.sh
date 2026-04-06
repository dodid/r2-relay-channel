#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  overwrite-installed-plugin.sh <package.tgz> <installed-plugin-dir>

Extract an OpenClaw plugin package tarball and overwrite files in an existing
installed plugin directory without deleting the directory itself.

Examples:
  overwrite-installed-plugin.sh ./r2-relay-channel-0.2.0.tgz ~/.openclaw/plugins/r2-relay-channel
  overwrite-installed-plugin.sh /tmp/plugin.tgz /var/lib/openclaw/plugins/r2-relay-channel

Notes:
- npm/openclaw package tarballs usually contain a top-level "package/" folder.
- This script overwrites existing files in the destination.
- It does not remove files that no longer exist in the tarball.
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 1
fi

TGZ_FILE=$1
DEST_DIR=$2

if [[ ! -f "$TGZ_FILE" ]]; then
  echo "error: tgz file not found: $TGZ_FILE" >&2
  exit 1
fi

if [[ ! -d "$DEST_DIR" ]]; then
  echo "error: destination directory not found: $DEST_DIR" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Extract tarball into temp dir.
tar -xzf "$TGZ_FILE" -C "$TMP_DIR"

SRC_DIR="$TMP_DIR/package"
if [[ ! -d "$SRC_DIR" ]]; then
  mapfile -t top_dirs < <(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
  if [[ ${#top_dirs[@]} -eq 1 ]]; then
    SRC_DIR=${top_dirs[0]}
  else
    echo "error: could not find extracted package directory under $TMP_DIR" >&2
    exit 1
  fi
fi

# Overwrite files in place without deleting the destination directory.
cp -a "$SRC_DIR"/. "$DEST_DIR"/

echo "Updated installed plugin in place: $DEST_DIR"
