// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { RetiredRoutePage } from "../../src/components/public/RetiredRoutePage";

export const metadata = {
  title: "Contributor program coming later | Eco",
  description:
    "The contributor program is not part of the current web-first launch. It will return later with a clearer, more honest surface.",
};

export default function ContributorsPage() {
  return (
    <RetiredRoutePage
      eyebrow="Contributors"
      title="Contributor program is coming later"
      description="Eco is launching as a chat-first web product. Contributor recruitment and recognition return after the public product is stable enough to support them without competing for attention."
      bullets={[
        "The current launch keeps the public story focused on local-first chat, trust, and truthful return paths.",
        "Contributor programs will return when the network-facing surfaces are ready to stand on their own.",
        "Until then, impact and transparency pages explain the values guiding the launch product.",
      ]}
      note="We are intentionally not promising launch-era compensation, network-control perks, or contributor funnels until those programs are ready."
      primaryAction={{
        href: "/",
        label: "Start chatting in your browser",
      }}
      secondaryAction={{
        href: "/impact",
        label: "Read the impact story",
      }}
    />
  );
}
