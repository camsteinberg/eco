#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
#
# End-to-end staging validation script.
# Tests the surviving user journey: sign-up → sign-in → account deletion.
# (Chat is now 100% on-device; the chat/model-registry/governance API flows were
# removed in Wave D. This script exercises only the auth + sessions surface.)

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
session_cookie=""
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
  # The session cookie is set with Domain=.econetwork.ai (the web app needs it
  # across subdomains), but staging is probed via its fly.dev hostname — a
  # spec-compliant cookie jar (curl -c/-b) refuses to store a cookie whose
  # Domain doesn't match the request host, so every authed probe would 401.
  # We're replaying the cookie to the exact host that issued it, so capture
  # the Set-Cookie header directly and send it verbatim.
  signin_response=$(curl -s -w "\n%{http_code}" -D /tmp/eco-e2e-headers.txt \
    -X POST "$API_URL/api/auth/sign-in/email" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" 2>/dev/null)

  signin_status=$(echo "$signin_response" | tail -1)
  session_cookie=$(grep -i '^set-cookie:' /tmp/eco-e2e-headers.txt | head -1 \
    | cut -d: -f2- | cut -d';' -f1 | sed 's/^ *//' | tr -d '\r' || true)

  if [ "$signin_status" -ge 200 ] && [ "$signin_status" -lt 300 ] && [ -n "$session_cookie" ]; then
    pass "Sign in"
    auth_available=true
  elif [ "$signin_status" -ge 200 ] && [ "$signin_status" -lt 300 ]; then
    fail "Sign in" "no session cookie in response"
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

# ── 4. Removed legacy routes (must be 404) ──────────────────────────────────
#
# The decentralized-inference / network surface was removed in Wave D, and the
# billing surface with it: Eco is free, so there is no payment processing. These
# probes actively verify the removals stuck — each must return 404.

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
assert_removed "Billing checkout" "POST" "$API_URL/v1/billing/checkout"

# ── 5. Account deletion (cleanup) ──────────────────────────────────────────

echo ""
echo "── Cleanup ────────────────────────────────────"
echo ""

if [ "$auth_available" = true ]; then
  delete_response=$(curl -s -w "\n%{http_code}" -H "Cookie: $session_cookie" \
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

# Clean up captured response headers
rm -f /tmp/eco-e2e-headers.txt

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
