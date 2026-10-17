// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebGPU for the Transformers.js worker: which execution provider a load uses
 * (`chooseBackend`), and the device onnxruntime-web runs the loaded model on,
 * read from ORT's env (`ortWebGpuDevice`).
 *
 * onnxruntime-web 1.26 (the build Transformers.js 4.2.0 imports, as
 * `onnxruntime-web/webgpu`) stores the device it created on `env.webgpu.device`
 * once the first WebGPU session exists (`webgpuInit` in `ort.webgpu.mjs`).
 * Transformers.js exposes that env as `env.backends.onnx`, whose nested
 * `webgpu` object is ORT's own (spread at the top level only), so the value is
 * live. The property is a plain `GPUDevice` in this build; its typings, written
 * for the older JSEP build, say `Promise<GPUDevice>` — awaiting covers both.
 *
 * WebGPU types are not wired into the worker lib, so the device is typed by the
 * two members the worker uses.
 */

export type WorkerGpuDevice = {
  /** Resolves when the device is lost, including by `destroy()`. */
  lost: Promise<unknown>;
  destroy(): void;
};

function isWorkerGpuDevice(value: unknown): value is WorkerGpuDevice {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { lost?: unknown; destroy?: unknown };
  return candidate.lost instanceof Promise && typeof candidate.destroy === 'function';
}

/**
 * The device in `onnxEnv.webgpu.device` (`onnxEnv` is Transformers.js's
 * `env.backends.onnx`), or null when there is none — no WebGPU session yet, or
 * a WASM load.
 */
export async function ortWebGpuDevice(onnxEnv: unknown): Promise<WorkerGpuDevice | null> {
  const webgpu = (onnxEnv as { webgpu?: { device?: unknown } } | null | undefined)?.webgpu;
  try {
    const device: unknown = await webgpu?.device;
    return isWorkerGpuDevice(device) ? device : null;
  } catch {
    return null;
  }
}

export type BackendChoice = 'webgpu' | 'wasm' | 'webgpu-unavailable';

/**
 * Which execution provider a load uses. With no usable WebGPU adapter the WASM
 * EP is the fallback — unless the load requires WebGPU (a model the CPU EP
 * cannot run, or a page that lost its device), where falling back would only
 * fail later ("Kernel not found", read as a crash) or answer slowly on the CPU
 * when a page reload would get a fresh adapter. An explicit `forceWasm` (the
 * measurement lever) wins.
 */
export function chooseBackend(input: {
  forceWasm: boolean;
  requireWebGpu: boolean;
  webGpuUsable: boolean;
}): BackendChoice {
  if (input.forceWasm) return 'wasm';
  if (input.webGpuUsable) return 'webgpu';
  return input.requireWebGpu ? 'webgpu-unavailable' : 'wasm';
}
