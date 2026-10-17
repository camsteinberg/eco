// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { ortWebGpuDevice } from '../ort-webgpu-device';

function fakeDevice(): { lost: Promise<unknown>; destroy: () => void } {
  return { lost: new Promise(() => undefined), destroy: () => undefined };
}

describe('ortWebGpuDevice', () => {
  it('reads the device onnxruntime-web 1.26 stores as a plain value', async () => {
    const device = fakeDevice();
    expect(await ortWebGpuDevice({ webgpu: { device } })).toBe(device);
  });

  it('reads the Promise form the JSEP typings describe', async () => {
    const device = fakeDevice();
    expect(await ortWebGpuDevice({ webgpu: { device: Promise.resolve(device) } })).toBe(device);
  });

  it.each([
    ['no env', undefined],
    ['no webgpu env', {}],
    ['no session yet', { webgpu: {} }],
    ['not a device', { webgpu: { device: { destroy: () => undefined } } }],
  ])('is null with %s', async (_label, onnxEnv) => {
    expect(await ortWebGpuDevice(onnxEnv)).toBeNull();
  });

  it('is null when reading the device fails', async () => {
    expect(await ortWebGpuDevice({ webgpu: { device: Promise.reject(new Error('no adapter')) } })).toBeNull();
  });
});
