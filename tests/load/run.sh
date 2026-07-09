#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BASE_URL="${BASE_URL:-http://localhost:3001}"

echo "==> Eco Load Test Suite"
echo "  API: $BASE_URL"
echo "  Timestamp: $TIMESTAMP"
echo ""

run_test() {
  local name=$1
  local script=$2
  local extra_env=${3:-""}

  echo "==> Running: $name"
  eval "$extra_env" k6 run \
    --env BASE_URL="$BASE_URL" \
    --out json="$RESULTS_DIR/${name}_${TIMESTAMP}.json" \
    --summary-export="$RESULTS_DIR/${name}_${TIMESTAMP}_summary.json" \
    "$script" || echo "  WARN: $name had failures"
  echo ""
}

# Run tests in sequence
run_test "health-check" "$SCRIPT_DIR/health-check.js"

echo "==> All tests complete. Results in: $RESULTS_DIR/"
