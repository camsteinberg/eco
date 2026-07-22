// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import {
  buildWebLLMAppConfig,
  buildWebLLMModelRecord,
  stripMlcOrgPrefix,
  webllmCacheTargetFor,
  webllmModelBaseUrl,
  webllmModelLibPathFor,
  WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH,
} from '../webllm-config';

const ORIGIN = 'https://econetwork.ai';
const MLC_ID = 'Qwen2-0.5B-Instruct-q4f16_1-MLC';

describe('stripMlcOrgPrefix', () => {
  it('strips the mlc-ai/ org prefix', () => {
    expect(stripMlcOrgPrefix('mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC')).toBe(MLC_ID);
  });

  it('leaves a non-mlc-ai id unchanged', () => {
    expect(stripMlcOrgPrefix('other-org/SomeModel-MLC')).toBe('other-org/SomeModel-MLC');
  });

  it('is idempotent on an already-stripped id', () => {
    expect(stripMlcOrgPrefix(MLC_ID)).toBe(MLC_ID);
  });
});

describe('webllmModelBaseUrl', () => {
  it('builds an absolute same-origin base already in web-llm cleanModelUrl form', () => {
    const base = webllmModelBaseUrl(MLC_ID, ORIGIN);
    expect(base).toBe(`${ORIGIN}/webllm/models/${MLC_ID}/resolve/main/`);
  });

  it('ends in /resolve/main/ so web-llm cleanModelUrl is idempotent (no appended resolve segment)', () => {
    // cleanModelUrl only appends `resolve/main/` when the URL lacks a
    // `/resolve/.../` segment; ours already has one, so the engine keys its
    // lookups by exactly this string.
    const base = webllmModelBaseUrl(MLC_ID, ORIGIN);
    expect(base.endsWith('/resolve/main/')).toBe(true);
    expect(/\/resolve\/.+\//.test(base)).toBe(true);
    // Must be a valid absolute URL (cleanModelUrl calls new URL(base)).
    expect(() => new URL(base)).not.toThrow();
  });
});

describe('buildWebLLMModelRecord / buildWebLLMAppConfig', () => {
  it('builds a single-record config whose base matches webllmModelBaseUrl', () => {
    const record = buildWebLLMModelRecord(MLC_ID, ORIGIN, WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH);
    expect(record).toEqual({
      model: webllmModelBaseUrl(MLC_ID, ORIGIN),
      model_id: MLC_ID,
      model_lib: WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH,
    });
    const appConfig = buildWebLLMAppConfig(MLC_ID, ORIGIN, WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH);
    expect(appConfig.model_list).toEqual([record]);
  });

  it('points model_lib at the same-origin versioned wasm dir', () => {
    expect(WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH).toBe(
      '/webllm/v0_2_84/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    );
  });
});

describe('webllmModelLibPathFor', () => {
  it('returns the single vendored library for any webllm model this stage', () => {
    const model = { id: 'x', runtime: 'webllm' } as ModelConfig;
    expect(webllmModelLibPathFor(model)).toBe(WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH);
  });
});

describe('webllmCacheTargetFor', () => {
  const base = webllmModelBaseUrl(MLC_ID, ORIGIN);

  it('routes mlc-chat-config.json to webllm/config', () => {
    const { scope, key } = webllmCacheTargetFor('mlc-chat-config.json', base);
    expect(scope).toBe('webllm/config');
    expect(key).toBe(`${base}mlc-chat-config.json`);
  });

  it.each([
    'tensor-cache.json',
    'params_shard_0.bin',
    'params_shard_12.bin',
    'tokenizer.json',
    'tokenizer.model',
  ])('routes %s to webllm/model with a base+name key', (fileName) => {
    const { scope, key } = webllmCacheTargetFor(fileName, base);
    expect(scope).toBe('webllm/model');
    expect(key).toBe(`${base}${fileName}`);
    // The key is exactly what web-llm computes: new URL(name, base).href.
    expect(key).toBe(new URL(fileName, base).href);
  });
});
