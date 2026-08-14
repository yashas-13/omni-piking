#!/bin/bash
# =============================================================================
# Omni-Piking: Sandbox + Agent Launcher
#
# Launches coding agents inside a sandbox with optional YOLO (full CLI) mode.
# Research sources:
#  - agentos-core/src/sandbox/manager.ts
#  - agentos-core/src/security/manager.ts
#  - openclaw-shallow/src/agents/acp-spawn.ts (sandbox inheritance)
#  - openclaw-shallow/src/agents/bash-tools.exec-host-node.ts (YOLO bypass)
#  - Official Android CLI: adb, sdkmanager, apksigner, aapt2, etc.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_ROOT="${HOME}/.claude/sandboxes"
YOLO_LOGS_DIR="${HOME}/.claude/yolo-logs"
ANDROID_ROOT="${ANDROID_ROOT:-$HOME/Android/Sdk}"

# Defaults
YOLO_MODE="${YOLO_MODE:-0}"
AGENT_NAME="${AGENT_NAME:-omniking}"
SANDBOX_ID=""

usage() {
  cat << EOF
Usage: $0 [OPTIONS]

Options:
  -a, --agent NAME     Agent to launch (default: omniking)
  -y, --yolo           Enable YOLO mode (full CLI access, logged)
  -s, --sandbox ID     Use existing sandbox ID
  -c, --cleanup ID     Destroy sandbox by ID
  -h, --help           Show this help

Examples:
  $0 -a omniking                 # Standard sandbox
  $0 -a omniking --yolo          # YOLO full-access mode
  $0 -c \$SANDBOX_ID             # Cleanup
EOF
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--agent) AGENT_NAME="$2"; shift 2 ;;
    -y|--yolo) YOLO_MODE=1; shift ;;
    -s|--sandbox) SANDBOX_ID="$2"; shift 2 ;;
    -c|--cleanup) CLEANUP_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

# Create sandbox if not provided
if [[ -z "${SANDBOX_ID:-}" ]]; then
  SANDBOX_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  mkdir -p "$SANDBOX_ROOT/$SANDBOX_ID"
fi
SANDBOX_DIR="$SANDBOX_ROOT/$SANDBOX_ID"

# Environment setup
export SANDBOX_ID
export SANDBOX_DIR
export PATH="$ANDROID_ROOT/platform-tools:$ANDROID_ROOT/cmdline-tools/latest/bin:$ANDROID_ROOT/build-tools/34.0.0:$PATH"

echo "📦 Sandbox: $SANDBOX_ID"
echo "📂 Work dir: $SANDBOX_DIR"
echo "🤖 Agent: $AGENT_NAME"

if [[ "$YOLO_MODE" == "1" ]]; then
  echo "⚠️  YOLO MODE ENABLED — full CLI access (all commands logged to $YOLO_LOGS_DIR)"
  export SANDBOX_YOLO=1
  YOLO_FLAG="--yolo"
  # YOLO audit entry
  echo "[$(date -Iseconds)] YOLO START: agent=$AGENT_NAME sandbox=$SANDBOX_ID" >> "$YOLO_LOGS_DIR/audit.log"
else
  echo "🛡️  Standard sandbox mode (approval gates active)"
  YOLO_FLAG=""
fi

# Launch agent via node (using the TypeScript setup)
cd "$SCRIPT_DIR"
if [[ -f "sandbox-agent-setup.ts" ]]; then
  node --import tsx sandbox-agent-setup.ts \
    --agent "$AGENT_NAME" $YOLO_FLAG \
    --sandbox "$SANDBOX_ID" 2>&1 | tee -a "$YOLO_LOGS_DIR/$SANDBOX_ID.log"
else
  echo "❌ sandbox-agent-setup.ts not found"
  exit 1
fi

# Cleanup trap
cleanup() {
  echo "🧹 Cleaning up sandbox: $SANDBOX_ID"
  rm -rf "$SANDBOX_DIR"
}
trap cleanup EXIT
