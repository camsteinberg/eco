# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC

# Pinned, never `latest`: the upstream image is rebuilt several times a day, and
# an unpinned tag would mean the search backend silently changes engines and
# parsers under a measurement we are about to take. Tag format and value read
# from the Docker Hub tag list on 2026-09-11
# (https://hub.docker.com/r/searxng/searxng/tags).
FROM searxng/searxng:2026.9.10-931fd9787

# The image's entrypoint copies its own settings template into
# $__SEARXNG_CONFIG_PATH (/etc/searxng) only when no settings.yml is there, so
# baking ours in wins. `use_default_settings: true` inside it means this file is
# an overlay on the image defaults, not a replacement.
COPY settings.yml /etc/searxng/settings.yml

EXPOSE 8080

# Redact the user's question from the container's log stream. On an upstream
# engine failure SearXNG logs the full outgoing URL, query string included
# (`searx/network/network.py:258`), and the production root logger is hardcoded
# to WARNING with no settings knob below it. `sitecustomize` is imported by
# Python's `site` module at interpreter start, before searx, so the log record
# factory it installs covers every logger in the process.
#
# It goes on PYTHONPATH rather than into the venv's site-packages because the
# site-packages path carries the image's Python minor version
# (.venv/lib/pythonX.Y/site-packages) and would silently stop matching on an
# image bump; PYTHONPATH is version-independent.
COPY sitecustomize.py /usr/local/searxng/eco/sitecustomize.py
ENV PYTHONPATH="/usr/local/searxng/eco"
