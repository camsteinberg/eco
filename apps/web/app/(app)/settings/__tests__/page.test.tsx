// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../../../src/components/settings/SettingsTabs', () => ({
  SettingsTabs: () => <div data-testid="settings-tabs">Settings tabs</div>,
}))

vi.mock('../../../../src/stores/conversationStore', () => ({
  useConversationStore: (selector: (state: { activeConversationId: null; conversations: [] }) => unknown) =>
    selector({ activeConversationId: null, conversations: [] }),
}))

vi.mock('../../../../src/stores/chatStore', () => ({
  useChatStore: (selector: (state: { composerDraft: string }) => unknown) =>
    selector({ composerDraft: '' }),
}))

import SettingsPage from '../page'

describe('SettingsPage', () => {
  it('keeps the chat return control at a 44px touch target', () => {
    render(<SettingsPage />)

    const link = screen.getByRole('link', { name: /back to chat/i })
    expect(link).toHaveClass('h-11', 'w-11', 'shrink-0')
  })
})
