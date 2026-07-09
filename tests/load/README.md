# Eco Load Tests

k6 load test scripts for validating Eco API performance and stability under load.

## Prerequisites

Install k6:

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker
docker pull grafana/k6
```

> **Scope (post Wave D):** Chat now runs entirely on the user's device — there is
> no server-side inference endpoint to load-test. The legacy `chat-streaming.js`
> and `rate-limiting.js` scripts (which hit the removed `/v1/chat/completions`
> route) were deleted. What remains is the `/health` baseline. The v1.0 API
> surface is auth + billing only; load-testing the auth endpoints (Better Auth
> rate limiting) is a separate future exercise.

## Environment Variables

| Variable           | Default                  | Description                      |
|--------------------|--------------------------|----------------------------------|
| `BASE_URL`         | `http://localhost:3001`  | API gateway base URL             |

## Running Tests

### Full suite

```bash
./tests/load/run.sh
```

### Individual tests

```bash
# Health check — 1000 req/s for 30s
k6 run tests/load/health-check.js
```

### With custom URLs

```bash
BASE_URL=https://api.staging.eco.example \
  ./tests/load/run.sh
```

## Test Descriptions

### health-check.js

Sends 1000 requests per second to `/health` for 30 seconds. Validates that the
endpoint returns 200 with `{"status": "ok"}`.

**Thresholds:**
- p95 response time < 500ms
- Error rate < 1%

## Interpreting Results

After a test run, k6 prints a summary including:

- **http_req_duration**: Distribution of response times (min, med, avg, p90, p95, max)
- **http_reqs**: Total requests and throughput (requests/second)
- **errors**: Custom error rate metric
- **iterations**: How many times the default function executed

Key metrics to watch:

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| p95 latency (health) | < 100ms | 100-500ms | > 500ms |
| Error rate | < 0.1% | 0.1-1% | > 1% |
| Throughput (health) | > 900 rps | 500-900 rps | < 500 rps |

## Results

Test results are written to `tests/load/results/` as JSON files:
- `{test-name}_{timestamp}.json` — Full k6 metrics stream
- `{test-name}_{timestamp}_summary.json` — Aggregated summary

The `results/` directory is gitignored.
