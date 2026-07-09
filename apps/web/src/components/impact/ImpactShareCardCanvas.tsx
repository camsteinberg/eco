// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { VineBorder } from "@eco/ui";
import { copyTextWithFallback } from "../../lib/clipboard";
import { formatImpactCo2, formatImpactEnergy, formatImpactWater } from "../../lib/impact-format";
import { shareImage } from "../../lib/web-share";
import type { ImpactResult } from "../../lib/impact-calc";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { logger } from "../../lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variant = "9:16" | "2:1";

type ImpactShareCardCanvasProps = {
  impact: ImpactResult;
  daysActive?: number;
  networkContribution?: ImpactResult;
  title?: string;
  footerText?: string;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

const DIMENSIONS: Record<Variant, { width: number; height: number }> = {
  "9:16": { width: 540, height: 960 },
  "2:1": { width: 600, height: 300 },
};

// Grain texture SVG data URL shared across impact share surfaces
const GRAIN_TEXTURE = `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImpactShareCardCanvas({
  impact,
  daysActive,
  networkContribution,
  title = "My impact with Eco",
  footerText = "AI that runs on my device. econetwork.ai",
  onClose,
}: ImpactShareCardCanvasProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [variant, setVariant] = useState<Variant>("9:16");
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");

  const dims = DIMENSIONS[variant];

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const contributionSuffix = networkContribution
    ? ` Plus ${formatImpactWater(networkContribution.waterSavedLiters)} more from chats kept on-device.`
    : "";
  const shareText = `${formatImpactWater(impact.waterSavedLiters)} water saved, ${formatImpactCo2(impact.co2SavedGrams)} CO2 avoided running AI on my own device instead of a data center.${contributionSuffix} econetwork.ai`;
  const badgeLabel =
    typeof daysActive === "number"
      ? `${daysActive} ${daysActive === 1 ? "day" : "days"} of impact`
      : null;
  const previewScale =
    variant === "9:16"
      ? isMobile
        ? 0.38
        : 0.6
      : isMobile
        ? 0.5
        : 1;
  const previewWidth = dims.width * previewScale;
  const previewHeight = dims.height * previewScale;
  const summaryRows = [
    { label: "Water saved", value: formatImpactWater(impact.waterSavedLiters) },
    { label: "Energy saved", value: formatImpactEnergy(impact.energySavedWh) },
    { label: "CO2 avoided", value: formatImpactCo2(impact.co2SavedGrams) },
  ];

  const generateBlob = useCallback(async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    // Wait for fonts to be ready
    await document.fonts.ready;
    const { toBlob } = await import("html-to-image");
    // NOTE: The exported share card is rasterized via html-to-image, so its
    // colors MUST be literal hex (the snapshot must look identical regardless
    // of the viewer's light/dark theme — `var(--eco-*)` would resolve to the
    // active theme and produce a different PNG). These literals intentionally
    // mirror the app palette: #2d5a3d == --eco-primary (light). Keep a
    // static token->hex map here rather than codemodding to CSS variables.
    const blob = await toBlob(cardRef.current, {
      pixelRatio: 2,
      width: dims.width,
      height: dims.height,
      backgroundColor: "#2d5a3d",
    });
    return blob;
  }, [dims]);

  const handleShare = useCallback(async () => {
    setGenerating(true);
    try {
      const blob = await generateBlob();
      if (!blob) return;
      await shareImage(blob, shareText, "eco-impact.png");
    } catch (err) {
      logger.warn("Share failed:", err);
    } finally {
      setGenerating(false);
    }
  }, [generateBlob, shareText]);

  const handleDownload = useCallback(async () => {
    setGenerating(true);
    try {
      const blob = await generateBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eco-impact-${variant === "9:16" ? "story" : "banner"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      logger.warn("Download failed:", err);
    } finally {
      setGenerating(false);
    }
  }, [generateBlob, variant]);

  const handleCopyText = useCallback(async () => {
    await copyTextWithFallback(shareText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [shareText]);

  const isStory = variant === "9:16";

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-center justify-center p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Share your impact card"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />

      <div
        className="relative z-10 w-full max-w-5xl overflow-y-auto rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] shadow-[0_32px_120px_rgba(26,26,26,0.32)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--eco-border)] px-5 py-5 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--eco-text-muted)]">
              Share impact
            </p>
            <h2 className="mt-2 font-display text-2xl tracking-[-0.02em] text-[var(--eco-text)]">
              {title}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--eco-text-secondary)]">
              A snapshot of the data-center footprint your on-device chats avoided.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-[var(--eco-border)] text-[var(--eco-text-secondary)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
            aria-label="Close share card"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="grid gap-6 px-5 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-[var(--eco-border)] bg-[color-mix(in_srgb,var(--eco-surface),black_2%)] p-4 sm:min-h-[420px] sm:p-6">
            <div
              className="relative shrink-0 overflow-hidden rounded-lg shadow-[0_24px_80px_rgba(26,26,26,0.25)]"
              style={{ width: previewWidth, height: previewHeight }}
            >
              <div
                className="absolute left-0 top-0"
                style={{
                  width: dims.width,
                  height: dims.height,
                  transform: `scale(${previewScale})`,
                  transformOrigin: "top left",
                }}
              >
                <div
                  ref={cardRef}
                  className="relative overflow-hidden"
                  style={{
                    width: dims.width,
                    height: dims.height,
                    background: "linear-gradient(135deg, #2d5a3d 0%, #1a3d2a 50%, #2d5a3d 100%)",
                  }}
                >
                  <div
                    className="pointer-events-none absolute inset-0 opacity-[0.08]"
                    style={{ backgroundImage: GRAIN_TEXTURE }}
                    aria-hidden="true"
                  />

                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                    <VineBorder
                      width={dims.width - 40}
                      height={dims.height - 40}
                      className="text-white/20"
                    />
                  </div>

                  <div
                    className="relative flex h-full flex-col items-center justify-center"
                    style={{ padding: isStory ? "60px 40px" : "24px 40px" }}
                  >
                    <span
                      style={{
                        fontFamily: "Fraunces, serif",
                        fontSize: isStory ? 36 : 20,
                        fontWeight: 600,
                        color: "rgba(255, 255, 255, 0.9)",
                        letterSpacing: "-0.02em",
                        marginBottom: isStory ? 40 : 12,
                      }}
                    >
                      eco
                    </span>

                    <span
                      style={{
                        fontFamily: "Fraunces, serif",
                        fontSize: isStory ? 22 : 14,
                        color: "rgba(255, 255, 255, 0.8)",
                        textAlign: "center",
                        marginBottom: isStory ? 48 : 16,
                      }}
                    >
                      {title}
                    </span>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: isStory ? "column" : "row",
                        gap: isStory ? 28 : 24,
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: isStory ? 48 : 16,
                      }}
                    >
                      <MetricDisplay
                        icon="droplet"
                        value={formatImpactWater(impact.waterSavedLiters)}
                        label="water saved"
                        isStory={isStory}
                      />
                      <MetricDisplay
                        icon="bolt"
                        value={formatImpactEnergy(impact.energySavedWh)}
                        label="energy saved"
                        isStory={isStory}
                      />
                      <MetricDisplay
                        icon="cloud"
                        value={formatImpactCo2(impact.co2SavedGrams)}
                        label="CO2 avoided"
                        isStory={isStory}
                      />
                    </div>

                    {badgeLabel ? (
                      <span
                        style={{
                          fontFamily: "DM Sans, sans-serif",
                          fontSize: isStory ? 16 : 11,
                          color: "rgba(255, 255, 255, 0.7)",
                          backgroundColor: "rgba(255, 255, 255, 0.1)",
                          padding: isStory ? "8px 20px" : "4px 12px",
                          borderRadius: 999,
                          marginBottom: isStory ? 48 : 16,
                        }}
                      >
                        {badgeLabel}
                      </span>
                    ) : null}

                    <span
                      style={{
                        fontFamily: "DM Sans, sans-serif",
                        fontSize: isStory ? 14 : 10,
                        color: "rgba(255, 255, 255, 0.5)",
                        textAlign: "center",
                      }}
                    >
                      {footerText}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div
              className="rounded-lg border border-[var(--eco-border)] p-4"
              style={{ backgroundColor: "color-mix(in srgb, var(--eco-surface) 80%, transparent)" }}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--eco-text-muted)]">
                Format
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setVariant("9:16")}
                  className="min-h-[44px] rounded-full px-4 py-2 text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: variant === "9:16" ? "var(--eco-primary)" : "transparent",
                    color: variant === "9:16" ? "white" : "var(--eco-text-secondary)",
                    border: variant === "9:16" ? "none" : "1px solid var(--eco-border)",
                  }}
                >
                  Story (9:16)
                </button>
                <button
                  type="button"
                  onClick={() => setVariant("2:1")}
                  className="min-h-[44px] rounded-full px-4 py-2 text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: variant === "2:1" ? "var(--eco-primary)" : "transparent",
                    color: variant === "2:1" ? "white" : "var(--eco-text-secondary)",
                    border: variant === "2:1" ? "none" : "1px solid var(--eco-border)",
                  }}
                >
                  Banner (2:1)
                </button>
              </div>
            </div>

            <div
              className="rounded-lg border border-[var(--eco-border)] p-4"
              style={{ backgroundColor: "color-mix(in srgb, var(--eco-surface) 80%, transparent)" }}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--eco-text-muted)]">
                Snapshot
              </p>
              <div className="mt-3 space-y-3">
                {summaryRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-4 rounded-2xl border px-3 py-2"
                    style={{ borderColor: "color-mix(in srgb, var(--eco-border) 70%, transparent)" }}
                  >
                    <span className="text-sm text-[var(--eco-text-secondary)]">{row.label}</span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-[var(--eco-text)]">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
              {badgeLabel ? (
                <div className="mt-4 inline-flex rounded-full bg-[var(--eco-primary-soft)] px-3 py-1 text-xs font-medium text-[var(--eco-primary)]">
                  {badgeLabel}
                </div>
              ) : (
                <p className="mt-4 text-sm text-[var(--eco-text-secondary)]">
                  Personal impact from this conversation.
                </p>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              <button
                type="button"
                onClick={handleShare}
                disabled={generating}
                className="min-h-[44px] rounded-full px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
                style={{ backgroundColor: "var(--eco-primary)" }}
              >
                {generating ? "Generating..." : "Share"}
              </button>
              <button
                type="button"
                onClick={handleCopyText}
                className="min-h-[44px] rounded-full border border-[var(--eco-border)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
              >
                {copied ? "Copied!" : "Copy text"}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                disabled={generating}
                className="min-h-[44px] rounded-full border border-[var(--eco-border)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)] disabled:opacity-50"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric Display sub-component
// ---------------------------------------------------------------------------

type MetricDisplayProps = {
  icon: "droplet" | "bolt" | "cloud";
  value: string;
  label: string;
  isStory: boolean;
};

function MetricDisplay({ icon, value, label, isStory }: MetricDisplayProps) {
  const iconSize = isStory ? 32 : 20;
  const valueSize = isStory ? 28 : 16;
  const labelSize = isStory ? 13 : 9;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: isStory ? 8 : 4,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="rgba(255, 255, 255, 0.7)"
        width={iconSize}
        height={iconSize}
      >
        {icon === "droplet" && (
          <path d="M12 2.083c-.376 0-.752.12-1.072.364C8.14 4.552 4 8.834 4 13a8 8 0 1016 0c0-4.166-4.14-8.448-6.928-10.553A1.727 1.727 0 0012 2.083z" />
        )}
        {icon === "bolt" && (
          <path d="M14.615 1.595a.75.75 0 01.359.852L12.982 9.75h7.268a.75.75 0 01.548 1.262l-10.5 11.25a.75.75 0 01-1.272-.71l1.992-7.302H3.75a.75.75 0 01-.548-1.262l10.5-11.25a.75.75 0 01.913-.143z" />
        )}
        {icon === "cloud" && (
          <path
            fillRule="evenodd"
            d="M8.161 2.58a1.875 1.875 0 011.678 0l4.993 2.498c.106.052.23.052.336 0l3.869-1.935A1.875 1.875 0 0121.75 4.82v12.485a1.875 1.875 0 01-1.037 1.677l-4.875 2.437a1.875 1.875 0 01-1.676 0L9.169 18.92a.375.375 0 00-.338 0l-3.869 1.935A1.875 1.875 0 012.25 19.18V6.695c0-.723.415-1.384 1.037-1.677l4.875-2.437z"
            clipRule="evenodd"
          />
        )}
      </svg>
      <span
        style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: valueSize,
          fontWeight: 600,
          color: "white",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: "DM Sans, sans-serif",
          fontSize: labelSize,
          color: "rgba(255, 255, 255, 0.6)",
        }}
      >
        {label}
      </span>
    </div>
  );
}
