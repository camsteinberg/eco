# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC
"""Unit tests for the query-redacting log record factory.

Run from this directory with `python3 -m unittest test_sitecustomize -v`.
"""

from __future__ import annotations

import importlib.util
import io
import logging
import os
import unittest

# Load our file by path under a private name: the interpreter may already have
# imported a *different* `sitecustomize` at start-up (Homebrew ships one), and
# a plain `import sitecustomize` would return that cached module instead.
_SPEC = importlib.util.spec_from_file_location(
    "eco_sitecustomize", os.path.join(os.path.dirname(os.path.abspath(__file__)), "sitecustomize.py")
)
sitecustomize = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(sitecustomize)  # executing it installs the factory


def emit(record_args, exc=False):
    """Format one record through a real handler and return the output."""
    logger = logging.getLogger("eco.test.%d" % id(record_args))
    logger.handlers = []
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    if exc:
        try:
            raise ValueError(record_args[0])
        except ValueError:
            logger.exception("Error")
    else:
        logger.warning(*record_args)
    handler.flush()
    return stream.getvalue()


class RedactionTest(unittest.TestCase):
    def test_factory_installed(self):
        self.assertTrue(getattr(logging.getLogRecordFactory(), "eco_query_redaction", False))

    def test_q_param_in_msg(self):
        out = emit(["HTTP Request failed: GET https://example.invalid/search?q=secret+question&lang=en"])
        self.assertIn("?q=<redacted>", out)
        self.assertNotIn("secret+question", out)
        self.assertIn("&lang=en", out)

    def test_query_param(self):
        out = emit(["GET https://example.invalid/s?a=1&query=secret+question"])
        self.assertIn("&query=<redacted>", out)
        self.assertNotIn("secret+question", out)

    def test_query_in_args(self):
        out = emit(["upstream %s failed", "https://example.invalid/s?q=secret+question"])
        self.assertIn("?q=<redacted>", out)
        self.assertNotIn("secret+question", out)

    def test_no_query_untouched(self):
        out = emit(["engine duckduckgo: timeout after 3.0s"])
        self.assertEqual(out.strip(), "engine duckduckgo: timeout after 3.0s")

    def test_exception_text_redacted(self):
        out = emit(["https://example.invalid/search?q=secret+question"], exc=True)
        self.assertIn("?q=<redacted>", out)
        self.assertNotIn("secret+question", out)

    def test_scrub_covers_exc_text_shaped_strings(self):
        # The factory scrubs `exc_text` when a caller has already set it; the
        # usual case, where the Formatter fills it in later, is covered by
        # test_exception_text_redacted.
        text = 'File "x.py", line 1\n  httpx.ConnectError: GET /s?q=secret+question'
        self.assertIn("?q=<redacted>", sitecustomize._scrub(text))
        self.assertNotIn("secret+question", sitecustomize._scrub(text))
        self.assertIs(sitecustomize._scrub(None), None)

    def test_non_str_msg_passes_through(self):
        out = emit([{"a": 1}])
        self.assertIn("{'a': 1}", out)

    def test_idempotent_install(self):
        before = logging.getLogRecordFactory()
        sitecustomize._install()
        after = logging.getLogRecordFactory()
        self.assertIsNot(before, after)
        out = emit(["GET https://example.invalid/s?q=secret+question"])
        self.assertNotIn("secret+question", out)
        self.assertIn("?q=<redacted>", out)


if __name__ == "__main__":
    unittest.main()
