#!/bin/sh
# Install linear-pi — https://github.com/n-filatov/linear-pi-orchestrator
set -e

REPO="n-filatov/linear-pi-orchestrator"
BINARY="linear-pi"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)   ASSET="linear-pi-macos-arm64" ;;
      x86_64)  ASSET="linear-pi-macos-x64"   ;;
      *)  echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64)  ASSET="linear-pi-linux-x64" ;;
      *)  echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

URL="https://github.com/${REPO}/releases/download/latest/${ASSET}"
DEST="${INSTALL_DIR}/${BINARY}"

echo "Downloading ${ASSET}..."
if command -v curl >/dev/null 2>&1; then
  curl -fSL "$URL" -o "$DEST"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$DEST"
else
  echo "Error: curl or wget is required" >&2
  exit 1
fi

chmod +x "$DEST"
echo "Installed to ${DEST}"
"$DEST" --version
