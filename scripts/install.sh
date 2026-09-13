#!/usr/bin/env bash
set -euo pipefail

log_step() { printf "\033[36m[lattice-install]\033[0m %s\n" "$1"; }
log_ok() { printf "\033[32m✔\033[0m %s\n" "$1"; }
log_fail() { printf "\033[31m✖\033[0m %s\n" "$1"; exit 1; }

log_step "Checking environment prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  log_fail "Node.js is not installed. Please install Node.js >= 20.19.0 or >= 22.12.0."
fi

NODE_VER=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)

if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; } || [ "$NODE_MAJOR" -eq 21 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  log_fail "Node.js version $NODE_VER detected. Lattice requires Node.js ^20.19.0 or >= 22.12.0."
fi
log_ok "Node.js $NODE_VER"

if ! command -v git >/dev/null 2>&1; then
  log_fail "Git is not installed. Please install Git."
fi
log_ok "Git"

TARGET_DIR="${LATTICE_INSTALL_DIR:-$HOME/.local/share/lattice-agent}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ]; then
  if grep -q '"name": "lattice-v2"' "$SCRIPT_DIR/../package.json"; then
    TARGET_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    log_step "Using current repository checkout: $TARGET_DIR"
  fi
fi

if [ ! -d "$TARGET_DIR/.git" ]; then
  log_step "Cloning Lattice into $TARGET_DIR..."
  rm -rf "$TARGET_DIR"
  git clone --depth 1 "https://github.com/moulwyse/lattice.git" "$TARGET_DIR"
fi

log_step "Installing dependencies and building..."
(
  cd "$TARGET_DIR"
  npm ci || npm install
  npm run build
)

CLI_PATH="$TARGET_DIR/dist/cli.js"
if [ ! -f "$CLI_PATH" ]; then
  log_fail "Build failed: $CLI_PATH does not exist."
fi
log_ok "Built CLI: $CLI_PATH"

BIN_DIR="${LATTICE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"

for CMD in lattice lattice-v2; do
  LAUNCHER="$BIN_DIR/$CMD"
  cat <<EOF > "$LAUNCHER"
#!/usr/bin/env sh
exec node "$CLI_PATH" "\$@"
EOF
  chmod +x "$LAUNCHER"
  log_ok "Registered command: $LAUNCHER"
done

log_ok "Lattice installed and verified successfully!"
printf "\nTry running:\n  lattice --help\n  lattice benchmark --worker mock\n"
