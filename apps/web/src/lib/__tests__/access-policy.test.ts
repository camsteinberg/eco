// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  canGuestAccessAppRoute,
  classifyLaunchRoute,
  getGuestAccessDecision,
  isGuestAllowedSettingsTab,
  isGuestLockedSettingsTab,
  sanitizeLaunchSafeRelativeUrl,
  shouldRenderGuestLockedPreview,
} from '../access-policy';

describe('access policy', () => {
  it('allows guests to manage local models', () => {
    expect(isGuestAllowedSettingsTab('models')).toBe(true);
    expect(isGuestLockedSettingsTab('models')).toBe(false);
    expect(shouldRenderGuestLockedPreview('/settings', 'models')).toBe(false);
  });

  it('keeps chat, new chat, settings, and model settings guest-accessible', () => {
    expect(canGuestAccessAppRoute('/chat')).toBe(true);
    expect(canGuestAccessAppRoute('/chat/new')).toBe(true);
    expect(canGuestAccessAppRoute('/settings')).toBe(true);
    expect(canGuestAccessAppRoute('/settings', 'models')).toBe(true);
  });

  it('centralizes route access and guest-preview decisions in one helper', () => {
    expect(getGuestAccessDecision('/settings', 'models')).toMatchObject({
      routeClass: 'member-only-preview',
      canAccessAsGuest: true,
      renderLockedPreview: false,
    });
    expect(getGuestAccessDecision('/settings', 'billing')).toMatchObject({
      routeClass: 'member-only-preview',
      canAccessAsGuest: true,
      renderLockedPreview: true,
    });
    expect(getGuestAccessDecision('/dashboard/growth')).toMatchObject({
      routeClass: 'unknown',
      canAccessAsGuest: false,
      renderLockedPreview: false,
      authRedirectTarget: '/sign-in',
    });
  });

  it('keeps retired admin/dashboard and the extracted network/governance surfaces inaccessible to guests', () => {
    // The admin dashboard was removed in Wave D S3a and the referral dashboard in
    // Wave D S3b, so neither /admin nor /dashboard needs a dedicated route class —
    // both fall through to "unknown" but stay blocked. The /network and /governance
    // surfaces moved to the eco-desktop product (no longer v1.0 web), so they are
    // retired — not guest-accessible and never rendered as a locked preview.
    expect(canGuestAccessAppRoute('/admin')).toBe(false);
    expect(canGuestAccessAppRoute('/admin/growth')).toBe(false);
    expect(canGuestAccessAppRoute('/dashboard')).toBe(false);
    expect(classifyLaunchRoute('/dashboard')).toBe('unknown');
    expect(canGuestAccessAppRoute('/network')).toBe(false);
    expect(canGuestAccessAppRoute('/governance')).toBe(false);
    expect(classifyLaunchRoute('/network')).toBe('retired');
    expect(classifyLaunchRoute('/governance')).toBe('retired');
    expect(shouldRenderGuestLockedPreview('/governance')).toBe(false);
  });

  it.each([
    ['/chat', 'guest-safe-app'],
    ['/settings?tab=models', 'member-only-preview'],
    ['/network', 'retired'],
    ['/governance', 'retired'],
    ['/dashboard', 'unknown'],
    ['/privacy', 'launch-public'],
    ['/download', 'retired'],
    ['/admin', 'unknown'],
    ['/api/gate', 'internal'],
    ['/_next/static/chunk.js', 'internal'],
    ['/favicon.ico', 'static-asset'],
    ['/unclassified', 'unknown'],
  ] as const)('classifies %s as %s', (path, routeClass) => {
    expect(classifyLaunchRoute(new URL(path, 'https://eco.local').pathname)).toBe(routeClass);
  });

  it('accepts only launch-safe callback and return route classes', () => {
    expect(sanitizeLaunchSafeRelativeUrl('/chat?prompt=Hello', '/chat')).toBe('/chat?prompt=Hello');
    expect(sanitizeLaunchSafeRelativeUrl('/settings?tab=billing', '/chat')).toBe('/settings?tab=billing');
    expect(sanitizeLaunchSafeRelativeUrl('/sign-up?callbackUrl=%2Fchat', '/chat')).toBe('/sign-up?callbackUrl=%2Fchat');

    for (const unsafeTarget of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/api/admin/economy',
      '/admin',
      '/dashboard',
      '/validation/authenticated-ready',
      '/_next/static/chunk.js',
      '/favicon.ico',
      '/download',
      '/founding-miners',
      '/developers',
      '/try',
      '/network',
      '/governance',
      '/unknown',
    ]) {
      expect(sanitizeLaunchSafeRelativeUrl(unsafeTarget, '/chat')).toBe('/chat');
    }
  });
});
