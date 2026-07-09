#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
#
# Mutating production auth-flow smoke.
#
# The non-mutating smoke (production-web-smoke.sh) is GET/HEAD-only and the API
# unit tests mock the database, so neither exercises the real signup / profile /
# delete write paths. Three production-only 500s/422s shipped green because of
# exactly that gap (drizzle snapshot↔SQL drift; neon-http lacking transactions).
#
# This runs the real flow against production and FAILS the deploy if any step
# regresses: create a throwaway account, update its profile, then delete it.
# It cleans up after itself (the trap deletes the account even on mid-flow
# failure), so a green run leaves no residue.
#
# It talks to the API host directly (api.econetwork.ai), not through the web
# rewrite: Vercel turns the web's external rewrite of mutating methods
# (PATCH/DELETE on /v1/*) into a 307 redirect to the API host, which complicates
# cookie/redirect handling for curl. Going straight to the API keeps every
# request on one host so the session cookie is always sent. A trusted `Origin`
# header satisfies Better Auth's origin check.

set -euo pipefail

API_URL="${ECO_API_URL:-https://api.econetwork.ai}"
ORIGIN="${ECO_WEB_URL:-https://econetwork.ai}"
RUN_ID="${GITHUB_RUN_ID:-local}"
STAMP="$(date +%s)"
# Resend's delivered@resend.dev test sink accepts mail without bouncing and is
# documented as reputation-safe. With email ON, signup fires a verification
# email to this address on every deploy — a hard-bounce domain (@example.com)
# here would spike the bounce rate of a near-zero-volume sender and risk a
# Resend/SES sending pause. The +label keeps each run's signup email unique.
EMAIL="delivered+eco-deploy-smoke-${RUN_ID}-${STAMP}@resend.dev"
PASSWORD="DeploySmoke!${RUN_ID}-${STAMP}-${RANDOM}${RANDOM}"
NAME="Eco Deploy Smoke"

COOKIES="$(mktemp)"
SIGNED_UP=0
DELETED=0

req() {
  # req <method> <url> [data] -> echoes the final HTTP status, follows redirects,
  # carries the cookie jar both ways, and sends a trusted Origin.
  local method="$1" url="$2" data="${3:-}"
  local args=(--silent --show-error --location --max-time 20
    -o /dev/null -w '%{http_code}'
    -b "$COOKIES" -c "$COOKIES"
    -H "Origin: $ORIGIN" -X "$method" "$url")
  if [ -n "$data" ]; then
    args+=(-H 'content-type: application/json' -d "$data")
  fi
  curl "${args[@]}"
}

cleanup() {
  # Best-effort: if we created an account but did not delete it (mid-flow
  # failure), remove it so the smoke never leaks a real production user.
  if [ "$SIGNED_UP" = "1" ] && [ "$DELETED" = "0" ]; then
    req DELETE "$API_URL/v1/auth/account" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

fail() {
  echo "FAIL auth-flow-smoke: $1"
  exit 1
}

echo "Eco production auth-flow smoke"
echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "api=$API_URL"
echo "email=$EMAIL"
echo ""

# 1. Signup — guards the user-creation insert path (the #111 uuid/text regression
#    surfaced here as 422 FAILED_TO_CREATE_USER). Captures the session cookie.
signup_status="$(req POST "$API_URL/api/auth/sign-up/email" \
  "{\"name\":\"$NAME\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")" \
  || fail "signup request failed to connect"
[ "$signup_status" = "200" ] || fail "signup expected 200, got $signup_status"
SIGNED_UP=1
echo "PASS signup                 POST $API_URL/api/auth/sign-up/email HTTP 200"

# 2. Profile update — guards a db.transaction() route (the #112 neon-http
#    regression surfaced here as 500).
profile_status="$(req PATCH "$API_URL/v1/auth/profile" '{"name":"Eco Deploy Smoke (renamed)"}')" \
  || fail "profile request failed to connect"
[ "$profile_status" = "200" ] || fail "profile PATCH expected 200, got $profile_status"
echo "PASS profile-update         PATCH $API_URL/v1/auth/profile HTTP 200"

# 3. Account deletion — guards the other db.transaction() route AND removes the
#    throwaway account.
delete_status="$(req DELETE "$API_URL/v1/auth/account")" \
  || fail "account delete request failed to connect (account $EMAIL may need manual cleanup)"
[ "$delete_status" = "200" ] || fail "account DELETE expected 200, got $delete_status (account $EMAIL may need manual cleanup)"
DELETED=1
echo "PASS account-delete         DELETE $API_URL/v1/auth/account HTTP 200 (cleaned up)"

echo ""
echo "summary=auth-flow-smoke OK (signup → profile → delete)"
