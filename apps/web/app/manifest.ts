// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/?source=pwa',
    name: 'Eco -- Browser-local AI',
    short_name: 'Eco',
    description:
      'Browser-local AI for Eco web v1.0, with Eco Network capabilities clearly framed as preparing for later.',
    start_url: '/?source=pwa',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui', 'browser'],
    orientation: 'portrait-primary',
    background_color: '#f5f0e8',
    theme_color: '#2d5a3d',
    scope: '/',
    lang: 'en',
    dir: 'ltr',
    categories: ['productivity', 'utilities'],
    icons: [
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
