// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "../../lib/sw-register";

export function SwRegistration() {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return null;
}
