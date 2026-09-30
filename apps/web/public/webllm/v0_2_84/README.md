# Vendored WebLLM model libraries — v0_2_84

Compiled MLC model libraries (`model_lib` wasm) served same-origin so the app's
Content-Security-Policy stays free of third-party script/wasm origins. Each wasm
is compiled per (model architecture, size, quantization, prefill-chunk) against a
specific `@mlc-ai/web-llm` release — **these binaries are only valid for
web-llm 0.2.84** (the exact version pinned in `apps/web/package.json`). Bumping
that package requires re-staging the matching binaries under a new version
directory and updating `WEBLLM_MODEL_LIB_VERSION` in
`src/local-ai/runtime/webllm-config.ts`.

## Files

### `Qwen2-0.5B-Instruct-q4f16_1_cs1k_b1-webgpu.wasm`

- Source: **built from source by Eco, not downloaded.** It is upstream's
  `Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm` recompiled for one sequence
  (`max_batch_size` 1 instead of 128); the `_b1` in the name marks that.
- Size: 4,848,835 bytes
- sha256: `5ccb3e6d2dfdd9ba8538342d9d52364f25907d99f5a59db6dcfb29c9326abc2d`
- Serves the Qwen2.5-0.5B-Instruct q4f16 build (`candidate/qwen2.5-0.5b-mlc`),
  the iPhone model. The filename says "Qwen2" because the library is
  per-architecture.
- Toolchain: the commits upstream used for its v0_2_84 libraries
  ([mlc-ai/binary-mlc-llm-libs#165](https://github.com/mlc-ai/binary-mlc-llm-libs/pull/165)):
  TVM [`apache/tvm@bc1a904ec1ad89454ee6577d66cde1268b8f6bc8`](https://github.com/apache/tvm/commit/bc1a904ec1ad89454ee6577d66cde1268b8f6bc8),
  mlc-llm [`mlc-ai/mlc-llm@2008fe8343e1f40ef89ee57b9287aebcf1b86c98`](https://github.com/mlc-ai/mlc-llm/commit/2008fe8343e1f40ef89ee57b9287aebcf1b86c98);
  emsdk 3.1.56; LLVM 20.1.8. TVM and mlc-llm are Apache-2.0.

**Why it differs from upstream.** Upstream's library is compiled for up to 128
sequences at once, and at load it reserves sampler storage for all of them: six
buffers of 128 × 151,936 (the vocabulary) × 4 bytes, 445 MiB of GPU memory.
web-llm 0.2.84 only ever runs one sequence, so that storage is never used. At
batch 1 the sampler storage is 3,646,464 bytes instead of 466,747,392.

**How the build was checked.**

- The same toolchain at `max_batch_size` 128 produces a library whose GPU
  kernels, VM function table and metadata are identical to upstream's (only
  host code differs slightly).
- Batch 1 against batch 128: 0 of 87 GPU kernels differ, and the weights layout
  and VM function table are identical. Only the host memory plan and three shape
  functions change.
- Measured 2026-09-29 in Safari 26.4 on an Apple Silicon Mac (16 GB), loading
  the model only, batch 128 against batch 1: GPU memory requested fell from
  804.6 to 363.0 MiB (−441.6 MiB, the predicted amount), and the tab's memory
  footprint after load from 1,018 to 574 MB in 3 of 3 runs (peak 1,113 to
  726–758 MB). Both arms had a separate loader-memory change applied; the
  batch-1 saving is GPU storage and does not depend on it.
- Greedy output was identical to the batch-128 library on 5 prompts (replies
  of up to 1,349 characters). web-llm 0.2.84 passes every generated token
  through the changed sampling functions (softmax with temperature, argsort,
  top-p) even at temperature 0, so the check covers them.

**Rebuilding.** With TVM and mlc-llm built at the commits above, emsdk 3.1.56
active and LLVM 20.1.8:

```sh
mlc_llm gen_config qwen2_0_5b --quantization q4f16_1 --conv-template LM \
  --prefill-chunk-size 1024 --output dist/temp
mlc_llm compile dist/temp/mlc-chat-config.json --device webgpu \
  --overrides "prefill_chunk_size=1024;max_batch_size=1" \
  --output Qwen2-0.5B-Instruct-q4f16_1_cs1k_b1-webgpu.wasm
```

The compile step needs one adjustment. LLVM 20's default wasm32 CPU features
include `bulk-memory-opt` and `call-indirect-overlong`, which the binaryen in
emsdk 3.1.56 rejects, so the wasm32 host target is pinned to mcpu `mvp` with
mattr `+sign-ext,+mutable-globals,+multivalue`. The build ran the compile CLI
from Python with the pin set first:

```python
from mlc_llm.support import auto_target

host = auto_target.PRESET["webgpu:generic"]["target"]["host"]
host["mcpu"] = "mvp"
host["mattr"] = ["+sign-ext", "+mutable-globals", "+multivalue"]

from mlc_llm.cli import compile as compile_cli

compile_cli.main([
    "dist/temp/mlc-chat-config.json", "--device", "webgpu",
    "--overrides", "prefill_chunk_size=1024;max_batch_size=1",
    "--output", "Qwen2-0.5B-Instruct-q4f16_1_cs1k_b1-webgpu.wasm",
])
```

A web-llm upgrade needs this library rebuilt at the toolchain commits that
match the new release; there is no upstream copy to re-download.

### `Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm`

- Source: <https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm>
- Size: 5,535,989 bytes
- sha256: `4db800b24119204e1a0386e8a12e084d5012aa60f77c5bffad362f20498df912`
- Integrity: git blob sha (`8986dabcdc0d1aa473b9bfac5748eaf43adfb89c`) verified
  identical to the upstream repository's blob metadata at vendoring time.
- Upstream project: [mlc-ai/binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs),
  Apache-2.0. Serves the Qwen3-0.6B q4f16 MLC build (`candidate/qwen3-0.6b-mlc`),
  an eval-lane comparison build that is not offered to users (it was the
  desktop-Safari pick until the unquantised build replaced it).

### `Qwen3-0.6B-q0f16_cs1k-webgpu.wasm`

- Source: <https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3-0.6B-q0f16_cs1k-webgpu.wasm>
- Size: 5,392,341 bytes
- sha256: `5e9726c94a760986cc356a3213aeded03cf1ece982c716cd197a9179fb252bee`
- Integrity: git blob sha (`895bc757692391fbdc4c25cd171e418e474a3f96`) verified
  identical to the upstream repository's blob metadata at vendoring time.
- Upstream project: [mlc-ai/binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs),
  Apache-2.0. Serves the unquantised (q0f16) Qwen3-0.6B MLC build
  (`candidate/qwen3-0.6b-mlc-q0f16`), the desktop-Safari pick.

## Re-verifying

The Qwen2 library is built here, so there is no upstream copy to compare it
with: check its sha256 against the value above. Whether a rebuild with the
recipe above reproduces it byte for byte has not been checked. The other two
are compared with upstream.

```sh
shasum -a 256 Qwen2-0.5B-Instruct-q4f16_1_cs1k_b1-webgpu.wasm

shasum -a 256 Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm
git hash-object Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm
gh api "repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm?ref=main" --jq .sha

shasum -a 256 Qwen3-0.6B-q0f16_cs1k-webgpu.wasm
git hash-object Qwen3-0.6B-q0f16_cs1k-webgpu.wasm
gh api "repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_84/base/Qwen3-0.6B-q0f16_cs1k-webgpu.wasm?ref=main" --jq .sha
```
