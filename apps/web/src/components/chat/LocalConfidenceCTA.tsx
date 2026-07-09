// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type LocalConfidenceCTAProps = {
  confidence: number | null;
  promptContent?: string;
  responseContent?: string;
  onReask: () => void;
};

export function LocalConfidenceCTA(props: LocalConfidenceCTAProps) {
  void props;
  return null;
}
