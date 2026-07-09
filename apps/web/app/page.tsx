// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata } from "next";
import { redirect } from "next/navigation";

type SearchParamValue = string | string[] | undefined;

export const metadata: Metadata = {
  title: "Eco — Private AI that starts in your browser",
  description:
    "Start a private, local-first chat in your browser. Begin as a guest, keep your first prompt on this device, and move into an account only when you want continuity.",
};

function buildChatRedirectHref(
  searchParams: Record<string, SearchParamValue>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "preview") {
      continue;
    }

    if (typeof value === "string") {
      params.set(key, value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        params.append(key, entry);
      }
    }
  }

  const query = params.toString();
  return query ? `/chat?${query}` : "/chat";
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, SearchParamValue>>;
}) {
  redirect(buildChatRedirectHref(await searchParams));
}
