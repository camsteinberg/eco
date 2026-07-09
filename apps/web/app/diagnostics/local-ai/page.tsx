// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata } from 'next';
import { DiagnosticsClient } from './DiagnosticsClient';

export const metadata: Metadata = {
  title: 'Local AI Diagnostics | Eco',
  robots: { index: false, follow: false },
};

export default function DiagnosticsPage() {
  return <DiagnosticsClient />;
}
