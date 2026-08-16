#!/usr/bin/env bash
# Runs Claude Code once per pinned pilot instance, prepared beforehand by
# `tsx src/bench/prepare-claude-pilot.ts <pilotInstancesJson> <workDir>`.
#
# This has to run in your own terminal, not from within a Claude Code session driving it --
# a nested `claude -p --permission-mode bypassPermissions` call gets blocked by the permission
# classifier when invoked that way (correctly: it's a real blast-radius action, not a bug to
# route around). Each instance is a disposable git clone, not your real project, so the bypass
# is scoped to a throwaway sandbox.
#
# Usage: scripts/run-claude-pilot.sh <workDir>   (workDir must match what prepare-claude-pilot.ts used)
set -euo pipefail

WORK_DIR="${1:?Usage: run-claude-pilot.sh <workDir>}"

count=0
total=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d ! -name "_repo-cache" | wc -l | tr -d ' ')

for instance_dir in "$WORK_DIR"/*/; do
  instance_id="$(basename "$instance_dir")"
  if [ "$instance_id" = "_repo-cache" ]; then
    continue
  fi
  count=$((count + 1))
  echo "=== [$count/$total] $instance_id ==="

  problem_file="${instance_dir}problem.txt"
  repo_dir="${instance_dir}repo"
  result_file="${instance_dir}result.json"

  if [ -f "$result_file" ]; then
    echo "  already has a result.json, skipping (delete it to re-run this instance)"
    continue
  fi

  (
    cd "$repo_dir"
    claude -p "$(cat "$problem_file")" --output-format json --permission-mode bypassPermissions > "$result_file"
  )
  echo "  done -> $result_file"
done

echo ""
echo "All instances run. Next: tsx src/bench/assemble-claude-predictions.ts <pilotInstancesJson> $WORK_DIR <predictionsOutPath> <logOutPath>"
