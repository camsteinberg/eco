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

### `Qwen3-0.6B-q0f16_cs1k_b1-webgpu.wasm`

- Source: **built from source by Eco, not downloaded.** It is upstream's
  [`Qwen3-0.6B-q0f16_cs1k-webgpu.wasm`](https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3-0.6B-q0f16_cs1k-webgpu.wasm)
  recompiled for one sequence (`max_batch_size` 1 instead of 128); the `_b1`
  in the name marks that.
- Size: 5,391,090 bytes
- sha256: `4184d1c99aa3c159b9995c1417e2db4a9f14686cd5e4ea4a0f781a6ca3242d3a`
- Serves the unquantised (q0f16) Qwen3-0.6B MLC build
  (`candidate/qwen3-0.6b-mlc-q0f16`), the desktop-Safari pick.
- Toolchain: the same as the Qwen2 library above (TVM `bc1a904e`, mlc-llm
  `2008fe83`, emsdk 3.1.56, LLVM 20.1.8, and the same wasm32 host-target pin).
- Config: the model artifact's own
  [`mlc-chat-config.json`](https://huggingface.co/mlc-ai/Qwen3-0.6B-q0f16-MLC/resolve/2d6c15b9dd8b99e021d978ada68faebbcfc12bb9/mlc-chat-config.json)
  from `mlc-ai/Qwen3-0.6B-q0f16-MLC` at revision
  `2d6c15b9dd8b99e021d978ada68faebbcfc12bb9` (the revision the catalog pins),
  with one top-level field added: `"active_vocab_size": 151936`. The configs `mlc_llm
  gen_config` produced for the Qwen2 build carry that field, but the copy published with the weights lacks
  it, and without it two GPU kernels (`chunk_lse_kernel` and
  `softmax_with_chunked_sum_kernel`) compile differently from upstream's
  library.

**Why it differs from upstream.** The same reason as the Qwen2 library: upstream
compiles for up to 128 sequences and reserves sampler storage for all of them at
load, six buffers of 128 × 151,936 (the vocabulary) × 4 bytes, 445 MiB of GPU
memory, while web-llm 0.2.84 only ever runs one sequence. At batch 1 the sampler
storage is 3,646,464 bytes instead of 466,747,392. These sizes come from the
compiler's memory plan for a build of the same config without the added field;
its VM executable differs only in the embedded metadata string and its host code
is identical after address normalisation, so the plan is the same.

**How the build was checked.**

- The same toolchain and config at `max_batch_size` 128 produce a library whose
  GPU kernels (106 of 106), WebGPU modules, metadata, weights layout and VM
  executable are identical to upstream's. It is not byte-identical: embedded
  source-path strings differ, and host code differs slightly (a different host
  compiler build), the same class of difference as the Qwen2 rebuild.
- Batch 1 against batch 128: 0 of 106 GPU kernels differ; the weights layout,
  VM function table, imports and exports are identical; metadata differs only
  in `max_batch_size`. Only the host memory plan and three shape functions
  change.
- Measured 2026-09-30 in Safari 26.4 on an Apple Silicon Mac (16 GB), loading
  the model only: the tab's graphics memory after load fell from 2,114 MB (both
  upstream's library and the batch-128 rebuild) to 1,672 MB, its footprint after
  load from 2,345–2,381 to 1,851–1,862 MB, and its peak from 2,432–2,446 to
  1,989–1,999 MB (three batch-1 runs).
- Greedy output was identical to upstream's library and to the batch-128 rebuild
  on five prompts (answers up to 504 characters).

**Rebuilding.** Download the config above, add the `active_vocab_size` field
after `vocab_size`, and compile it the way the Qwen2 library is compiled above
(same toolchain, same host-target pin):

```python
# after the host-target pin and the compile_cli import from the Qwen2 block above
compile_cli.main([
    "mlc-chat-config.json", "--device", "webgpu",
    "--overrides", "prefill_chunk_size=1024;max_batch_size=1",
    "--output", "Qwen3-0.6B-q0f16_cs1k_b1-webgpu.wasm",
])
```

A web-llm upgrade needs this library rebuilt at the toolchain commits that
match the new release; there is no upstream copy to re-download.

## Re-verifying

The two `_b1` libraries are built here, so there is no upstream copy to compare
them with: check their sha256 against the values above. Whether a rebuild with
the recipes above reproduces them byte for byte has not been checked. The 4-bit
Qwen3 library is compared with upstream.

```sh
shasum -a 256 Qwen2-0.5B-Instruct-q4f16_1_cs1k_b1-webgpu.wasm
shasum -a 256 Qwen3-0.6B-q0f16_cs1k_b1-webgpu.wasm

shasum -a 256 Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm
git hash-object Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm
gh api "repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm?ref=main" --jq .sha
```
