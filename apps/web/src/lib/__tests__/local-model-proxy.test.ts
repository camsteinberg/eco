// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  LOCAL_MODEL_PROXY_PATH_PREFIX,
  LOCAL_MODEL_PROXY_PATH_TEMPLATE,
  buildLocalModelProxyPath,
  buildHuggingFaceModelUrl,
  getLocalModelProxyRemoteConfig,
  parseLocalModelProxySlug,
} from "../local-model-proxy";

describe("local-model-proxy helpers", () => {
  it("builds a same-origin Transformers.js remote config", () => {
    expect(getLocalModelProxyRemoteConfig("https://eco.local/")).toEqual({
      remoteHost: "https://eco.local",
      remotePathTemplate: LOCAL_MODEL_PROXY_PATH_TEMPLATE,
    });
  });

  it("can pin the Transformers.js remote template to a reviewed revision", () => {
    expect(getLocalModelProxyRemoteConfig("https://eco.local/", "abc123")).toEqual({
      remoteHost: "https://eco.local",
      remotePathTemplate: "/api/local-models/{model}/resolve/abc123/",
    });
  });

  it("parses a namespaced Hugging Face model path from proxy slug segments", () => {
    expect(
      parseLocalModelProxySlug([
        "onnx-community",
        "Qwen3-0.6B-ONNX",
        "resolve",
        "main",
        "onnx",
        "model_q4f16.onnx",
      ]),
    ).toEqual({
      modelId: "onnx-community/Qwen3-0.6B-ONNX",
      revision: "main",
      filePath: "onnx/model_q4f16.onnx",
    });
  });

  it("rejects malformed proxy slugs that do not include a model file", () => {
    expect(parseLocalModelProxySlug(["onnx-community", "Qwen3-0.6B-ONNX"])).toBeNull();
    expect(
      parseLocalModelProxySlug([
        "onnx-community",
        "Qwen3-0.6B-ONNX",
        "resolve",
        "main",
      ]),
    ).toBeNull();
  });

  it("builds the canonical Hugging Face resolve URL for a proxied model file", () => {
    expect(
      buildHuggingFaceModelUrl({
        modelId: "onnx-community/Qwen3-0.6B-ONNX",
        revision: "main",
        filePath: "onnx/model_q4f16.onnx",
      }).toString(),
    ).toBe(
      "https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx",
    );
  });

  it("builds the same-origin proxy path for browser-side preflight checks", () => {
    expect(
      buildLocalModelProxyPath({
        modelId: "onnx-community/Qwen3-0.6B-ONNX",
        revision: "main",
        filePath: "config.json",
      }),
    ).toBe(
      "/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/main/config.json",
    );
  });

  it("keeps the route prefix stable for the worker proxy contract", () => {
    expect(LOCAL_MODEL_PROXY_PATH_PREFIX).toBe("/api/local-models");
  });
});
