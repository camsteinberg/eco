// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * useSwitchAI on desktop Safari after a demotion — the way back.
 *
 * Real catalog, real ledger, real dedupe; only the device profile is mocked.
 * After the Mac's MLC build fails and setup demotes to Eco Mobile, the Switch
 * list must still offer the Mac build (a different name now, so the dedupe
 * cannot fold it into the current row) and must offer no ONNX build.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { getModel } from '../../../local-ai/catalog/catalog';
import { clearEvidence, recordEvidence } from '../../../local-ai/evidence/ledger';
import type { DeviceProfile } from '../../../local-ai/types';
import { useSwitchAI } from '../useSwitchAI';

const DESKTOP_SAFARI: DeviceProfile = {
  browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 0, isMobile: false, override: 'auto', webgpuShaderF16: true,
};

vi.mock('../useDeviceProfile', () => ({
  useDeviceProfile: () => DESKTOP_SAFARI,
}));

const MAC_MLC = 'candidate/qwen3-0.6b-mlc-q0f16';
const MOBILE_MLC = 'candidate/qwen2.5-0.5b-mlc';

beforeEach(() => {
  localStorage.clear();
  clearEvidence();
});

describe('useSwitchAI — desktop Safari demoted to Eco Mobile', () => {
  it('offers the Mac build back, alongside the current model, and no ONNX build', () => {
    recordEvidence({ modelId: MAC_MLC, profile: DESKTOP_SAFARI, outcome: 'smoke-fail' });

    const { result } = renderHook(() => useSwitchAI({
      slot: 'eco-fast',
      currentModel: getModel(MOBILE_MLC),
      onSwitchRequested: vi.fn(),
    }));

    expect(result.current.choices.map((c) => c.model.id)).toEqual([MAC_MLC, MOBILE_MLC]);
  });
});
