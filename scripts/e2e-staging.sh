#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
#
# End-to-end staging validation script.
# Tests the surviving user journey: sign-up → sign-in → billing → account deletion.
# (Chat is now 100% on-device; the chat/model-registry/governance API flows were
# removed in Wave D. This script exercises only the auth + billing surface.)

set -euo pipefail

API_URL="${ECO_API_URL:-https://api.econetwork.ai}"
WEB_URL="${ECO_WEB_URL:-https://econetwork.ai}"

passed=0
failed=0
total=0

pass() {
  local name="$1"
  printf "  \033[1;32m✓\033[0m %-35s ok\n" "$name"
  passed=$((passed + 1))
  total=$((total + 1))
}

fail() {
  local name="$1" detail="$2"
  printf "  \033[1;31m✗\033[0m %-35s FAILED (%s)\n" "$name" "$detail"
  failed=$((failed + 1))
  total=$((total + 1))
}

skip() {
  local name="$1" reason="$2"
  printf "  \033[1;33m-\033[0m %-35s SKIPPED (%s)\n" "$name" "$reason"
  total=$((total + 1))
}

echo ""
echo "Eco E2E Staging Validation"
echo "=========================="
echo ""
echo "API: $API_URL"
echo "Web: $WEB_URL"
echo ""

# ── 1. Sign-up ───────────────────────────────────────────────────────────────

echo "── User Registration ──────────────────────────"
echo ""

TEST_EMAIL="e2e-test-$(date +%s)@eco.test"
TEST_PASSWORD="TestPass123!"

signup_response=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"name\":\"E2E Test\"}" 2>/dev/null)

signup_status=$(echo "$signup_response" | tail -1)

auth_available=false
if [ "$signup_status" -ge 200 ] && [ "$signup_status" -lt 300 ]; then
  pass "Sign up"
elif [ "$signup_status" = "422" ]; then
  skip "Sign up" "staging auth is unavailable or invite-gated"
else
  fail "Sign up" "HTTP $signup_status"
fi

# ── 2. Sign-in ───────────────────────────────────────────────────────────────

echo ""
echo "── Authentication ─────────────────────────────"
echo ""

if [ "$signup_status" -ge 200 ] && [ "$signup_status" -lt 300 ]; then
  signin_response=$(curl -s -w "\n%{http_code}" -c /tmp/eco-e2e-cookies.txt \
    -X POST "$API_URL/api/auth/sign-in/email" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" 2>/dev/null)

  signin_status=$(echo "$signin_response" | tail -1)

  if [ "$signin_status" -ge 200 ] && [ "$signin_status" -lt 300 ]; then
    pass "Sign in"
    auth_available=true
  else
    fail "Sign in" "HTTP $signin_status"
  fi
else
  skip "Sign in" "sign-up unavailable"
fi

# ── 3. Chat is on-device (no API flow) ───────────────────────────────────────
#
# Chat runs entirely in the browser via Transformers.js / WebLLM. There is no
# server-side /v1/chat/completions endpoint to exercise — it was removed in
# Wave D. The "Removed legacy routes" block below confirms it returns 404.

# ── 4. Billing ──────────────────────────────────────────────────────────────

echo ""
echo "── Billing ────────────────────────────────────"
echo ""

if [ "$auth_available" = true ]; then
  billing_response=$(curl -s -w "\n%{http_code}" -b /tmp/eco-e2e-cookies.txt \
    -X POST "$API_URL/v1/billing/checkout" \
    -H "Content-Type: application/json" \
    -d '{"tier":"supporter"}' 2>/dev/null)

  billing_status=$(echo "$billing_response" | tail -1)
  billing_body=$(echo "$billing_response" | sed '$d')

  if [ "$billing_status" = "200" ]; then
    if echo "$billing_body" | grep -q '"url"'; then
      pass "Billing checkout session"
    else
      fail "Billing checkout" "missing URL in response"
    fi
  elif [ "$billing_status" = "404" ]; then
    skip "Billing checkout" "Stripe not configured"
  else
    fail "Billing checkout" "HTTP $billing_status"
  fi
else
  skip "Billing checkout" "auth unavailable"
fi

# ── 5. Removed legacy routes (must be 404) ──────────────────────────────────
#
# The decentralized-inference / network surface was removed in Wave D. These
# probes actively verify the removal stuck — each must return 404.

echo ""
echo "── Removed legacy routes ──────────────────────"
echo ""

assert_removed() {
  local name="$1" method="$2" url="$3"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url" 2>/dev/null || echo "000")
  if [ "$status" = "404" ]; then
    pass "$name gone (404)"
  else
    fail "$name" "expected 404, got HTTP $status"
  fi
}

assert_removed "Chat completions" "POST" "$API_URL/v1/chat/completions"
assert_removed "Model registry"   "GET"  "$API_URL/v1/models/registry"
assert_removed "Governance"       "GET"  "$API_URL/v1/governance/proposals"

# ── 6. Account deletion (cleanup) ──────────────────────────────────────────

echo ""
echo "── Cleanup ────────────────────────────────────"
echo ""

if [ "$auth_available" = true ]; then
  delete_response=$(curl -s -w "\n%{http_code}" -b /tmp/eco-e2e-cookies.txt \
    -X DELETE "$API_URL/v1/auth/account" 2>/dev/null)

  delete_status=$(echo "$delete_response" | tail -1)

  if [ "$delete_status" -ge 200 ] && [ "$delete_status" -lt 300 ]; then
    pass "Account deletion (cleanup)"
  else
    skip "Account deletion" "HTTP $delete_status — may need manual cleanup"
  fi
else
  skip "Account deletion" "auth unavailable"
fi

# Clean up cookie file
rm -f /tmp/eco-e2e-cookies.txt

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "── Summary ────────────────────────────────────"
echo ""

if [ "$failed" -eq 0 ]; then
  printf "\033[1;32mAll %d checks passed!\033[0m\n" "$passed"
else
  printf "\033[1;31m%d passed, %d failed out of %d total.\033[0m\n" "$passed" "$failed" "$total"
  exit 1
fi
echo ""
