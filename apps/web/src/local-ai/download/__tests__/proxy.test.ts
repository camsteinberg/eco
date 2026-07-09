// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_MODEL_PROXY_PATH_PREFIX,
  buildHuggingFaceURL,
  buildModelFileURL,
  buildProxyURL,
  getModelCdnBase,
  isSafeProxyFilePath,
  parseProxySlug,
} from '../proxy';

describe('buildProxyURL', () => {
  it('emits /api/local-models/{model}/resolve/{revision}/{file}', () => {
    const url = buildProxyURL({
      modelId: 'Xenova/phi-3-mini',
      revision: 'main',
      filePath: 'config.json',
    });
    expect(url).toBe('/api/local-models/Xenova/phi-3-mini/resolve/main/config.json');
  });

  it('encodes URL-unsafe segments', () => {
    const url = buildProxyURL({
      modelId: 'org/model name',
      revision: 'rev with space',
      filePath: 'sub dir/file name.json',
    });
    expect(url).toBe('/api/local-models/org/model%20name/resolve/rev%20with%20space/sub%20dir/file%20name.json');
  });

  it('preserves nested directory separators in filePath', () => {
    const url = buildProxyURL({
      modelId: 'foo/bar',
      revision: 'v1',
      filePath: 'onnx/model_quantized.onnx',
    });
    expect(url).toBe('/api/local-models/foo/bar/resolve/v1/onnx/model_quantized.onnx');
  });

  it('uses the documented prefix constant', () => {
    const url = buildProxyURL({ modelId: 'a/b', revision: 'r', filePath: 'f' });
    expect(url.startsWith(`${LOCAL_MODEL_PROXY_PATH_PREFIX}/`)).toBe(true);
  });
});

describe('parseProxySlug', () => {
  it('round-trips with buildProxyURL', () => {
    const input = { modelId: 'Xenova/phi-3-mini', revision: 'main', filePath: 'onnx/model.onnx' };
    const path = buildProxyURL(input);
    const slug = path.replace(`${LOCAL_MODEL_PROXY_PATH_PREFIX}/`, '').split('/').map(decodeURIComponent);
    const parsed = parseProxySlug(slug);
    expect(parsed).toEqual(input);
  });

  it('returns null on too-short slug', () => {
    expect(parseProxySlug(undefined)).toBeNull();
    expect(parseProxySlug([])).toBeNull();
    expect(parseProxySlug(['only-three', 'parts', 'here'])).toBeNull();
  });

  it('returns null when "resolve" is missing or out of position', () => {
    expect(parseProxySlug(['resolve', 'rev', 'file', 'extra'])).toBeNull();
    expect(parseProxySlug(['model', 'wrong', 'rev', 'file'])).toBeNull();
  });

  it('returns null on empty revision or filePath', () => {
    expect(parseProxySlug(['model', 'resolve', '', 'file'])).toBeNull();
    expect(parseProxySlug(['model', 'resolve', 'rev'])).toBeNull();
  });
});

describe('buildHuggingFaceURL', () => {
  it('mirrors the HF path layout', () => {
    const url = buildHuggingFaceURL({
      modelId: 'Xenova/phi-3-mini',
      revision: 'main',
      filePath: 'config.json',
    });
    expect(url.toString()).toBe('https://huggingface.co/Xenova/phi-3-mini/resolve/main/config.json');
  });
});

describe('isSafeProxyFilePath', () => {
  it.each([
    ['onnx/model.onnx', true],
    ['config.json', true],
    ['tokenizer/special_tokens.json', true],
    ['../etc/passwd', false],
    ['.hidden', false],
    ['onnx/.hidden', false],
    ['', false],
    ['ok//double-slash', false],
    ['contains\\backslash', false],
    ['percent-%2f-encoded', false],
    ['percent-%2F-encoded', false],
  ])('isSafeProxyFilePath(%j) === %j', (path, expected) => {
    expect(isSafeProxyFilePath(path)).toBe(expected);
  });
});

describe('buildModelFileURL', () => {
  const parsed = { modelId: 'Xenova/phi-3-mini', revision: 'main', filePath: 'onnx/model.onnx' };

  it('falls back to the same-origin proxy path when no CDN base is set', () => {
    const proxyPath = buildProxyURL(parsed);
    expect(buildModelFileURL(parsed)).toBe(proxyPath);
    expect(buildModelFileURL(parsed, undefined)).toBe(proxyPath);
    expect(buildModelFileURL(parsed, null)).toBe(proxyPath);
    expect(buildModelFileURL(parsed, '')).toBe(proxyPath);
    expect(buildModelFileURL(parsed, '   ')).toBe(proxyPath);
  });

  it('emits a direct CDN URL preserving the HF path layout when a base is set', () => {
    expect(buildModelFileURL(parsed, 'https://models.econetwork.ai')).toBe(
      'https://models.econetwork.ai/Xenova/phi-3-mini/resolve/main/onnx/model.onnx',
    );
  });

  it('does not double the slash on a trailing-slash base', () => {
    expect(buildModelFileURL(parsed, 'https://models.econetwork.ai/')).toBe(
      'https://models.econetwork.ai/Xenova/phi-3-mini/resolve/main/onnx/model.onnx',
    );
  });

  it('shares the proxy path suffix exactly (CDN URL = base + proxyPath minus prefix)', () => {
    const suffix = buildProxyURL(parsed).slice(LOCAL_MODEL_PROXY_PATH_PREFIX.length);
    expect(buildModelFileURL(parsed, 'https://cdn.example.com')).toBe(`https://cdn.example.com${suffix}`);
  });

  it('encodes URL-unsafe segments the same way as the proxy path', () => {
    const spec = { modelId: 'org/model name', revision: 'rev x', filePath: 'sub dir/f.json' };
    expect(buildModelFileURL(spec, 'https://cdn.example.com')).toBe(
      'https://cdn.example.com/org/model%20name/resolve/rev%20x/sub%20dir/f.json',
    );
  });
});

describe('getModelCdnBase', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns undefined when the env is blank/unset', () => {
    vi.stubEnv('NEXT_PUBLIC_ECO_MODEL_CDN_BASE', '');
    expect(getModelCdnBase()).toBeUndefined();
  });

  it('returns the trimmed base when set', () => {
    vi.stubEnv('NEXT_PUBLIC_ECO_MODEL_CDN_BASE', '  https://models.econetwork.ai  ');
    expect(getModelCdnBase()).toBe('https://models.econetwork.ai');
  });
});
