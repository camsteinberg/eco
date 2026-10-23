// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { wrapFeaturesWithoutShaderF16 } from "../lib/init-scripts";

/**
 * A minimal `GPUSupportedFeatures`-like object for testing the wrapping logic.
 * Real `GPUSupportedFeatures` is a `ReadonlySetLike<string>` on the GPU adapter;
 * this stub reproduces the interface the wrapper depends on.
 */
type FakeFeatures = {
  has(name: string): boolean;
  forEach(cb: (value: string, key: string, set: FakeFeatures) => void, thisArg?: unknown): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  readonly size: number;
  [Symbol.iterator](): IterableIterator<string>;
};

function fakeFeatures(names: string[]): FakeFeatures {
  const inner = new Set(names);
  const obj: FakeFeatures = {
    has: (name: string) => inner.has(name),
    forEach: (cb: (value: string, key: string, set: FakeFeatures) => void, thisArg?: unknown) => {
      for (const name of inner) cb.call(thisArg, name, name, obj);
    },
    entries: function* () {
      for (const name of inner) yield [name, name] as [string, string];
    },
    keys: function* () {
      yield* inner;
    },
    values: function* () {
      yield* inner;
    },
    get size() {
      return inner.size;
    },
    [Symbol.iterator]: function* () {
      yield* inner;
    },
  };
  return obj;
}

describe("wrapFeaturesWithoutShaderF16", () => {
  it("hides shader-f16 from has()", () => {
    const features = fakeFeatures(["shader-f16", "timestamp-query"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect(wrapped.has("shader-f16")).toBe(false);
    expect(wrapped.has("timestamp-query")).toBe(true);
  });

  it("decreases size by one when shader-f16 was present", () => {
    const features = fakeFeatures(["shader-f16", "timestamp-query", "bgra8unorm-storage"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect(wrapped.size).toBe(2);
  });

  it("leaves size unchanged when shader-f16 was absent", () => {
    const features = fakeFeatures(["timestamp-query"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect(wrapped.size).toBe(1);
  });

  it("skips shader-f16 in forEach", () => {
    const features = fakeFeatures(["shader-f16", "timestamp-query"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    const seen: string[] = [];
    wrapped.forEach((value) => seen.push(value));
    expect(seen).toEqual(["timestamp-query"]);
  });

  it("skips shader-f16 in entries()", () => {
    const features = fakeFeatures(["shader-f16", "bgra8unorm-storage"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    const entries = [...wrapped.entries()];
    expect(entries).toEqual([["bgra8unorm-storage", "bgra8unorm-storage"]]);
  });

  it("skips shader-f16 in keys()", () => {
    const features = fakeFeatures(["shader-f16", "bgra8unorm-storage"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect([...wrapped.keys()]).toEqual(["bgra8unorm-storage"]);
  });

  it("skips shader-f16 in values()", () => {
    const features = fakeFeatures(["shader-f16", "bgra8unorm-storage"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect([...wrapped.values()]).toEqual(["bgra8unorm-storage"]);
  });

  it("skips shader-f16 in [Symbol.iterator]", () => {
    const features = fakeFeatures(["shader-f16", "bgra8unorm-storage"]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect([...wrapped]).toEqual(["bgra8unorm-storage"]);
  });

  it("passes through every other feature untouched", () => {
    const names = ["timestamp-query", "bgra8unorm-storage", "float32-filterable"];
    const features = fakeFeatures(names);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect(wrapped.size).toBe(3);
    for (const name of names) {
      expect(wrapped.has(name)).toBe(true);
    }
    expect([...wrapped]).toEqual(names);
  });

  it("works on an empty set", () => {
    const features = fakeFeatures([]);
    const wrapped = wrapFeaturesWithoutShaderF16(features);
    expect(wrapped.size).toBe(0);
    expect(wrapped.has("shader-f16")).toBe(false);
    expect([...wrapped]).toEqual([]);
  });
});
