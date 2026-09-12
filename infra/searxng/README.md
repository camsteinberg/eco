<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Bos Computing LLC -->

# Eco search relay — the SearXNG instance

This directory deploys `eco-searxng`, the search backend behind
`POST /v1/search` in `apps/api`. It exists so that when Eco looks something up
for a person, the search engine sees **Eco's datacenter IP, not theirs**.

The path is: browser → `POST /v1/search` on Eco's API → this instance over Fly
private networking → public search engines. Chat inference is unaffected and
still runs entirely on the person's own device.

## What this is not

- **Not public.** `fly.toml` has no `[http_service]` and no `[[services]]`
  block, so Fly's proxy never routes to it and it has no public address. The
  only reachable address is `eco-searxng.internal:8080` over 6PN, from other
  apps in the same Fly organization. Adding a service block would publish a
  search engine under Eco's name.
- **Not an account system.** No sign-in, no preferences, no cookies that matter.
  `server.limiter` is off, so no Valkey/Redis is attached and no per-client
  state is kept here.
- **Not a log of what people search.** Granian, the WSGI server in the upstream
  image, has access logging **disabled by default** (`--access-log /
  --no-access-log [env var: GRANIAN_LOG_ACCESS_ENABLED; default: (disabled)]`,
  verified in the Granian README on 2026-09-11). `fly.toml` sets
  `GRANIAN_LOG_ACCESS_ENABLED = "false"` explicitly anyway, so a future image
  default cannot quietly turn it on. (Granian's `%(path)s` field excludes the
  query string, so even the default format would not carry the query; the
  explicit setting is belt and braces, not the fix.) SearXNG's own logging is
  a separate matter — see the next section.

## What the logs contain after an engine failure

SearXNG itself did write the query. When an upstream engine returns an error,
`searx/network/network.py:258` logs the full outgoing URL at `WARNING` —
`HTTP Request failed: GET https://…/search?q=<the person's question>` — and the
production root logger is hardcoded to `WARNING` in `searx/__init__.py`, so no
settings knob turns that off. `sitecustomize.py`, installed on `PYTHONPATH` by
the `Dockerfile`, replaces the process's log record factory before searx
imports; it rewrites `q=` and `query=` parameters to `<redacted>` in every log
message, every string argument, and every formatted traceback. What still
reaches Fly's log stream on a failure is the engine name, the upstream host and
path, the HTTP status and the timing — enough to diagnose a broken engine,
without the question. Verified on 2026-09-12 against the real SearXNG code with
a forced engine failure: the canary phrase appeared once in the unmodified run
and zero times with the filter in place. Unit tests for the filter:
`python3 -m unittest test_sitecustomize -v` from this directory.

This is a redaction, not an absence of logs: Fly keeps whatever the container
prints for its own retention window, and that remains the outer bound on how
long anything about a search lives on Eco's side. The claim to make in copy is
"the relay does not log your question", not "Eco keeps no record".

The honest statement of the privacy boundary, for copy: the search engine never
sees the user. Eco's own servers do see the query for the lifetime of the
request — the relay never logs, stores or attaches it to an account, but "Eco
never sees it" would be false.

## Deploy

```bash
flyctl deploy --config infra/searxng/fly.toml --app eco-searxng
```

CI equivalent: the **Deploy Production** workflow with `target=searxng`.

First time only, create the app and its secret:

```bash
flyctl apps create eco-searxng
flyctl secrets set SEARXNG_SECRET="$(openssl rand -hex 32)" --app eco-searxng
```

`SEARXNG_SECRET` overrides `server.secret_key` in `settings.yml` at runtime (the
image maps `SEARXNG_*` env vars onto settings). The literal in the file is a
placeholder and must never be the live value.

Then point the API at it:

```bash
flyctl secrets set SEARXNG_URL="http://eco-searxng.internal:8080" --app eco-api
```

## Known deviations from a normal Fly app

- **No `auto_stop_machines` / `min_machines_running`.** Both keys live inside a
  `[http_service]` / `[[services]]` block, and this app deliberately has
  neither. With no Fly proxy service there is no autostop machinery at all: the
  machine simply runs continuously, which is the intended behaviour (a cold
  start on the first search of the day would blow the relay's 4 s budget).
- **The health check is a machine-level `[checks]` block**, not a service check,
  for the same reason. It hits SearXNG's own `/healthz` route.

## Day-one measurement: which engines actually answer

`settings.yml` ships with the image's **default** engine set and no hand-picked
list. That is on purpose. Which engines respond from a Fly datacenter IP is an
empirical question — several block datacenter ranges outright or return
captchas — and the wrong guess baked into the first deploy would silently
degrade every lookup.

Run this once the instance is up, before enabling the relay in the product.

1. Open a tunnel to the private instance:

   ```bash
   flyctl proxy 8080:8080 --app eco-searxng
   ```

2. For each engine in `duckduckgo`, `bing`, `brave`, `google`, `mojeek`,
   `qwant`, `startpage`, `wikipedia`, issue all 24 real-time probe queries. The
   prompts are the `prompt` fields of the probe ids listed below, in
   `apps/web/src/local-ai/eval/real-time-probes.ts`:

   `rt-plan-1` … `rt-plan-8`, `rt-live-1` … `rt-live-8`, `rt-sched-1` … `rt-sched-8`

   ```bash
   curl -sS -w ' %{http_code} %{time_total}\n' -o /tmp/out.json \
     "http://127.0.0.1:8080/search?q=<urlencoded-prompt>&format=json&language=en&safesearch=1&categories=general&engines=<engine>"
   ```

3. Record, per engine, a row of: queries answered with ≥ 1 result / 24, the
   `unresponsive_engines` entries SearXNG reports in the JSON, HTTP status, and
   median `time_total`.

   | engine | answered /24 | errors | median latency |
   | ------ | ------------ | ------ | -------------- |
   |        |              |        |                |

4. Enable only the engines that answered **≥ 20 of 24**, by adding an `engines:`
   block to `settings.yml` in place of the comment at the bottom of the file,
   and redeploy. Record the table in the session record — a later drop in
   lookup quality is usually an engine that started blocking, and without the
   baseline there is nothing to compare against.
