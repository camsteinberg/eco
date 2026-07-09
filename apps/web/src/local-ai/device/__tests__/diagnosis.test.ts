// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { diagnoseUnsupportedProfile } from '../diagnosis';
import type { DeviceProfile } from '../../types';

function makeProfile(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    ...overrides,
  };
}

describe('diagnoseUnsupportedProfile', () => {
  it('returns browser-class guidance for webgpuSupport === none', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ webgpuSupport: 'none', browserClass: 'firefox' }),
    );
    expect(result.guidance).toContain('Firefox');
    expect(result.guidance).toContain('Chrome or Edge');
    expect(result.guidance).not.toContain('Eco Network');
  });

  it('returns non-chromium guidance for Safari with wasm-only', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ webgpuSupport: 'wasm-only', browserClass: 'safari' }),
    );
    expect(result.guidance).toContain('Safari');
    expect(result.guidance).toContain('Chrome or Edge');
    expect(result.guidance).not.toContain('Eco Network');
  });

  it('returns mobile guidance for mobile devices', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ isMobile: true, browserClass: 'chromium' }),
    );
    expect(result.guidance).toContain('mobile');
    expect(result.guidance).toContain('Chrome or Edge');
    expect(result.guidance).not.toContain('Eco Network');
  });

  it('returns low-memory guidance for chromium with < 8 GB', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ deviceMemoryGB: 4, webgpuSupport: 'webgpu' }),
    );
    expect(result.guidance).toContain('8 GB');
    expect(result.guidance).toContain('Smaller models');
  });

  it('returns wasm-only guidance for chromium wasm-only', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ webgpuSupport: 'wasm-only', browserClass: 'chromium' }),
    );
    expect(result.guidance).toContain('WebAssembly');
    expect(result.guidance).toContain('not WebGPU');
  });

  it('returns generic fallback for unknown profile', () => {
    const result = diagnoseUnsupportedProfile(
      makeProfile({ browserClass: 'unknown', webgpuSupport: 'webgpu', deviceMemoryGB: 16 }),
    );
    expect(result.guidance).toContain('Eco hasn\'t tested');
    expect(result.guidance).toContain('validation');
  });
});
