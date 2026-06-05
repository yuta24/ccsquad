#!/usr/bin/env bash
set -euo pipefail

REPO="yuta24/ccsquad"
BINARY="ccsquad"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)        ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

ASSET="${BINARY}-${OS}-${ARCH}"
BASE_URL="https://github.com/${REPO}/releases/latest/download"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${ASSET}..."
curl -fsSL "${BASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
curl -fsSL "${BASE_URL}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS"

echo "Verifying checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  grep "${ASSET}" "${TMP_DIR}/SHA256SUMS" | (cd "${TMP_DIR}" && sha256sum -c -)
else
  grep "${ASSET}" "${TMP_DIR}/SHA256SUMS" | (cd "${TMP_DIR}" && shasum -a 256 -c -)
fi

chmod +x "${TMP_DIR}/${ASSET}"

if [ -w "$INSTALL_DIR" ]; then
  mv "${TMP_DIR}/${ASSET}" "${INSTALL_DIR}/${BINARY}"
else
  sudo mv "${TMP_DIR}/${ASSET}" "${INSTALL_DIR}/${BINARY}"
fi

echo "Installed: ${INSTALL_DIR}/${BINARY}"
"${INSTALL_DIR}/${BINARY}" --version
