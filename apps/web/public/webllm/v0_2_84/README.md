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

### `Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm`

- Source: <https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm>
- Size: 4,850,160 bytes
- sha256: `611b584fd44af2789416395603965a6bc074f2127188af597f4dda016fbdab19`
- Integrity: git blob sha (`57ca1bfdb4c1afe0c005473016d0dbd67745a735`) verified
  identical to the upstream repository's blob metadata at vendoring time.
- Upstream project: [mlc-ai/binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs),
  Apache-2.0. The filename says "Qwen2" because the library is per-architecture;
  it serves the Qwen2.5-0.5B-Instruct q4f16 build (`candidate/qwen2.5-0.5b-mlc`).

## Re-verifying

```sh
shasum -a 256 Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm
git hash-object Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm
gh api "repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_84/base/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm?ref=main" --jq .sha
```
