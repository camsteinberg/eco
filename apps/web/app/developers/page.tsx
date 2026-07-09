// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata } from "next";
import { RetiredRoutePage } from "../../src/components/public/RetiredRoutePage";

export const metadata: Metadata = {
  title: "Developer surfaces coming later | Eco",
  description:
    "Eco is focused on the chat-first web launch for now. Developer docs and launch-facing integration pages return later.",
};

export default function DevelopersPage() {
  return (
    <RetiredRoutePage
      eyebrow="Developers"
      title="Developer surfaces are coming later"
      description="The public launch is centered on the browser chat product. SDK packaging, developer docs, and integration surfaces return after the web-first experience is fully settled."
      bullets={[
        "Right now, Eco's public promise is local-first chat in the browser — not a separate developer funnel.",
        "The source stays open while we simplify the launch product and remove stale public residue.",
        "When developer surfaces return, they should match the same clarity and trust bar as the core product.",
      ]}
      note="If you need technical context today, the open repository is the honest source of truth."
      primaryAction={{
        href: "/",
        label: "Start chatting in your browser",
      }}
      secondaryAction={{
        href: "https://github.com/camsteinberg/eco",
        label: "View the source on GitHub",
        external: true,
      }}
    />
  );
}
