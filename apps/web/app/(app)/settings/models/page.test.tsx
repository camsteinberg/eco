// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

import ModelsPage from './page';

describe('/settings/models', () => {
  it('redirects to the canonical Models settings tab', async () => {
    await ModelsPage({});

    expect(redirectMock).toHaveBeenCalledWith('/settings?tab=models');
  });

  it('preserves validation harness profile overrides while canonicalizing the tab', async () => {
    await ModelsPage({
      searchParams: Promise.resolve({
        tab: 'account',
        'eco-force-capability': 'webgpu',
        'eco-force-browser': 'chromium',
        'eco-force-device-memory': '24',
      }),
    });

    expect(redirectMock).toHaveBeenCalledWith(
      '/settings?tab=models&eco-force-capability=webgpu&eco-force-browser=chromium&eco-force-device-memory=24',
    );
  });
});
