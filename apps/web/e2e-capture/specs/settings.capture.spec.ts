// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { entryRunsInContext } from "../capture";
import { captureTest } from "../fixtures";
import { manifestFor } from "../manifest";

/**
 * Every wave's spec file is this loop with a different group name. All the
 * behavior lives in the manifest entry and in `capture.ts`; if a spec file ever
 * needs more than this, the mechanism belongs in the runner instead.
 */
for (const entry of manifestFor("settings")) {
  captureTest(entry.id, async ({ capture, captureContext }) => {
    captureTest.skip(
      !entryRunsInContext(entry, captureContext),
      `${entry.tier} state does not run in ${captureContext.project}`,
    );
    await capture(entry);
  });
}
