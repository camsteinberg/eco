// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@eco/ui';
import { EvalHarnessPanel } from './EvalHarnessPanel';
import { SustainedProbePanel } from './SustainedProbePanel';
import type { LocalAiDiagnostic } from '../../../src/local-ai/diagnostics/capture';
import {
  clearDiagnostics,
  exportDiagnostics,
  loadDiagnostics,
} from '../../../src/local-ai/diagnostics/capture';
import { buildSupportSummary } from '../../../src/local-ai/diagnostics/support-summary';
import type { DownloadSelfTestResult } from '../../../src/local-ai/download/self-test';

// ─── Types ────────────────────────────────────────────────────────────────

type DeviceInfo = {
  userAgent: string;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number | null;
  browserClass: string;
  webgpuSupport: string;
  deviceClass: string;
};

type SmokeLogEntry = {
  modelId: string;
  status: 'pending' | 'running' | 'done';
  log: string[];
};

type TestableModel = { id: string; friendlyName: string; sizeGB: number };

const VERDICT_STYLE: Record<
  DownloadSelfTestResult['verdict']['kind'],
  { label: string; fg: string; bg: string }
> = {
  ok: { label: 'Working', fg: 'var(--eco-success, #2d5a3d)', bg: 'var(--eco-success-soft, rgba(45, 90, 61, 0.1))' },
  slow: { label: 'Slow', fg: 'var(--eco-amber, #d4a853)', bg: 'var(--eco-warning-soft, rgba(212, 168, 83, 0.14))' },
  'fast-fail': { label: 'Blocked', fg: 'var(--eco-error, #c75c4a)', bg: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))' },
  'http-error': { label: 'Server error', fg: 'var(--eco-error, #c75c4a)', bg: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))' },
};

// ─── Component ────────────────────────────────────────────────────────────

export function DiagnosticsClient() {
  const searchParams = useSearchParams();
  const enabled = searchParams.get('eco-diagnostics') === '1';
  const autoRun = searchParams.get('eco-diagnostics-autorun') === '1';
  const consoleLog = searchParams.get('eco-diagnostics-console') === '1';

  const [hydrated, setHydrated] = useState(false);
  const [entries, setEntries] = useState<LocalAiDiagnostic[]>([]);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [smokeLogs, setSmokeLogs] = useState<SmokeLogEntry[]>([]);
  const [autoRunning, setAutoRunning] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Download self-test
  const [testableModels, setTestableModels] = useState<TestableModel[]>([]);
  const [selfTestModelId, setSelfTestModelId] = useState('');
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<DownloadSelfTestResult | null>(null);
  const [selfTestError, setSelfTestError] = useState<string | null>(null);
  const [selfTestFileName, setSelfTestFileName] = useState<string | null>(null);

  // Hydrate on mount
  useEffect(() => {
    setHydrated(true);
    if (!enabled) return;

    setEntries(loadDiagnostics());

    // Device profile — dynamic import to avoid SSR issues
    void (async () => {
      try {
        const { getDeviceProfile } = await import('../../../src/local-ai/device/profile');
        const { classifyDeviceClass } = await import('../../../src/local-ai/evidence/seed');
        const profile = getDeviceProfile();
        setDeviceInfo({
          userAgent: navigator.userAgent,
          deviceMemoryGB: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          browserClass: profile.browserClass,
          webgpuSupport: profile.webgpuSupport,
          deviceClass: classifyDeviceClass(profile),
        });
      } catch {
        setDeviceInfo({
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
          deviceMemoryGB: null,
          hardwareConcurrency: null,
          browserClass: 'unknown',
          webgpuSupport: 'unknown',
          deviceClass: 'unknown',
        });
      }
    })();

    // Downloadable models for the self-test — largest first (biggest download
    // is the likeliest to expose a proxy/connection problem).
    void (async () => {
      try {
        const { getCatalog } = await import('../../../src/local-ai/catalog/catalog');
        const models = getCatalog()
          .filter((m) => m.artifact)
          .map((m) => ({ id: m.id, friendlyName: m.friendlyName, sizeGB: m.sizeGB }))
          .sort((a, b) => b.sizeGB - a.sizeGB);
        setTestableModels(models);
        if (models[0]) setSelfTestModelId(models[0].id);
      } catch {
        // Non-fatal — the self-test section just won't have models to pick.
      }
    })();
  }, [enabled]);

  // Console logging subscriber
  useEffect(() => {
    if (!consoleLog || !enabled) return;
    // Poll for new entries every 2 seconds and log new ones
    let lastCount = 0;
    const interval = setInterval(() => {
      const current = loadDiagnostics();
      if (current.length > lastCount) {
        for (let i = lastCount; i < current.length; i++) {
          const entry = current[i];
          if (entry) {
            console.info('[eco-diag]', {
              modelId: entry.modelId,
              outcome: entry.outcome,
              durations: entry.durations,
              error: entry.error,
              events: entry.events,
            });
          }
        }
        lastCount = current.length;
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [consoleLog, enabled]);

  // Auto-run on mount
  useEffect(() => {
    if (!autoRun || !enabled || !hydrated) return;
    void runAllSmokes();
  }, [autoRun, enabled, hydrated]); // runAllSmokes intentionally omitted — fire once on mount

  const refresh = useCallback(() => {
    setEntries(loadDiagnostics());
  }, []);

  const handleClear = useCallback(() => {
    clearDiagnostics();
    setEntries([]);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      const json = await exportDiagnostics();
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text for manual copy
    }
  }, []);

  const handleDownload = useCallback(async () => {
    const json = await exportDiagnostics();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eco-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleEmail = useCallback(() => {
    const summary = buildSupportSummary(loadDiagnostics());
    const subject = encodeURIComponent('Eco — on-device AI setup report');
    const body = encodeURIComponent(`Hi Eco team,\n\nSetup on my device had trouble. Details:\n\n${summary}\n`);
    window.location.href = `mailto:hello@econetwork.ai?subject=${subject}&body=${body}`;
  }, []);

  const runSelfTest = useCallback(async () => {
    if (!selfTestModelId) return;
    setSelfTestRunning(true);
    setSelfTestResult(null);
    setSelfTestError(null);
    setSelfTestFileName(null);
    try {
      // Bootstrap sets the download-plan resolver (idempotent).
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();

      const { getModel } = await import('../../../src/local-ai/catalog/catalog');
      const model = getModel(selfTestModelId);
      if (!model) {
        setSelfTestError('Model not found in catalog.');
        return;
      }

      const { peekDownloadPlan } = await import('../../../src/local-ai/download/download');
      const plan = await peekDownloadPlan(model);
      if (!plan || plan.files.length === 0) {
        setSelfTestError('Could not resolve a download URL for this model.');
        return;
      }

      // Test the largest file — that's where duration/streaming limits bite.
      const file = plan.files.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a));
      setSelfTestFileName(file.url.split('/').filter(Boolean).pop() ?? file.url);

      const { runDownloadSelfTest } = await import('../../../src/local-ai/download/self-test');
      setSelfTestResult(await runDownloadSelfTest({ url: file.url }));
    } catch (err) {
      setSelfTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelfTestRunning(false);
    }
  }, [selfTestModelId]);

  const appendLog = useCallback((modelId: string, line: string) => {
    setSmokeLogs((prev) =>
      prev.map((entry) =>
        entry.modelId === modelId
          ? { ...entry, log: [...entry.log, line] }
          : entry,
      ),
    );
    if (consoleLog) {
      console.info('[eco-diag]', modelId, line);
    }
  }, [consoleLog]);

  const runSingleSmoke = useCallback(async (modelId: string) => {
    setSmokeLogs((prev) =>
      prev.map((entry) =>
        entry.modelId === modelId
          ? { ...entry, status: 'running', log: ['Starting smoke...'] }
          : entry,
      ),
    );

    try {
      // Bootstrap is idempotent — safe to call on every smoke invocation.
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();

      const { getModel } = await import('../../../src/local-ai/catalog/catalog');
      const model = getModel(modelId);
      if (!model) {
        appendLog(modelId, 'ERROR: Model not found in catalog');
        setSmokeLogs((prev) =>
          prev.map((e) => (e.modelId === modelId ? { ...e, status: 'done' } : e)),
        );
        return;
      }

      appendLog(modelId, `Model: ${model.friendlyName} (${model.runtime})`);
      appendLog(modelId, `Size: ${model.sizeGB} GB, Format: ${model.format}`);

      const { runSmoke } = await import('../../../src/local-ai/lifecycle/smoke');
      const { hasSmokeGenerationFn } = await import('../../../src/local-ai/lifecycle/smoke');

      if (!hasSmokeGenerationFn()) {
        appendLog(modelId, 'WARNING: No smoke generation function registered after bootstrap.');
        appendLog(modelId, 'This indicates a deeper wiring failure — diagnostics will still capture probes.');
      }

      const result = await runSmoke('eco-fast', model);

      if (result.passed) {
        appendLog(modelId, `PASS: firstToken=${result.firstTokenMs}ms, tokens=${result.tokensReceived}, total=${result.durationMs}ms`);
      } else {
        appendLog(modelId, `FAIL: ${result.reason} (${result.durationMs}ms)`);
      }
    } catch (err) {
      appendLog(modelId, `ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSmokeLogs((prev) =>
        prev.map((e) => (e.modelId === modelId ? { ...e, status: 'done' } : e)),
      );
      refresh();
    }
  }, [appendLog, refresh]);

  const runAllSmokes = useCallback(async () => {
    setAutoRunning(true);
    try {
      // Bootstrap all DI seams before running smokes. Without this, the
      // smoke generation function is never registered and every smoke
      // hits the "no fn" early-return path.
      setSmokeLogs([{ modelId: '__bootstrap__', status: 'running', log: ['Bootstrapping local-AI seams...'] }]);
      const { bootstrapLocalAi } = await import('../../../src/local-ai/bootstrap');
      await bootstrapLocalAi();
      const { hasSmokeGenerationFn } = await import('../../../src/local-ai/lifecycle/smoke');
      setSmokeLogs([{
        modelId: '__bootstrap__',
        status: 'done',
        log: [
          'Bootstrapping local-AI seams...',
          `Bootstrapped. Smoke generation function registered: ${hasSmokeGenerationFn()}`,
        ],
      }]);

      const catalogModule = await import('../../../src/local-ai/catalog/catalog');
      const models = catalogModule.getCatalog();
      const initialLogs: SmokeLogEntry[] = models.map((m) => ({
        modelId: m.id,
        status: 'pending' as const,
        log: [],
      }));
      setSmokeLogs((prev) => {
        // Preserve the bootstrap log entry at the top
        const bootstrap = prev.find((e) => e.modelId === '__bootstrap__');
        return bootstrap ? [bootstrap, ...initialLogs] : initialLogs;
      });

      for (const model of models) {
        await runSingleSmoke(model.id);
      }
    } catch (err) {
      console.error('[eco-diag] Auto-run failed:', err);
    } finally {
      setAutoRunning(false);
      refresh();
    }
  }, [runSingleSmoke, refresh]);

  // SSR shell
  if (!hydrated) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--eco-surface)' }}>
        <div className="mx-auto max-w-4xl px-4 py-10">
          <h1
            className="text-2xl tracking-tight"
            style={{ fontFamily: 'var(--eco-font-display)', color: 'var(--eco-text)' }}
          >
            Local AI Diagnostics
          </h1>
          <p
            className="mt-2 text-sm"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            Loading...
          </p>
        </div>
      </div>
    );
  }

  // Gate: diagnostics not enabled
  if (!enabled) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--eco-surface)' }}>
        <div className="text-center">
          <h1
            className="text-2xl tracking-tight"
            style={{ fontFamily: 'var(--eco-font-display)', color: 'var(--eco-text)' }}
          >
            Diagnostics are not enabled
          </h1>
          <p
            className="mt-3 max-w-md text-sm"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            Append <code
              className="rounded px-1.5 py-0.5 text-xs"
              style={{
                fontFamily: 'var(--eco-font-mono)',
                background: 'var(--eco-primary-soft)',
                color: 'var(--eco-text)',
              }}
            >?eco-diagnostics=1</code> to the URL to enable the diagnostic surface.
          </p>
        </div>
      </div>
    );
  }

  // Main diagnostics UI
  return (
    <div className="min-h-screen" style={{ background: 'var(--eco-surface)' }}>
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1
            className="text-2xl tracking-tight"
            style={{ fontFamily: 'var(--eco-font-display)', color: 'var(--eco-text)' }}
          >
            Local AI Diagnostics
          </h1>
          <p
            className="mt-1.5 text-sm"
            style={{ color: 'var(--eco-text-secondary)' }}
          >
            Structured failure capture for smoke verification. Share the JSON
            dump to help debug model failures on your device.
          </p>
        </div>

        {/* Device profile card */}
        {deviceInfo && (
          <section
            className="mb-8 rounded-xl p-5"
            style={{
              border: '1px solid var(--eco-border-muted)',
              background: 'var(--eco-surface-elevated)',
            }}
            aria-label="Device profile"
          >
            <h2
              className="mb-3 text-sm font-medium uppercase tracking-wide"
              style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
            >
              Device Profile
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>Browser</dt>
              <dd style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}>{deviceInfo.browserClass}</dd>
              <dt style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>WebGPU</dt>
              <dd style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}>{deviceInfo.webgpuSupport}</dd>
              <dt style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>Device class</dt>
              <dd style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}>{deviceInfo.deviceClass}</dd>
              <dt style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>Memory</dt>
              <dd style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}>
                {deviceInfo.deviceMemoryGB !== null ? `${deviceInfo.deviceMemoryGB} GB` : 'not reported'}
              </dd>
              <dt style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>Concurrency</dt>
              <dd style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}>
                {deviceInfo.hardwareConcurrency ?? 'not reported'}
              </dd>
              <dt style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>User agent</dt>
              <dd
                className="truncate"
                style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}
                title={deviceInfo.userAgent}
              >
                {deviceInfo.userAgent}
              </dd>
            </dl>
          </section>
        )}

        {/* Actions bar */}
        <div className="mb-6 flex flex-wrap gap-3">
          <Button onClick={handleCopy} variant="primary">
            {copied ? 'Copied' : 'Copy as JSON'}
          </Button>
          <Button onClick={handleDownload} variant="secondary">
            Download .json
          </Button>
          <Button onClick={handleEmail} variant="secondary">
            Email to us
          </Button>
          <Button onClick={handleClear} variant="secondary">
            Clear diagnostics
          </Button>
          <Button onClick={refresh} variant="secondary">
            Refresh
          </Button>
          <Button onClick={runAllSmokes} variant="secondary" disabled={autoRunning}>
            {autoRunning ? 'Running...' : 'Run all smokes'}
          </Button>
        </div>

        {/* Download self-test */}
        <section
          className="mb-8 rounded-xl p-5"
          style={{
            border: '1px solid var(--eco-border-muted)',
            background: 'var(--eco-surface-elevated)',
          }}
          aria-label="Download test"
        >
          <h2
            className="mb-1.5 text-sm font-medium uppercase tracking-wide"
            style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
          >
            Download Test
          </h2>
          <p className="mb-4 text-sm" style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-body)' }}>
            Fetches a few chunks of a model over your connection to check the download path.
            Nothing is saved to your device.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="selftest-model" className="sr-only">
              Model to test
            </label>
            <select
              id="selftest-model"
              value={selfTestModelId}
              onChange={(e) => setSelfTestModelId(e.target.value)}
              disabled={selfTestRunning || testableModels.length === 0}
              className="rounded-lg px-3 py-2 text-sm"
              style={{
                border: '1px solid var(--eco-border-muted)',
                background: 'var(--eco-surface)',
                color: 'var(--eco-text)',
                fontFamily: 'var(--eco-font-body)',
              }}
            >
              {testableModels.length === 0 ? (
                <option value="">No downloadable models</option>
              ) : (
                testableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.friendlyName} · {m.sizeGB} GB
                  </option>
                ))
              )}
            </select>
            <Button onClick={runSelfTest} variant="primary" disabled={selfTestRunning || !selfTestModelId}>
              {selfTestRunning ? 'Testing…' : 'Test download'}
            </Button>
          </div>

          {selfTestError && (
            <p
              className="mt-4 rounded-lg px-3 py-2 text-sm"
              style={{
                background: 'var(--eco-error-soft, rgba(199, 92, 74, 0.12))',
                color: 'var(--eco-error, #c75c4a)',
                fontFamily: 'var(--eco-font-body)',
              }}
            >
              {selfTestError}
            </p>
          )}

          {selfTestResult && (
            <div className="mt-4">
              {/* Verdict banner — the plain-language answer */}
              <div
                className="mb-3 flex items-baseline gap-2 rounded-lg px-4 py-3"
                style={{ background: VERDICT_STYLE[selfTestResult.verdict.kind].bg }}
              >
                <span
                  className="text-sm font-medium"
                  style={{ color: VERDICT_STYLE[selfTestResult.verdict.kind].fg, fontFamily: 'var(--eco-font-body)' }}
                >
                  {VERDICT_STYLE[selfTestResult.verdict.kind].label}
                </span>
                <span className="text-sm" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}>
                  {selfTestResult.verdict.message}
                </span>
              </div>

              <p className="mb-2 text-xs" style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)' }}>
                {selfTestFileName}
                {selfTestResult.totalBytes != null ? ` · ${formatBytes(selfTestResult.totalBytes)} total` : ''}
                {` · ${formatBytes(selfTestResult.chunkBytes)}/chunk`}
              </p>

              <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--eco-border-muted)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--eco-surface)' }}>
                      {['#', 'Range', 'Status', 'Bytes', 'Time', 'Error'].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left font-medium"
                          style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)', fontSize: '0.75rem' }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selfTestResult.chunks.map((c, i) => (
                      <tr
                        key={c.chunkIndex}
                        style={{ borderTop: i > 0 ? '1px solid var(--eco-border-muted)' : undefined }}
                      >
                        <td className="px-3 py-2" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}>
                          {c.chunkIndex}
                        </td>
                        <td className="px-3 py-2" style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}>
                          {c.range}
                        </td>
                        <td className="px-3 py-2" style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}>
                          {c.status ?? '—'}
                        </td>
                        <td className="px-3 py-2" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}>
                          {formatBytes(c.bytesRead)}
                        </td>
                        <td className="px-3 py-2" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}>
                          {c.ms} ms
                        </td>
                        <td
                          className="max-w-[220px] truncate px-3 py-2"
                          style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.7rem' }}
                          title={c.error}
                        >
                          {c.error ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* Diagnostics table */}
        <section className="mb-8" aria-label="Recent diagnostics">
          <h2
            className="mb-3 text-sm font-medium uppercase tracking-wide"
            style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
          >
            Recent Diagnostics ({entries.length})
          </h2>
          {entries.length === 0 ? (
            <p
              className="rounded-xl p-6 text-center text-sm"
              style={{
                color: 'var(--eco-text-muted)',
                border: '1px dashed var(--eco-border-muted)',
              }}
            >
              No diagnostics recorded yet. Run a smoke test or visit a page that
              triggers smoke verification.
            </p>
          ) : (
            <div
              className="overflow-x-auto rounded-xl"
              style={{ border: '1px solid var(--eco-border-muted)' }}
            >
              <table className="w-full text-sm font-body">
                <thead>
                  <tr style={{ background: 'var(--eco-surface-elevated)' }}>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      Model
                    </th>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      Outcome
                    </th>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      Load
                    </th>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      First Token
                    </th>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      Total
                    </th>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      Error
                    </th>
                    <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--eco-text-secondary)' }}>
                      Recorded
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...entries].reverse().map((entry, i) => (
                    <tr
                      key={`${entry.modelId}-${entry.recordedAt}-${i}`}
                      style={{
                        borderTop: i > 0 ? '1px solid var(--eco-border-muted)' : undefined,
                      }}
                    >
                      <td className="px-4 py-2.5" style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>
                        {entry.modelId}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                          style={{
                            background: entry.outcome === 'smoke-pass'
                              ? 'var(--eco-success-soft, rgba(45, 90, 61, 0.1))'
                              : 'var(--eco-error-soft, rgba(180, 60, 60, 0.1))',
                            color: entry.outcome === 'smoke-pass'
                              ? 'var(--eco-success, #2d5a3d)'
                              : 'var(--eco-error, #b43c3c)',
                          }}
                        >
                          {entry.outcome === 'smoke-pass' ? 'pass' : 'fail'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>
                        {entry.durations.loadMs !== null ? `${Math.round(entry.durations.loadMs)} ms` : '--'}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>
                        {entry.durations.firstTokenMs !== null ? `${Math.round(entry.durations.firstTokenMs)} ms` : '--'}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.8rem' }}>
                        {Math.round(entry.durations.totalMs)} ms
                      </td>
                      <td
                        className="max-w-[200px] truncate px-4 py-2.5"
                        style={{ color: 'var(--eco-text-muted)', fontFamily: 'var(--eco-font-mono)', fontSize: '0.75rem' }}
                        title={entry.error?.message}
                      >
                        {entry.error?.message ?? '--'}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--eco-text-muted)', fontSize: '0.75rem' }}>
                        {formatTime(entry.recordedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Smoke run panel */}
        {smokeLogs.length > 0 && (
          <section className="mb-8" aria-label="Smoke run log">
            <h2
              className="mb-3 text-sm font-medium uppercase tracking-wide"
              style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
            >
              Smoke Run Log
            </h2>
            <div className="space-y-3">
              {smokeLogs.map((entry) => (
                <div
                  key={entry.modelId}
                  className="rounded-xl p-4"
                  style={{
                    border: '1px solid var(--eco-border-muted)',
                    background: 'var(--eco-surface-elevated)',
                  }}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="text-sm font-medium"
                      style={{ color: 'var(--eco-text)', fontFamily: 'var(--eco-font-mono)' }}
                    >
                      {entry.modelId}
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{
                        background: entry.status === 'running'
                          ? 'var(--eco-primary-soft)'
                          : entry.status === 'done'
                          ? 'var(--eco-surface)'
                          : 'var(--eco-surface)',
                        color: entry.status === 'running'
                          ? 'var(--eco-primary)'
                          : 'var(--eco-text-muted)',
                      }}
                    >
                      {entry.status}
                    </span>
                  </div>
                  {entry.log.length > 0 && (
                    <pre
                      ref={logRef}
                      className="max-h-48 overflow-auto rounded-lg p-3 text-xs leading-relaxed"
                      style={{
                        background: 'var(--eco-surface)',
                        color: 'var(--eco-text-secondary)',
                        fontFamily: 'var(--eco-font-mono)',
                        border: '1px solid var(--eco-border-muted)',
                      }}
                    >
                      {entry.log.join('\n')}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Sustained memory probe */}
        <SustainedProbePanel />

        {/* Eval harness panel */}
        <EvalHarnessPanel />
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
