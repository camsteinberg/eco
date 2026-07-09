#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
#
# Smoke test script for Eco staging environment.
# Verifies health, readiness, and key API endpoints.

set -euo pipefail

API_URL="${ECO_API_URL:-https://api.econetwork.ai}"
WEB_URL="${ECO_WEB_URL:-https://econetwork.ai}"

passed=0
failed=0

check() {
  local name="$1" url="$2" expect_field="$3"
  local response status

  # Capture HTTP status code and body
  response=$(curl -sf -w "\n%{http_code}" "$url" 2>/dev/null) || {
    printf "  \033[1;31m✗\033[0m %-25s FAILED (connection error)\n" "$name"
    failed=$((failed + 1))
    return
  }

  status=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
    if [ -n "$expect_field" ]; then
      if printf '%s' "$body" | grep -q "$expect_field"; then
        printf "  \033[1;32m✓\033[0m %-25s ok\n" "$name"
        passed=$((passed + 1))
      else
        printf "  \033[1;31m✗\033[0m %-25s FAILED (missing: %s)\n" "$name" "$expect_field"
        failed=$((failed + 1))
      fi
    else
      printf "  \033[1;32m✓\033[0m %-25s ok\n" "$name"
      passed=$((passed + 1))
    fi
  else
    printf "  \033[1;31m✗\033[0m %-25s FAILED (HTTP %s)\n" "$name" "$status"
    failed=$((failed + 1))
  fi
}

check_readiness() {
  local name="$1" url="$2"
  local response status body

  response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null) || {
    printf "  \033[1;31m✗\033[0m %-25s FAILED (connection error)\n" "$name"
    failed=$((failed + 1))
    return
  }

  status=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$status" = "200" ]; then
    # Extract check values for display
    db_status=$(echo "$body" | grep -o '"database":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
    redis_status=$(echo "$body" | grep -o '"redis":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
    detail=""
    [ -n "$db_status" ] && detail="database: $db_status"
    [ -n "$redis_status" ] && detail="$detail, redis: $redis_status"
    printf "  \033[1;32m✓\033[0m %-25s ok (%s)\n" "$name" "$detail"
    passed=$((passed + 1))
  elif [ "$status" = "503" ]; then
    # Degraded — show which checks failed
    printf "  \033[1;33m!\033[0m %-25s DEGRADED (HTTP 503)\n" "$name"
    echo "    Response: $body"
    failed=$((failed + 1))
  else
    printf "  \033[1;31m✗\033[0m %-25s FAILED (HTTP %s)\n" "$name" "$status"
    failed=$((failed + 1))
  fi
}

echo ""
echo "Eco Staging Smoke Tests"
echo "======================"
echo ""
echo "API:          $API_URL"
echo "Web:          $WEB_URL"
echo ""

# ── Helper: check for a specific HTTP status code ────────────────────────────
check_status() {
  local name="$1" method="$2" url="$3" body="$4" expect_status="$5"
  local response status

  response=$(curl -s -w "\n%{http_code}" -X "$method" \
    -H "Content-Type: application/json" \
    ${body:+-d "$body"} \
    "$url" 2>/dev/null) || {
    printf "  \033[1;31m✗\033[0m %-25s FAILED (connection error)\n" "$name"
    failed=$((failed + 1))
    return
  }

  status=$(echo "$response" | tail -1)

  if [ "$status" = "$expect_status" ]; then
    printf "  \033[1;32m✓\033[0m %-25s ok (HTTP %s)\n" "$name" "$status"
    passed=$((passed + 1))
  else
    printf "  \033[1;31m✗\033[0m %-25s FAILED (expected HTTP %s, got %s)\n" "$name" "$expect_status" "$status"
    failed=$((failed + 1))
  fi
}

# ── Helper: pass if the status matches ANY of the accepted codes ─────────────
# Use for environment-dependent endpoints (e.g. docs gated on/off per deploy).
check_status_in() {
  local name="$1" method="$2" url="$3" body="$4"
  shift 4
  local accepted=("$@")
  local response status

  response=$(curl -s -w "\n%{http_code}" -X "$method" \
    -H "Content-Type: application/json" \
    ${body:+-d "$body"} \
    "$url" 2>/dev/null) || {
    printf "  \033[1;31m✗\033[0m %-25s FAILED (connection error)\n" "$name"
    failed=$((failed + 1))
    return
  }

  status=$(echo "$response" | tail -1)

  local code
  for code in "${accepted[@]}"; do
    if [ "$status" = "$code" ]; then
      printf "  \033[1;32m✓\033[0m %-25s ok (HTTP %s)\n" "$name" "$status"
      passed=$((passed + 1))
      return
    fi
  done

  printf "  \033[1;31m✗\033[0m %-25s FAILED (expected one of [%s], got %s)\n" "$name" "${accepted[*]}" "$status"
  failed=$((failed + 1))
}

echo "── Infrastructure ──────────────────────────────"
echo ""

check          "API health"          "$API_URL/health"           '"status":"ok"'
check_readiness "API readiness"      "$API_URL/health/ready"

# OpenAPI/docs are gated off in production (NODE_ENV=production) unless
# ECO_ENABLE_API_DOCS=true. Staging also runs NODE_ENV=production, so the spec
# may be 200 (docs enabled) or 404 (gated). Accept either — don't hard-expect 200.
check_status_in "OpenAPI spec (gated)"  "GET" "$API_URL/v1/openapi.json" "" "200" "404"

echo ""
echo "── Removed legacy routes (must be 404) ────────"
echo ""

# These endpoints belonged to the decentralized-inference / network surface that
# was removed in Wave D (chat is now 100% on-device). They must return 404 — the
# probe actively verifies the removal stuck.
check_status   "Chat completions gone"  "POST" "$API_URL/v1/chat/completions" \
  '{"model":"eco-small","messages":[{"role":"user","content":"hi"}]}' "404"
check_status   "Models endpoint gone"   "GET"  "$API_URL/v1/models"          "" "404"
check_status   "Model registry gone"    "GET"  "$API_URL/v1/models/registry" "" "404"
check_status   "Governance gone"        "GET"  "$API_URL/v1/governance/proposals" "" "404"
check_status   "Internal token gone"    "POST" "$API_URL/internal/token" \
  '{"job_id":"smoke","miner_id":"smoke","tokens":[]}' "404"

echo ""
echo "── Web Frontend ───────────────────────────────"
echo ""

# Web frontend: accept 200 (no gate) or 307 redirect to /gate (password gate active)
web_status=$(curl -s -o /dev/null -w "%{http_code}" "$WEB_URL" 2>/dev/null || echo "000")
if [ "$web_status" = "200" ]; then
  printf "  \033[1;32m✓\033[0m %-25s ok (public)\n" "Web frontend"
  passed=$((passed + 1))
elif [ "$web_status" = "307" ]; then
  printf "  \033[1;32m✓\033[0m %-25s ok (password gate active)\n" "Web frontend"
  passed=$((passed + 1))
else
  printf "  \033[1;31m✗\033[0m %-25s FAILED (HTTP %s)\n" "Web frontend" "$web_status"
  failed=$((failed + 1))
fi

echo ""
echo "── Billing ────────────────────────────────────"
echo ""

# Billing checkout (should return 401 without auth, proving the route exists)
check_status   "Billing checkout"     "POST" "$API_URL/v1/billing/checkout" \
  '{"tier":"supporter"}' "401"

echo ""
echo "── Metrics ────────────────────────────────────"
echo ""

# /metrics is gated behind METRICS_TOKEN (SECURITY.md H2): in production it is
# 404 when unconfigured, 401 without a valid Bearer token, and 200 + the
# Prometheus body with one. When ECO_METRICS_TOKEN is provided we assert the
# authenticated 200; otherwise we accept the gated outcomes (the route is
# protected, not broken).
METRICS_TOKEN="${ECO_METRICS_TOKEN:-}"
if [ -n "$METRICS_TOKEN" ]; then
  metrics_resp=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $METRICS_TOKEN" "$API_URL/metrics" 2>/dev/null || true)
  metrics_status=$(echo "$metrics_resp" | tail -1)
  metrics_body=$(echo "$metrics_resp" | sed '$d')
  if [ "$metrics_status" = "200" ] && printf '%s' "$metrics_body" | grep -q "http_requests_total"; then
    printf "  \033[1;32m✓\033[0m %-25s ok (authenticated)\n" "API metrics"
    passed=$((passed + 1))
  else
    printf "  \033[1;31m✗\033[0m %-25s FAILED (HTTP %s with token)\n" "API metrics" "$metrics_status"
    failed=$((failed + 1))
  fi
else
  metrics_status=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/metrics" 2>/dev/null || echo "000")
  case "$metrics_status" in
    401 | 404)
      printf "  \033[1;32m✓\033[0m %-25s ok (gated, HTTP %s — set ECO_METRICS_TOKEN to scrape)\n" "API metrics" "$metrics_status"
      passed=$((passed + 1))
      ;;
    200)
      printf "  \033[1;33m!\033[0m %-25s open (HTTP 200 — METRICS_TOKEN unset on this deploy)\n" "API metrics"
      passed=$((passed + 1))
      ;;
    *)
      printf "  \033[1;31m✗\033[0m %-25s FAILED (HTTP %s)\n" "API metrics" "$metrics_status"
      failed=$((failed + 1))
      ;;
  esac
fi

echo ""
total=$((passed + failed))

if [ "$failed" -eq 0 ]; then
  printf "\033[1;32mAll %d checks passed — staging is live!\033[0m\n" "$total"
else
  printf "\033[1;31m%d of %d checks failed.\033[0m\n" "$failed" "$total"
  echo ""
  echo "Troubleshooting:"
  echo "  fly logs -a eco-api-staging"
  echo "  fly secrets list -a eco-api-staging"
  exit 1
fi
echo ""
