#!/bin/sh
# understudy installer (macOS / Linux)
#
#   curl -fsSL https://understudy.cc/install.sh | bash
#
# Installs to ~/.understudy and links an `understudy` command into
# ~/.local/bin. Re-running updates to the latest main. Requires Node 20+.

set -eu

REPO="ariangibson/understudy"
HOME_DIR="${UNDERSTUDY_HOME:-$HOME/.understudy}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="${UNDERSTUDY_BIN_DIR:-$HOME/.local/bin}"
TARBALL_URL="${UNDERSTUDY_TARBALL:-https://codeload.github.com/$REPO/tar.gz/refs/heads/main}"

step() { printf '🎭 %s\n' "$1"; }
fail() { printf 'understudy install: %s\n' "$1" >&2; exit 1; }

# --- prerequisites ----------------------------------------------------------
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
  || fail "curl or wget is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

command -v node >/dev/null 2>&1 \
  || fail "Node.js 20+ is required (install: https://nodejs.org or 'brew install node')"
NODE_MAJOR=$(node --version | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null \
  || fail "Node.js 20+ is required (found $(node --version))"
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node)"

# --- download ---------------------------------------------------------------
step "Downloading understudy..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/understudy.tar.gz"
else
  wget -qO "$TMP_DIR/understudy.tar.gz" "$TARBALL_URL"
fi
tar -xzf "$TMP_DIR/understudy.tar.gz" -C "$TMP_DIR"
SRC_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "understudy-*" | head -1)
[ -n "$SRC_DIR" ] || fail "unexpected tarball layout"

# --- build ------------------------------------------------------------------
step "Installing dependencies and building (this takes a moment)..."
(cd "$SRC_DIR" && npm ci --no-fund --no-audit --loglevel=error)

mkdir -p "$HOME_DIR"
rm -rf "$APP_DIR"
mv "$SRC_DIR" "$APP_DIR"

# --- launcher ---------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/understudy" <<EOF
#!/bin/sh
# understudy launcher - config (.env), usage logs, and OAuth credentials
# live in $HOME_DIR, like ~/.claude and ~/.codex do for their tools.
cd "$HOME_DIR" && exec node "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/understudy"

# --- PATH -------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    PROFILE=""
    case "${SHELL:-}" in
      */zsh) PROFILE="$HOME/.zshrc" ;;
      */bash) [ -f "$HOME/.bash_profile" ] && PROFILE="$HOME/.bash_profile" || PROFILE="$HOME/.bashrc" ;;
    esac
    if [ -n "$PROFILE" ] && ! grep -qs '.local/bin' "$PROFILE"; then
      printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
      step "Added $BIN_DIR to PATH in $PROFILE (open a new terminal to pick it up)"
    else
      step "Add to your PATH: export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

step "Installed. Next:"
printf '\n   understudy setup    # wire up keys, fallback chain, and your harnesses\n'
printf '   understudy          # raise the curtain\n\n'
