// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { Button } from '@eco/ui';
import Link from 'next/link';
import type { ModelConfig, Slot } from '../../local-ai/types';
import type { SlotStatus } from '../../local-ai/lifecycle/slots';
import { getDisplayInfo } from '../../local-ai/display';
import { useSettingsStore } from '../../stores/settingsStore';
import type { StorageBreakdown } from '../../hooks/local-ai/useLocalAiStorageBreakdown';
import { DetailsDisclosure } from './DetailsDisclosure';
import { LocalAiStoragePanel } from './LocalAiStoragePanel';
import { SettingsSection } from '../settings/SettingsSection';
import { SETTINGS_STORAGE_SECTION_ID } from '../settings/settingsNavigation';
import { SettingsRow } from '../settings/SettingsRow';
import { SettingsSwitch } from '../settings/SettingsSwitch';
import { CustomInstructionsSection } from '../settings/CustomInstructionsSection';

/**
 * Settings → AI tab.
 *
 * Quiet sections separated by hairline + air, no nested cards. Default
 * view shows what's running, an obvious switch action, and storage.
 * Technical jargon (model id, runtime, format) sits behind a single
 * "Show technical details" disclosure for the curious / debugging.
 *
 * Pure presentational. Caller injects current model + callbacks.
 */

export type SettingsEcoTabProps = {
  /** The model running in the eco-fast slot. Null when nothing is loaded. */
  currentModel: ModelConfig | null;
  /** Status of the slot that supplied currentModel. When 'preparing', the
   *  "Currently running" card shows a quiet "Setting up on this device…" line
   *  so an interrupted download never reads as a ready model. */
  currentModelStatus?: SlotStatus;
  /** Per-model storage breakdown. Null until the first measurement lands. */
  storageBreakdown: StorageBreakdown | null;
  /** Loading state for the storageBreakdown fetch. */
  storageStatus: 'loading' | 'ready';
  /** Which model id each slot holds — groups the storage cards by slot. */
  slotModelIds: Record<Slot, string | null>;
  /** Open the SwitchAIDialog. */
  onSwitchAI(): void;
  /** Show the "What works today" / diagnostic surface. */
  onShowDiagnostic?(): void;
  /** Clear cache for one model (defaults to currentModel.id). */
  onClearCache(modelId: string): Promise<void>;
  /** Disable Eco entirely (turns off local AI for this device). */
  onSwitchOffEco?(): void;
};

export function SettingsEcoTab({
  currentModel,
  currentModelStatus,
  storageBreakdown,
  storageStatus,
  slotModelIds,
  onSwitchAI,
  onShowDiagnostic,
  onClearCache,
  onSwitchOffEco,
}: SettingsEcoTabProps) {
  // The mono provenance line ("Liquid AI · 0.8 GB") is a technical detail —
  // keep it out of the calm default view, surfacing only when the user has
  // opted into technical details (Settings → Appearance, C-08). The name in it
  // is the model's AUTHOR, not the repack org we happen to download from.
  const showTechnicalDetails = useSettingsStore((s) => s.showTechnicalDetails);
  const groundingEnabled = useSettingsStore((s) => s.groundingEnabled);
  const setGroundingEnabled = useSettingsStore((s) => s.setGroundingEnabled);

  if (!currentModel) {
    return (
      <div aria-label="Eco settings — no model loaded">
        <SettingsSection
          title="Your AI"
          description="Eco isn't set up on this device yet."
          hairline={false}
        >
          <Button onClick={onSwitchAI} variant="primary">
            Set up Eco
          </Button>
        </SettingsSection>

        <CustomInstructionsSection />
      </div>
    );
  }

  return (
    <div aria-label="Eco settings">
      <SettingsSection
        title="Your AI"
        description="Eco picks the AI that runs best on your device. Conversations stay private to you."
        hairline={false}
      >
        <Button
          onClick={onSwitchAI}
          variant="primary"
          aria-label="Open Switch your AI dialog"
          className="whitespace-nowrap"
        >
          Switch your AI
        </Button>
      </SettingsSection>

      <SettingsSection title="Currently running">
        <CurrentModelCard
          model={currentModel}
          showProvenance={showTechnicalDetails}
          status={currentModelStatus}
        />
        <ModelLicensesLink />
      </SettingsSection>

      <CustomInstructionsSection />

      <SettingsSection
        title="Private by design"
        description="Eco runs the AI entirely in your browser — your prompts and replies are never sent to Eco's servers. For a chat, the only things that leave your device are the one-time model download and, when web lookups are on (below), the search terms from your question — which go straight to the source, never to us. Signing in uses a normal account session, kept separate from your chats. Read the full story on the privacy and transparency pages."
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium text-[var(--eco-primary)]">
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="shrink-0"
          >
            {/* Single leaf — the on-device promise, in the leaf motif. */}
            <path d="M3.5 12.5C3.5 12.5 2.5 7.5 6 4.5C9.5 1.5 13 2 13 2C13 2 13.5 7 10 10C6.5 13 3.5 12.5 3.5 12.5Z" />
            <path d="M5 11C5 11 7.5 7 11 4.5" stroke="var(--eco-surface)" strokeWidth="0.75" fill="none" strokeLinecap="round" />
          </svg>
          On-device · Active
        </span>
      </SettingsSection>

      <SettingsSection title="Web lookups">
        <SettingsRow
          label="Look up facts from the web"
          description="When on, Eco can check trusted sources like Wikipedia for facts so it answers from real information instead of guessing. Your device fetches the search terms directly — Eco's servers never see your questions. Turn this off to keep every request fully on your device."
          divider={false}
          control={
            <SettingsSwitch
              checked={groundingEnabled}
              onChange={setGroundingEnabled}
              ariaLabel="Toggle web fact lookups"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Storage on this device" id={SETTINGS_STORAGE_SECTION_ID}>
        <LocalAiStoragePanel
          status={storageStatus}
          breakdown={storageBreakdown}
          slotModelIds={slotModelIds}
          onClearModel={onClearCache}
        />
      </SettingsSection>

      <SettingsSection title="Technical details">
        <DetailsDisclosure label="Show technical details">
          <div className="mt-4 space-y-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3 text-sm">
              <dt className="text-[var(--eco-text-secondary)]">Model ID</dt>
              <dd className="text-[var(--eco-text)]">{currentModel.id}</dd>
              <dt className="text-[var(--eco-text-secondary)]">Runtime</dt>
              <dd className="text-[var(--eco-text)]">{describeRuntime(currentModel)}</dd>
              <dt className="text-[var(--eco-text-secondary)]">Context window</dt>
              <dd className="text-[var(--eco-text)]">
                {currentModel.capabilities.contextTokens} tokens
              </dd>
              <dt className="text-[var(--eco-text-secondary)]">Format</dt>
              <dd className="text-[var(--eco-text)]">{currentModel.format}</dd>
              <dt className="text-[var(--eco-text-secondary)]">Quality rating</dt>
              <dd className="text-[var(--eco-text)]">{currentModel.evidenceTier}</dd>
              <dt className="text-[var(--eco-text-secondary)]">Known limitation</dt>
              <dd className="text-[var(--eco-text)]">{currentModel.knownLimitation}</dd>
            </dl>
            {onSwitchOffEco && (
              <button
                type="button"
                onClick={onSwitchOffEco}
                className="text-sm text-[var(--eco-text-secondary)] underline hover:text-[var(--eco-text)]"
              >
                Switch off Eco ›
              </button>
            )}
          </div>
        </DetailsDisclosure>
      </SettingsSection>

      {onShowDiagnostic && (
        <div className="mt-12 flex justify-end border-t border-[var(--eco-border-muted)] pt-6">
          <button
            type="button"
            onClick={onShowDiagnostic}
            className="text-xs text-[var(--eco-text-muted)] underline hover:text-[var(--eco-text-secondary)]"
          >
            Diagnostic info
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The models are third-party works under their own licenses, and two of the
 * ones Eco can download are not open-source licensed. A person who wants to
 * know that should be able to find it from the place the model is named.
 */
function ModelLicensesLink() {
  return (
    <Link
      href="/licenses"
      className="mt-3 inline-block text-sm text-[var(--eco-text-secondary)] underline hover:text-[var(--eco-text)]"
    >
      Model licenses ›
    </Link>
  );
}

function CurrentModelCard({
  model,
  showProvenance,
  status,
}: {
  model: ModelConfig;
  showProvenance: boolean;
  status?: SlotStatus;
}) {
  const display = getDisplayInfo(model.id, model);
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-medium"
        style={{ fontFamily: 'var(--eco-font-display)', fontSize: '1.05rem', color: 'var(--eco-text)' }}
      >
        {display.friendlyName}
      </span>
      {status === 'preparing' && (
        <span className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
          Setting up on this device…
        </span>
      )}
      {display.qualityPhrase && (
        <span className="text-sm" style={{ fontFamily: 'var(--eco-font-body)', color: 'var(--eco-text-secondary)' }}>
          {display.qualityPhrase}
        </span>
      )}
      {showProvenance && (
        <span
          className="text-xs"
          style={{ fontFamily: 'var(--eco-font-mono)', color: 'var(--eco-text-muted)' }}
        >
          {display.provenance}
        </span>
      )}
    </div>
  );
}

function describeRuntime(model: ModelConfig): string {
  if (model.runtime === 'litert') return 'LiteRT-LM + WebGPU';
  return 'Transformers.js v4';
}
