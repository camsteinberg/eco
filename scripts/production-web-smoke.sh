#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
#
# Non-mutating production launch smoke for the web alias plus required health probes.

set -euo pipefail

WEB_URL="${ECO_WEB_URL:-https://econetwork.ai}"
API_URL="${ECO_API_URL:-https://api.econetwork.ai}"
EXPECTED_GIT_SHA="${ECO_EXPECTED_GIT_SHA:-}"
EXPECTED_WEB_DEPLOYMENT_URL="${ECO_EXPECTED_WEB_DEPLOYMENT_URL:-}"
REQUIRE_ALIAS_FRESHNESS="${ECO_REQUIRE_ALIAS_FRESHNESS:-false}"

passed=0
failed=0
warnings=0

tmp_files=()
cleanup() {
  if [ "${#tmp_files[@]}" -gt 0 ]; then
    rm -f "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

make_tmp() {
  local file
  file="$(mktemp)"
  tmp_files+=("$file")
  printf '%s' "$file"
}

is_allowed_method() {
  case "$1" in
    GET | HEAD) return 0 ;;
    *) return 1 ;;
  esac
}

record_pass() {
  passed=$((passed + 1))
  printf 'PASS %-34s %s\n' "$1" "$2"
}

record_fail() {
  failed=$((failed + 1))
  printf 'FAIL %-34s %s\n' "$1" "$2"
}

record_warn() {
  warnings=$((warnings + 1))
  printf 'WARN %-34s %s\n' "$1" "$2"
}

probe() {
  local name="$1" method="$2" url="$3" status_pattern="$4" body_pattern="${5:-}" header_pattern="${6:-}"
  local severity="${7:-fail}"
  local body_file headers_file status curl_args=()

  if ! is_allowed_method "$method"; then
    if [ "$severity" = "warn" ]; then
      record_warn "$name" "unsafe method rejected by smoke allowlist: $method"
    else
      record_fail "$name" "unsafe method rejected by smoke allowlist: $method"
    fi
    return
  fi

  body_file="$(make_tmp)"
  headers_file="$(make_tmp)"

  if [ "$method" = "HEAD" ]; then
    curl_args=(--head)
  fi

  if ! status="$(curl --silent --show-error --location-trusted --max-time 20 "${curl_args[@]+"${curl_args[@]}"}" --dump-header "$headers_file" --output "$body_file" --write-out '%{http_code}' "$url")"; then
    if [ "$severity" = "warn" ]; then
      record_warn "$name" "$method $url connection failed"
    else
      record_fail "$name" "$method $url connection failed"
    fi
    return
  fi

  if ! printf '%s' "$status" | grep -Eq "$status_pattern"; then
    if [ "$severity" = "warn" ]; then
      record_warn "$name" "$method $url returned HTTP $status; expected $status_pattern"
    else
      record_fail "$name" "$method $url returned HTTP $status; expected $status_pattern"
    fi
    return
  fi

  if [ -n "$body_pattern" ] && ! grep -Eiq "$body_pattern" "$body_file"; then
    if [ "$severity" = "warn" ]; then
      record_warn "$name" "$method $url body did not match $body_pattern"
    else
      record_fail "$name" "$method $url body did not match $body_pattern"
    fi
    return
  fi

  if [ -n "$header_pattern" ] && ! grep -Eiq "$header_pattern" "$headers_file"; then
    if [ "$severity" = "warn" ]; then
      record_warn "$name" "$method $url headers did not match $header_pattern"
    else
      record_fail "$name" "$method $url headers did not match $header_pattern"
    fi
    return
  fi

  record_pass "$name" "$method $url HTTP $status"
}

warn_probe() {
  probe "$@" "warn"
}

# Engine runtime statics (LiteRT + ONNX Runtime WASM) are copied into public/ by
# apps/web/scripts/copy-runtime-assets.mjs and served straight off the CDN — no
# function, no tracing, no site-gate. Assert HTTP 200 + application/wasm (for
# .wasm) + NO Set-Cookie. A redirect, an HTML gate page, or a cookie here is the
# exact #204 regression ("LiteRT/Gemma assets never served in prod") that shipped
# undetected because the smoke did not probe them. Redirects are deliberately NOT
# followed so a gate 3xx surfaces as a non-200 failure.
probe_engine_asset() {
  local name="$1" url="$2" kind="$3"
  local body_file headers_file status

  body_file="$(make_tmp)"
  headers_file="$(make_tmp)"

  if ! status="$(curl --silent --show-error --max-time 20 --dump-header "$headers_file" --output "$body_file" --write-out '%{http_code}' "$url")"; then
    record_fail "$name" "GET $url connection failed"
    return
  fi

  if [ "$status" != "200" ]; then
    record_fail "$name" "GET $url returned HTTP $status; expected 200 (engine statics must be direct CDN assets)"
    return
  fi

  if grep -Eiq '^set-cookie:' "$headers_file"; then
    record_fail "$name" "GET $url set a cookie; engine statics must be served cookie-less"
    return
  fi

  if [ "$kind" = "wasm" ] && ! grep -Eiq 'content-type:.*application/wasm' "$headers_file"; then
    record_fail "$name" "GET $url did not return content-type application/wasm"
    return
  fi

  record_pass "$name" "GET $url HTTP 200"
}

echo "Eco production web smoke"
echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "web=$WEB_URL"
echo "api=$API_URL"
echo "method_allowlist=GET,HEAD"
echo ""

probe "web gate uptime JSON" "GET" "$WEB_URL/api/gate" '^200$' '^\{"configured":(true|false)\}$' 'content-type:.*application/json'
if [ -n "$EXPECTED_GIT_SHA" ] || [ "$REQUIRE_ALIAS_FRESHNESS" = "true" ]; then
  probe "web deploy identity" "GET" "$WEB_URL/api/deploy-health" '^200$' '"service":"eco-web".*"status":"ok"' 'cache-control:.*no-store'
else
  warn_probe "web deploy identity" "GET" "$WEB_URL/api/deploy-health" '^200$' '"service":"eco-web".*"status":"ok"' 'cache-control:.*no-store'
fi
probe "web shell or gate" "GET" "$WEB_URL/" '^(200|307|308)$' '' 'content-security-policy:'
probe "web sign-in entry" "GET" "$WEB_URL/sign-in" '^(200|307|308)$' '' 'content-security-policy:'
probe "web models settings" "GET" "$WEB_URL/settings?tab=models" '^(200|307|308)$' 'Settings|settings|gate|Gate' 'content-security-policy:'
probe "web support settings" "GET" "$WEB_URL/settings?tab=support" '^(200|307|308)$' 'Settings|settings|gate|Gate' 'content-security-policy:'
probe "web privacy" "GET" "$WEB_URL/privacy" '^200$' 'Privacy|privacy' 'content-security-policy:'
probe "web terms" "GET" "$WEB_URL/terms" '^200$' 'Terms|terms' 'content-security-policy:'
probe "web transparency" "GET" "$WEB_URL/transparency" '^200$' 'Transparency|transparency' 'content-security-policy:'
probe "web static service worker" "HEAD" "$WEB_URL/sw.js" '^200$' '' 'cache-control:'
probe "web model metadata HEAD" "HEAD" "$WEB_URL/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/config.json" '^200$' '' 'accept-ranges:|content-length:'

# Runtime engine statics manifest. Entries are "<url-path>|<kind>" where kind is
# `wasm` (asserts application/wasm) or `js`. KEEP IN SYNC with RUNTIME_ASSET_COPIES
# in apps/web/scripts/copy-runtime-assets.mjs — the drift test
# apps/web/src/lib/__tests__/runtime-asset-manifest-sync.test.ts hard-fails if
# this list and that manifest diverge (re-creating the #204 blind spot).
ENGINE_ASSETS=(
  "/litert-wasm/litertlm_wasm_internal.js|js"
  "/litert-wasm/litertlm_wasm_internal.wasm|wasm"
  "/litert-wasm/litertlm_wasm_compat_internal.js|js"
  "/litert-wasm/litertlm_wasm_compat_internal.wasm|wasm"
  "/ort/ort-wasm-simd-threaded.asyncify.mjs|js"
  "/ort/ort-wasm-simd-threaded.asyncify.wasm|wasm"
)
for entry in "${ENGINE_ASSETS[@]}"; do
  asset_path="${entry%%|*}"
  asset_kind="${entry##*|}"
  probe_engine_asset "engine asset ${asset_path}" "$WEB_URL$asset_path" "$asset_kind"
done

probe "api health" "GET" "$API_URL/health" '^200$' '"status":"ok"' 'content-type:.*application/json'
probe "api readiness" "GET" "$API_URL/health/ready" '^200$' '"database":"ok".*"redis":"ok"|\"redis\":\"ok\".*\"database\":\"ok\"' 'content-type:.*application/json'

# /metrics is gated behind METRICS_TOKEN (SECURITY.md H2): 404 when unconfigured
# in production, 401 without a valid Bearer token, 200 + Prometheus body with one.
# With ECO_METRICS_TOKEN we assert the authenticated 200; otherwise a gated
# 401/404 is a healthy (protected) outcome, recorded as a warn-level pass.
METRICS_TOKEN="${ECO_METRICS_TOKEN:-}"
if [ -n "$METRICS_TOKEN" ]; then
  metrics_status=$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $METRICS_TOKEN" "$API_URL/metrics" 2>/dev/null || echo "000")
  if [ "$metrics_status" = "200" ]; then
    record_pass "api metrics" "GET $API_URL/metrics HTTP 200 (authenticated)"
  else
    record_fail "api metrics" "GET $API_URL/metrics returned HTTP $metrics_status with token; expected 200"
  fi
else
  metrics_status=$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' "$API_URL/metrics" 2>/dev/null || echo "000")
  case "$metrics_status" in
    401 | 404) record_pass "api metrics" "GET $API_URL/metrics HTTP $metrics_status (gated; set ECO_METRICS_TOKEN to scrape)" ;;
    200) record_warn "api metrics" "GET $API_URL/metrics HTTP 200 (open — METRICS_TOKEN unset on this deploy)" ;;
    *) record_warn "api metrics" "GET $API_URL/metrics returned HTTP $metrics_status" ;;
  esac
fi

if [ -n "$EXPECTED_GIT_SHA" ]; then
  if curl --silent --show-error --max-time 20 "$WEB_URL/api/deploy-health" | grep -Fq "\"commitSha\":\"$EXPECTED_GIT_SHA\""; then
    record_pass "vercel alias freshness" "$WEB_URL reports expected commit $EXPECTED_GIT_SHA"
  else
    record_fail "vercel alias freshness" "$WEB_URL does not report expected commit $EXPECTED_GIT_SHA"
  fi
elif [ "$REQUIRE_ALIAS_FRESHNESS" = "true" ]; then
  record_fail "vercel alias freshness" "ECO_EXPECTED_GIT_SHA is required for a hard freshness pass"
else
  record_warn "vercel alias freshness" "no expected commit supplied; record as deploy-authorization/final-deploy blocker, not a pass"
fi

if [ -n "$EXPECTED_WEB_DEPLOYMENT_URL" ]; then
  expected_deployment_host="${EXPECTED_WEB_DEPLOYMENT_URL#https://}"
  expected_deployment_host="${expected_deployment_host#http://}"
  expected_deployment_host="${expected_deployment_host%%/*}"
  if curl --silent --show-error --max-time 20 "$WEB_URL/api/deploy-health" | grep -Fq "\"deploymentUrl\":\"$expected_deployment_host\""; then
    record_pass "vercel deployment url" "$WEB_URL reports expected deployment host $expected_deployment_host"
  else
    record_fail "vercel deployment url" "$WEB_URL does not report expected deployment host $expected_deployment_host"
  fi
fi

echo ""
echo "summary=passed:$passed failed:$failed warnings:$warnings"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
