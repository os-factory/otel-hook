#!/usr/bin/env bash
# Agent live lab — inner HAR plugin stage.
#
# Not part of default `har env verify`. Invoke explicitly:
#   ./.har/stages/agent-lab.sh
#   npm run lab:claude
#
# Skips (exit 0) when the selected host CLI is missing or AGENT_LAB=0.
# Pass a provider as the first extra arg, or set AGENT_LAB_PROVIDER.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# After `har env add-plugin` this file lives in <repo>/.har/stages/.
# The inner plugin copy lives in har-plugins/agent-lab/.har/stages/.
if [[ -f "$SCRIPT_DIR/../harness.env" ]]; then
  HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
  ARTIFACTS_DIR="${HARNESS_DIR}/artifacts/agent-lab"
  EXTRA_ARGS=()
  if [[ -f "$HARNESS_DIR/harness.env" && -f "$HARNESS_DIR/agent-slot.sh" && "${1:-}" != "" && "${1:-}" =~ ^[0-9]+$ ]]; then
    # shellcheck source=/dev/null
    source "$HARNESS_DIR/harness.env"
    ORIG_SCRIPT_DIR="$SCRIPT_DIR"
    SCRIPT_DIR="$HARNESS_DIR"
    # shellcheck source=/dev/null
    source "$HARNESS_DIR/agent-slot.sh"
    SCRIPT_DIR="$ORIG_SCRIPT_DIR"
    AGENT_ID="$1"
    shift
    if ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT" 2>/dev/null)"; then
      set -a
      # shellcheck source=/dev/null
      source "$ENV_FILE"
      set +a
      if WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE" 2>/dev/null)"; then
        REPO_ROOT="$WORK_DIR"
      fi
    fi
  fi
  EXTRA_ARGS=("$@")
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
  ARTIFACTS_DIR="${REPO_ROOT}/.har/artifacts/agent-lab"
  EXTRA_ARGS=("$@")
fi

mkdir -p "$ARTIFACTS_DIR"

RUNNER="${REPO_ROOT}/har-plugins/agent-lab/scripts/run-lab.mjs"
if [[ ! -f "$RUNNER" ]]; then
  echo "agent-lab runner missing: $RUNNER" >&2
  exit 1
fi

echo "==> [agent-lab] ${RUNNER} ${EXTRA_ARGS[*]:-}" >&2
START=$(date +%s%3N)
set +e
OUTPUT=$(cd "$REPO_ROOT" && node "$RUNNER" "${EXTRA_ARGS[@]}" 2>"$ARTIFACTS_DIR/stderr.log")
EXIT_CODE=$?
set -e
END=$(date +%s%3N)

printf '%s\n' "$OUTPUT" >"$ARTIFACTS_DIR/output.json"

STATUS="fail"
if [[ "$EXIT_CODE" = "0" ]]; then
  if printf '%s' "$OUTPUT" | grep -q '"status": "skip"'; then
    STATUS="skip"
  else
    STATUS="pass"
  fi
fi

TOTAL_MS=$((END - START))
node -e "process.stdout.write(JSON.stringify({
  status: process.argv[1],
  stageId: 'agent-lab',
  kind: 'test',
  total_ms: Number(process.argv[2]),
  outputPath: process.argv[3]
}, null, 2) + '\n');" "$STATUS" "$TOTAL_MS" "$ARTIFACTS_DIR/output.json"

exit "$EXIT_CODE"
