#!/usr/bin/env bash
# Agent live lab — inner HAR plugin stage.
#
# Not part of default `har env verify`. Invoke explicitly:
#   ./.har/stages/agent-lab.sh
#   npm run lab:claude
#   npm run lab:codex
#
# Assumes the 1.0 stage surface when HAR invokes it: WORK_DIR, ENV_FILE,
# AGENT_ID, and HAR_HARNESS_DIR are already exported. Also runs standalone
# (`npm run lab:*`) without a slot.
#
# Skips (exit 0) when the selected host CLI is missing or AGENT_LAB=0.
# Pass a provider as the first extra arg, or set AGENT_LAB_PROVIDER.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  AGENT_ID="${1}"
  shift
fi

if [[ -n "${WORK_DIR:-}" ]]; then
  REPO_ROOT="$WORK_DIR"
elif [[ -f "$SCRIPT_DIR/../harness.env" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
fi

if [[ -n "${ENV_FILE:-}" && -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

HARNESS_DIR="${HAR_HARNESS_DIR:-${REPO_ROOT}/.har}"
ARTIFACTS_DIR="${HARNESS_DIR}/artifacts/agent-lab"
EXTRA_ARGS=("$@")

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
