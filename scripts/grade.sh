#!/usr/bin/env bash
# Grades one agent's predictions file against the SWE-bench harness, scoped to exactly the pinned
# pilot instances (not the full 300-instance dataset) -- one call per agent instead of one per
# instance. Requires the swebench package installed in a venv (see docs/benchmarking.md); point
# PYTHON_BIN at that venv's interpreter if it's not the default python3 on PATH.
#
# Usage: scripts/grade.sh <predictionsPath> <runId> [pilotInstancesJson]
set -euo pipefail

PREDICTIONS_PATH="${1:?Usage: grade.sh <predictionsPath> <runId> [pilotInstancesJson]}"
RUN_ID="${2:?Usage: grade.sh <predictionsPath> <runId> [pilotInstancesJson]}"
PILOT_FILE="${3:-/tmp/bench/pilot-instances.json}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

IDS=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).map(i=>i.instanceId).join(' '))" "$PILOT_FILE")

"$PYTHON_BIN" -m swebench.harness.run_evaluation \
  --predictions_path "$PREDICTIONS_PATH" \
  --instance_ids $IDS \
  --run_id "$RUN_ID"
