// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useEffect, useState } from 'react';
import { shouldForceValidationRuntimeCrash } from '../../lib/validation-harness';

export function ValidationHarnessCrashSentinel(): null {
  const [shouldCrash, setShouldCrash] = useState(false);

  useEffect(() => {
    if (shouldForceValidationRuntimeCrash()) {
      setShouldCrash(true);
    }
  }, []);

  if (shouldCrash) {
    throw new Error('Validation harness forced a local runtime crash.');
  }

  return null;
}
