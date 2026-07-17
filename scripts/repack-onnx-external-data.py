#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC

"""Deterministically repack a single-file ONNX model as an external-data pair.

Why this exists: onnxruntime-web's session create stages a SINGLE-FILE model
wholesale inside the wasm heap (freed only after the session is built), so the
load transient carries an extra ~1x weights copy. Files passed as externalData
are mounted JS-side and skip that staging copy entirely — measured on
Qwen3-0.6B q4f16: load plateau -600..700 MB, wasm reservation -789 MB, zero
tok/s cost (A-3 decomposition, 2026-07-16).

This script is the provenance chain for Eco-hosted repacked artifacts: anyone
can regenerate the exact bytes from the pinned upstream file and compare
sha256s. Tensor bytes are moved, not transformed — the graph references the
same data at offsets in the companion `.onnx_data` file.

Usage:
  python3 repack-onnx-external-data.py <model.onnx> <out-dir> \
      [--expect-graph-sha SHA256] [--expect-data-sha SHA256]

Requires: onnx (pinned — repack determinism was verified with onnx 1.22.0).
Output: <out-dir>/<basename>.onnx + <out-dir>/<basename>.onnx_data, with
sha256 + size printed for both (and asserted when --expect-* is given).
"""

import argparse
import hashlib
import os
import sys


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", help="single-file .onnx input")
    parser.add_argument("out_dir", help="output directory for the pair")
    parser.add_argument("--expect-graph-sha", default=None)
    parser.add_argument("--expect-data-sha", default=None)
    args = parser.parse_args()

    import onnx  # deferred so --help works without the dependency

    basename = os.path.basename(args.model)
    data_name = basename + "_data"
    os.makedirs(args.out_dir, exist_ok=True)
    out_graph = os.path.join(args.out_dir, basename)
    out_data = os.path.join(args.out_dir, data_name)

    model = onnx.load(args.model)
    onnx.save(
        model,
        out_graph,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=data_name,
        # 1 KiB threshold: every real weight tensor goes external; tiny shape/
        # scalar initializers stay in the graph so it remains self-describing.
        size_threshold=1024,
        convert_attribute=False,
    )

    results = {
        out_graph: (sha256_of(out_graph), args.expect_graph_sha),
        out_data: (sha256_of(out_data), args.expect_data_sha),
    }
    ok = True
    for path, (actual, expected) in results.items():
        size = os.path.getsize(path)
        status = ""
        if expected is not None:
            match = actual == expected
            ok = ok and match
            status = "  MATCH" if match else f"  MISMATCH (expected {expected})"
        print(f"{os.path.basename(path)}  {size} bytes  sha256={actual}{status}")

    print(f"onnx=={onnx.__version__}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
