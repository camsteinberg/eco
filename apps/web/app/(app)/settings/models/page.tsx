// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { redirect } from "next/navigation";

type SearchParamValue = string | string[] | undefined;

function buildModelsRedirectHref(
  searchParams: Record<string, SearchParamValue>,
): string {
  const params = new URLSearchParams();
  params.set("tab", "models");

  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab") continue;

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

  return `/settings?${params.toString()}`;
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>;
}) {
  redirect(buildModelsRedirectHref(searchParams ? await searchParams : {}));
}
