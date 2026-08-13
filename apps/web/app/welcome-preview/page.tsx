// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
// TEMPORARY design-preview route for the first-run WelcomeCard. DELETE before commit.

'use client';

import { WelcomeCard, type WelcomeModelChoice } from '../../src/components/local-ai/WelcomeCard';

const CHOICES: readonly WelcomeModelChoice[] = [
  {
    id: 'candidate/lfm2.5-1.2b-instruct-onnx',
    name: 'Eco Fast',
    sizeLabel: '~0.8 GB',
    tagline: 'Smaller and faster. Good for everyday questions.',
    speed: 4,
    depth: 2,
  },
  {
    id: 'candidate/lfm2-2.6b-onnx',
    name: 'Eco Deeper',
    sizeLabel: '~1.7 GB',
    tagline: 'Bigger and slower. Better at reasoning, math, and detail.',
    speed: 2,
    depth: 4,
  },
];

export default function WelcomePreviewPage() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--eco-surface-chat)' }}>
      <WelcomeCard
        choices={CHOICES}
        recommendedId="candidate/lfm2-2.6b-onnx"
        onChoose={(id) => {
          // eslint-disable-next-line no-console
          console.log('chose', id);
        }}
      />
    </div>
  );
}
