#!/usr/bin/env bash
set -euo pipefail

log_step() { printf "\033[36m[lattice-install]\033[0m %s\n" "$1"; }
log_ok() { printf "\033[32m✔\033[0m %s\n" "$1"; }
log_warn() { printf "\033[33m!\033[0m %s\n" "$1"; }
log_fail() { printf "\033[31m✖\033[0m %s\n" "$1"; exit 1; }

REPOSITORY_URL="https://github.com/moulwyse/lattice.git"
# Release tag to install by default; `curl ... | bash` users can set LATTICE_REF
# to another tag or to `main` for unreleased code.
DEFAULT_REF="v2.1.0"
REF="${LATTICE_REF:-$DEFAULT_REF}"

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
LOCAL_CHECKOUT=0

# Only a script run from a file can be inside a checkout; `curl | bash` has no
# script path, and the current directory must not be mistaken for one.
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  if [ -f "$SCRIPT_DIR/../package.json" ] && grep -q '"name": "lattice-v2"' "$SCRIPT_DIR/../package.json"; then
    TARGET_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    LOCAL_CHECKOUT=1
    log_step "Using current repository checkout: $TARGET_DIR"
  fi
fi

if [ "$LOCAL_CHECKOUT" -eq 0 ]; then
  if [ -d "$TARGET_DIR/.git" ]; then
    ORIGIN="$(git -C "$TARGET_DIR" remote get-url origin 2>/dev/null || true)"
    case "$ORIGIN" in
      *moulwyse/lattice|*moulwyse/lattice.git) ;;
      *) log_fail "$TARGET_DIR is a Git checkout of another project; set LATTICE_INSTALL_DIR to a different directory." ;;
    esac
    log_step "Updating existing installation in $TARGET_DIR to $REF..."
    git -C "$TARGET_DIR" fetch --tags --force origin
    if git -C "$TARGET_DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      git -C "$TARGET_DIR" checkout "$REF"
      git -C "$TARGET_DIR" pull --ff-only origin "$REF"
    else
      git -C "$TARGET_DIR" checkout --detach "$REF"
    fi
  else
    # Never delete a directory this script did not create.
    if [ -e "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
      log_fail "$TARGET_DIR already exists and is not a Lattice checkout. Remove it yourself or set LATTICE_INSTALL_DIR."
    fi
    log_step "Cloning Lattice $REF into $TARGET_DIR..."
    git clone --branch "$REF" --depth 1 "$REPOSITORY_URL" "$TARGET_DIR"
  fi
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

log_step "Verifying installation..."
node "$CLI_PATH" --version
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) log_warn "$BIN_DIR is not on PATH; add it to your shell profile to run 'lattice'." ;;
esac

log_ok "Lattice installed and verified successfully!"
printf "\nTry running:\n  lattice --help\n  lattice benchmark --worker mock\n"
