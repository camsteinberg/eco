// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect } from "react";
import { useSession } from "../../lib/auth";

export function RetiredRouteAuthGate() {
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (!isPending && session) {
      window.location.replace("/chat");
    }
  }, [isPending, session]);

  return null;
}
