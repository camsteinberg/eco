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
