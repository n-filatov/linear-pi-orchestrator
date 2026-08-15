#!/bin/sh
# Install Task Relay — https://github.com/n-filatov/linear-pi-orchestrator
set -eu

REPOSITORY="${RELAY_REPOSITORY:-n-filatov/linear-pi-orchestrator}"
VERSION="${RELAY_VERSION:-latest}"
BINARY="relay"
INSTALL_DIR="${INSTALL_DIR:-${XDG_BIN_HOME:-${HOME:?HOME is required}/.local/bin}}"
OS="${RELAY_OS:-$(uname -s)}"
ARCH="${RELAY_ARCH:-$(uname -m)}"

fail() {
  echo "Task Relay installer: $*" >&2
  exit 1
}

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64) ASSET="task-relay-macos-arm64" ;;
      x86_64|amd64)  ASSET="task-relay-macos-x64" ;;
      *) fail "unsupported macOS architecture: $ARCH" ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) ASSET="task-relay-linux-x64" ;;
      *) fail "unsupported Linux architecture: $ARCH" ;;
    esac
    ;;
  *) fail "unsupported operating system: $OS" ;;
esac

if command -v curl >/dev/null 2>&1; then
  download() {
    curl --fail --silent --show-error --location "$1" --output "$2"
  }
elif command -v wget >/dev/null 2>&1; then
  download() {
    wget --quiet "$1" --output-document="$2"
  }
else
  fail "curl or wget is required"
fi

RELEASE_BASE="${RELAY_RELEASE_BASE:-https://github.com/${REPOSITORY}/releases/download/${VERSION}}"
mkdir -p "$INSTALL_DIR" || fail "cannot create ${INSTALL_DIR}"
[ -w "$INSTALL_DIR" ] || fail "${INSTALL_DIR} is not writable; choose another directory with INSTALL_DIR"

TEMP_DIR=$(mktemp -d "${INSTALL_DIR}/.task-relay-install.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' 0
trap 'exit 1' HUP INT TERM
TEMP_BINARY="${TEMP_DIR}/${BINARY}"
CHECKSUMS="${TEMP_DIR}/checksums.txt"

echo "Downloading Task Relay ${VERSION} for ${OS}/${ARCH}..."
download "${RELEASE_BASE}/${ASSET}" "$TEMP_BINARY"
download "${RELEASE_BASE}/checksums.txt" "$CHECKSUMS"

EXPECTED_CHECKSUM=$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$CHECKSUMS")
[ -n "$EXPECTED_CHECKSUM" ] || fail "checksums.txt does not contain ${ASSET}"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(sha256sum "$TEMP_BINARY" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(shasum -a 256 "$TEMP_BINARY" | awk '{print $1}')
else
  fail "sha256sum or shasum is required to verify the download"
fi

[ "$EXPECTED_CHECKSUM" = "$ACTUAL_CHECKSUM" ] || fail "checksum verification failed for ${ASSET}"

chmod +x "$TEMP_BINARY"
"$TEMP_BINARY" --version >/dev/null

DESTINATION="${INSTALL_DIR}/${BINARY}"
mv -f "$TEMP_BINARY" "$DESTINATION"

echo "Installed Task Relay to ${DESTINATION}"
"$DESTINATION" --version

case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "Add Task Relay to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
