#!/usr/bin/env bash
# Agent-usable smoke for @osfactory/otel-hook: the built CLI must start, print
# its version, and list adapters. Requires `build` to have produced dist/.
set -euo pipefail

AGENT_ID="${1:?Usage: cli-smoke.sh <agent-id>}"
NODE="${NODE_BIN:-node}"
CLI="dist/cli.js"

if [ ! -f "$CLI" ]; then
  echo "cli-smoke: $CLI is missing; run the build stage first (slot $AGENT_ID)." >&2
  exit 1
fi

"$NODE" "$CLI" --version
"$NODE" "$CLI" providers --json >/dev/null
echo "cli-smoke: otel-hook CLI is usable (slot $AGENT_ID)."
