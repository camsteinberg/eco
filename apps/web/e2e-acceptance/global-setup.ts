// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Clear the previous run's report before this one starts.
 *
 * The report is assembled from per-walk fragments on disk (see `lib/report`),
 * which is what makes it survive Playwright recycling a worker after a failed
 * test. The cost of that durability is that yesterday's fragments would be
 * indistinguishable from today's, so the run begins by removing them.
 */

import { resetReportArtefacts } from "./lib/report";

export default function globalSetup(): void {
  resetReportArtefacts();
}
