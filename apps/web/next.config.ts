// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appRoot, "..", "..");

const nextConfig: NextConfig = {
  transpilePackages: ["@eco/ui"],
  turbopack: {
    root: workspaceRoot,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Prevent @huggingface/transformers from being bundled on the server.
      // It is a browser-only library that uses Web Workers and WebGPU.
      config.resolve.alias['@huggingface/transformers'] = false;
    }
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      {
        // `unpdf` ships a bundled pdf.js entry with a benign expression-based
        // dependency that webpack warns about even though we only load the
        // extractor lazily in the browser when the user uploads a PDF.
        module: /unpdf[\\/]dist[\\/]pdfjs\.mjs$/,
        message:
          /Critical dependency: the request of a dependency is an expression/,
      },
    ];
    // Enable async WebAssembly compilation for WASM inference fallback.
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
  outputFileTracingExcludes: {
    '*': ['@huggingface/transformers'],
  },
  outputFileTracingIncludes: {
    '/api/ort/[file]': ['./node_modules/onnxruntime-web/dist/**/*'],
    // Without this the LiteRT engine assets are absent from the deployed
    // function bundle and the route 404s in production only — which killed
    // every real-prod Gemma load instantly (founder device, 2026-07-03).
    '/api/litert-wasm/[file]': ['./node_modules/@litert-lm/core/wasm/**/*'],
  },
  async headers() {
    // Cross-origin isolation unlocks SharedArrayBuffer, which is what lets
    // onnxruntime-web size its WASM thread pool above 1 (it keys numThreads on
    // `crossOriginIsolated`; the threaded artifact already ships via
    // /api/ort/[file]). Measured ~1.3× generation throughput on the WASM floor
    // model — larger models gain more.
    //
    // COEP is `require-corp`, not `credentialless`: Safari (through 27) does
    // not implement `credentialless`, and Safari is exactly the browser class
    // the WASM path serves most. The strictness is affordable because the CSP
    // pins subresources to 'self' — but it means any FUTURE cross-origin
    // embedded resource (image/script/font) must send
    // Cross-Origin-Resource-Policy, and cross-origin fetches must use CORS
    // (the model CDN already does).
    //
    // Applied globally, not just to /chat: /chat is reached by client-side
    // navigation, and isolation is a property of the document that first
    // loaded — a route-scoped header would leave SPA-nav users single-threaded.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ]
  },
  async redirects() {
    // Retired public routes: the contributor/developer/miner surfaces were
    // reconned to the future desktop product and their pages removed. Old
    // inbound links land on the browser chat product instead of a 404.
    return [
      { source: '/founding-miners', destination: '/chat', permanent: true },
      { source: '/contributors', destination: '/chat', permanent: true },
      { source: '/developers', destination: '/chat', permanent: true },
    ]
  },
  async rewrites() {
    const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').trim()
    return [
      {
        source: '/api/auth/:path*',
        destination: `${apiUrl}/api/auth/:path*`,
      },
      {
        source: '/v1/:path*',
        destination: `${apiUrl}/v1/:path*`,
      },
    ]
  },
};

export default withBundleAnalyzer(
  withSentryConfig(nextConfig, {
    silent: true,
    org: "eco-network",
    project: "eco-web",
    webpack: {
      treeshake: {
        // Tree-shake Sentry debug-logging code out of the production client
        // bundle (the @sentry/nextjs-native replacement for a manual
        // `__SENTRY_DEBUG__: false` DefinePlugin, which is a no-op here because
        // withSentryConfig manages these flags through its own bundler plugin).
        // Debug console logging is never wanted in a shipped bundle, so this is
        // always safe. We deliberately leave `removeTracing` at its default
        // (false): production performance tracing is active (tracesSampleRate:
        // 0.1 in instrumentation-client.ts / instrumentation.ts), so removing it
        // would drop performance spans.
        removeDebugLogging: true,
      },
    },
  })
);
