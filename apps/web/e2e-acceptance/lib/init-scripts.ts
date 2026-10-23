// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Init scripts injected into browser pages before navigation.
 *
 * Each function here is passed to `page.addInitScript` (or
 * `context.addInitScript`), so it runs in the page's main thread before any
 * app code. They carry no imports and capture nothing from outside their body.
 *
 * The pure helpers (e.g. `wrapFeaturesWithoutShaderF16`) are exported so unit
 * tests can exercise the wrapping logic without a browser.
 */

/**
 * Wrap a `GPUSupportedFeatures`-like object so that `shader-f16` appears
 * absent: `has('shader-f16')` returns false, iteration (`forEach`, `entries`,
 * `keys`, `values`, `[Symbol.iterator]`) skips it, and `size` decreases by
 * one when `shader-f16` was present.
 *
 * Every other feature and limit passes through untouched.
 *
 * This is a PURE helper, exported for unit testing. The init script that
 * actually runs in the page calls it inline (serialised by Playwright), so
 * it must not close over anything external.
 */
export function wrapFeaturesWithoutShaderF16<
  T extends {
    has(name: string): boolean;
    forEach(cb: (value: string, key: string, set: T) => void, thisArg?: unknown): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    readonly size: number;
    [Symbol.iterator](): IterableIterator<string>;
  },
>(features: T): T {
  const hadF16 = features.has("shader-f16");

  // Proxy intercepts the methods and the `size` getter so that `shader-f16`
  // never appears, regardless of how the caller iterates the set.
  return new Proxy(features, {
    get(target, prop, receiver) {
      if (prop === "has") {
        return (name: string): boolean => {
          if (name === "shader-f16") return false;
          return target.has(name);
        };
      }

      if (prop === "size") {
        return hadF16 ? target.size - 1 : target.size;
      }

      if (prop === "forEach") {
        return (
          cb: (value: string, key: string, set: T) => void,
          thisArg?: unknown,
        ): void => {
          target.forEach((value, key, set) => {
            if (key === "shader-f16") return;
            cb.call(thisArg, value, key, set);
          });
        };
      }

      // Generators that filter out `shader-f16`.
      if (prop === "entries") {
        return function* () {
          for (const entry of target.entries()) {
            if (entry[0] !== "shader-f16") yield entry;
          }
        };
      }
      if (prop === "keys" || prop === "values") {
        return function* () {
          for (const entry of target.keys()) {
            if (entry !== "shader-f16") yield entry;
          }
        };
      }
      if (prop === Symbol.iterator) {
        return function* () {
          for (const entry of target[Symbol.iterator]()) {
            if (entry !== "shader-f16") yield entry;
          }
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * The init script that makes the main-thread adapter report `shader-f16` as
 * absent and sets `navigator.deviceMemory` to a chosen value.
 *
 * This is passed to `page.addInitScript` or `context.addInitScript`.
 *
 * NOTE: the ONNX worker creates its own adapter inside a Web Worker, which
 * does NOT inherit init scripts. The shim affects the main thread only —
 * device profiling, setup, and model selection happen there, so the routing
 * decision uses the shimmed adapter. The worker's actual adapter is whatever
 * the real GPU provides.
 */
export function f16LessInitScript(args: { deviceMemory: number }): void {
  // Set navigator.deviceMemory to the desired value.
  Object.defineProperty(navigator, "deviceMemory", {
    value: args.deviceMemory,
    writable: false,
    configurable: true,
  });

  // Wrap navigator.gpu.requestAdapter so the returned adapter's features
  // set never includes `shader-f16`.
  const gpu = navigator.gpu;
  if (!gpu) return;
  const origRequestAdapter: (...args: unknown[]) => Promise<GPUAdapter | null> =
    gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async function (): Promise<GPUAdapter | null> {
    // Forward all arguments the caller passed (the options object, if present).
    // eslint-disable-next-line prefer-rest-params
    const adapter = await origRequestAdapter(...arguments);
    if (!adapter) return adapter;

    // The features set is read-only on a real GPUAdapter; wrap it in a
    // proxy that hides `shader-f16` from every access pattern.
    const hadF16 = adapter.features.has("shader-f16");
    const origFeatures = adapter.features;

    const wrappedFeatures = new Proxy(origFeatures, {
      get(target, prop, receiver) {
        if (prop === "has") {
          return (name: string): boolean => {
            if (name === "shader-f16") return false;
            return target.has(name);
          };
        }
        if (prop === "size") {
          return hadF16 ? target.size - 1 : target.size;
        }
        if (prop === "forEach") {
          return (
            cb: (value: string, key: string, set: GPUSupportedFeatures) => void,
            thisArg?: unknown,
          ): void => {
            target.forEach((value, key, set) => {
              if (key === "shader-f16") return;
              cb.call(thisArg, value, key, set);
            });
          };
        }
        if (prop === "entries") {
          return function* () {
            for (const entry of target.entries()) {
              if (entry[0] !== "shader-f16") yield entry;
            }
          };
        }
        if (prop === "keys" || prop === "values") {
          return function* () {
            for (const entry of target.keys()) {
              if (entry !== "shader-f16") yield entry;
            }
          };
        }
        if (prop === Symbol.iterator) {
          return function* () {
            for (const entry of target[Symbol.iterator]()) {
              if (entry !== "shader-f16") yield entry;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Return a proxy of the adapter that returns wrappedFeatures for
    // the `features` property.
    return new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "features") return wrappedFeatures;
        return Reflect.get(target, prop, receiver);
      },
    });
  };
}
