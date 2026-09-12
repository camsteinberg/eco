# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
"""Redact search queries from every log record this interpreter emits.

Why: when an upstream engine fails, SearXNG logs the full outgoing URL —
`searx/network/network.py:258` does `self._logger.warning(f"HTTP Request
failed: {method} {url}")`, and that `url` carries the person's question in its
`q=` parameter straight into Fly's log stream. The production root logger is
hardcoded to WARNING in `searx/__init__.py`, so there is no settings knob below
it; a record factory installed before searx imports is the one hook that covers
every logger, including exception text.

Python's `site` module imports `sitecustomize` at interpreter start, so this
runs before anything in searx.
"""

from __future__ import annotations

import logging
import re

_QUERY_RE = re.compile(r"([?&](?:q|query)=)[^&\s]*")
_REDACTED = r"\1<redacted>"


def _scrub(value):
    if isinstance(value, str):
        return _QUERY_RE.sub(_REDACTED, value)
    return value


def _install() -> None:
    old_factory = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        record = old_factory(*args, **kwargs)
        try:
            record.msg = _scrub(record.msg)
            if isinstance(record.args, tuple):
                record.args = tuple(_scrub(a) for a in record.args)
            elif isinstance(record.args, dict):
                record.args = {k: _scrub(v) for k, v in record.args.items()}
            if getattr(record, "exc_text", None):
                record.exc_text = _scrub(record.exc_text)
        except Exception:  # pylint: disable=broad-except
            # Logging must never be the thing that breaks the relay.
            return record
        return record

    factory.eco_query_redaction = True  # marker for the test and for operators
    logging.setLogRecordFactory(factory)

    # `exc_text` is normally filled in by the Formatter, after the factory has
    # run, so the factory alone would miss a URL that only appears inside a
    # traceback (`network.py:329` logs `logger.exception('Error')`). Patching
    # the base Formatter covers every handler that does not override it.
    old_format_exception = logging.Formatter.formatException

    def format_exception(self, ei):
        try:
            return _scrub(old_format_exception(self, ei))
        except Exception:  # pylint: disable=broad-except
            return old_format_exception(self, ei)

    logging.Formatter.formatException = format_exception


if not getattr(logging.getLogRecordFactory(), "eco_query_redaction", False):
    _install()
