// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import manifest from '../../app/manifest';

describe('PWA manifest', () => {
  const m = manifest();

  it('has correct app name and short_name', () => {
    expect(m.name).toBe('Eco -- Private AI on your device');
    expect(m.short_name).toBe('Eco');
  });

  it('uses standalone display mode', () => {
    expect(m.display).toBe('standalone');
  });

  it('has brand theme and background colors', () => {
    expect(m.theme_color).toBe('#2d5a3d');
    expect(m.background_color).toBe('#f5f0e8');
  });

  it('has start_url and scope rooted at /', () => {
    // start_url uses a ?source=pwa query for PWA install analytics.
    expect(m.start_url).toMatch(/^\/(\?|$)/);
    expect(m.scope).toBe('/');
  });

  it('declares id, display_override, orientation, lang, dir for modern PWA validators', () => {
    expect(m.id).toBeDefined();
    expect(m.display_override).toEqual(expect.arrayContaining(['standalone']));
    expect(m.orientation).toBe('portrait-primary');
    expect(m.lang).toBe('en');
    expect(m.dir).toBe('ltr');
  });

  it('icons include both `any` and `maskable` purpose for installability', () => {
    const icons = m.icons!;
    const purposes = icons.flatMap((i) => (i.purpose ?? '').split(/\s+/).filter(Boolean));
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
  });

  it('has icons array with 192x192 and 512x512 entries', () => {
    expect(m.icons).toBeDefined();
    expect(Array.isArray(m.icons)).toBe(true);
    const icons = m.icons!;
    expect(icons.length).toBeGreaterThanOrEqual(2);

    const icon192 = icons.find((i) => i.sizes === '192x192');
    const icon512 = icons.find((i) => i.sizes === '512x512');
    expect(icon192).toBeDefined();
    expect(icon512).toBeDefined();
    expect(icon192!.type).toBe('image/png');
    expect(icon512!.type).toBe('image/png');
    expect(icon192!.src).toContain('icon-192x192');
    expect(icon512!.src).toContain('icon-512x512');
  });

  it('has description and categories', () => {
    expect(m.description).toMatch(/runs on your device, in your browser/);
    expect(m.description).not.toMatch(/Eco Network/);
    expect(m.categories).toContain('productivity');
  });
});
