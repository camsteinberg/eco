// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import { AdapterError } from '../types';
import { getModel } from '../../catalog/catalog';
import {
  buildWebLLMAppConfig,
  buildWebLLMModelRecord,
  stripMlcOrgPrefix,
  webllmCacheTargetFor,
  webllmModelBaseUrl,
  webllmModelLibPathFor,
} from '../webllm-config';

const ORIGIN = 'https://econetwork.ai';
const MLC_ID = 'Qwen2-0.5B-Instruct-q4f16_1-MLC';
const CTX = 4096;

/** Resolved from the map — tests use it to avoid duplicating the literal. */
const QWEN2_LIB_PATH = webllmModelLibPathFor({
  id: 'candidate/qwen2.5-0.5b-mlc',
} as ModelConfig);

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
    const record = buildWebLLMModelRecord(MLC_ID, ORIGIN, QWEN2_LIB_PATH, CTX);
    expect(record).toEqual({
      model: webllmModelBaseUrl(MLC_ID, ORIGIN),
      model_id: MLC_ID,
      model_lib: QWEN2_LIB_PATH,
      overrides: { context_window_size: CTX },
    });
    const appConfig = buildWebLLMAppConfig(MLC_ID, ORIGIN, QWEN2_LIB_PATH, CTX);
    expect(appConfig.model_list).toEqual([record]);
  });

  it('caps the engine KV window via overrides.context_window_size — from the arg, not a hardcode', () => {
    // ModelRecord.overrides.context_window_size is what MLC merges OVER the
    // model's native mlc-chat-config.json window at reload() (0.2.84:
    // {...mlcChatConfig, ...record.overrides, ...chatOpts}). It MUST reflect the
    // catalog value the caller threads in — Qwen2.5-0.5B ships a 32768 native
    // window, so without this the engine would allocate KV for 32k.
    const wide = buildWebLLMModelRecord(MLC_ID, ORIGIN, QWEN2_LIB_PATH, 8192);
    expect(wide.overrides?.context_window_size).toBe(8192);
    const capped = buildWebLLMModelRecord(MLC_ID, ORIGIN, QWEN2_LIB_PATH, CTX);
    expect(capped.overrides?.context_window_size).toBe(CTX);
    expect(buildWebLLMAppConfig(MLC_ID, ORIGIN, QWEN2_LIB_PATH, CTX).model_list[0]!.overrides?.context_window_size).toBe(CTX);
  });

  it('carries the SHIPPING catalog contextTokens for the WebLLM model (single source of truth)', () => {
    // The wired cap must equal what the catalog declares — if the catalog changes
    // its contextTokens, the engine cap follows with no separate edit here.
    const model = getModel('candidate/qwen2.5-0.5b-mlc');
    expect(model, 'catalog must ship the WebLLM model').not.toBeNull();
    const record = buildWebLLMModelRecord(
      stripMlcOrgPrefix(model!.artifact!.hfId),
      ORIGIN,
      webllmModelLibPathFor(model!),
      model!.capabilities.contextTokens,
    );
    expect(record.overrides?.context_window_size).toBe(model!.capabilities.contextTokens);
  });

  it('points model_lib at the same-origin versioned wasm dir', () => {
    expect(QWEN2_LIB_PATH).toBe(
      '/webllm/v0_2_84/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    );
  });
});

describe('webllmModelLibPathFor', () => {
  it('returns the Qwen2 library for candidate/qwen2.5-0.5b-mlc', () => {
    const model = { id: 'candidate/qwen2.5-0.5b-mlc', runtime: 'webllm' } as ModelConfig;
    expect(webllmModelLibPathFor(model)).toBe(QWEN2_LIB_PATH);
  });

  it('returns the Qwen3 library for candidate/qwen3-0.6b-mlc', () => {
    const model = { id: 'candidate/qwen3-0.6b-mlc', runtime: 'webllm' } as ModelConfig;
    expect(webllmModelLibPathFor(model)).toBe(
      '/webllm/v0_2_84/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm',
    );
  });

  it('throws AdapterError (init-failed) for an unregistered model id', () => {
    const model = { id: 'candidate/unknown-mlc', runtime: 'webllm' } as ModelConfig;
    expect(() => webllmModelLibPathFor(model)).toThrow(AdapterError);
    try {
      webllmModelLibPathFor(model);
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe('init-failed');
      expect((err as AdapterError).message).toContain('candidate/unknown-mlc');
    }
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
