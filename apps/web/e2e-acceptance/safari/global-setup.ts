// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Before a Safari run touches anything: check the run's settings, refuse to
 * start beside a Safari someone else opened, and clear this target's previous
 * report (never the Chrome lane's — see `../lib/report`'s named artefacts).
 */

import { reportArtefacts, resetReportArtefacts } from "../lib/report";
import { SAFARI_ALREADY_RUNNING_EXIT, safariRunning } from "./host";
import { clearIdentity } from "./identity";
import { artefactName, safariLaneConfig } from "./target";

export default function globalSetup(): void {
  const config = safariLaneConfig();
  if (config.target === "mac" && safariRunning()) {
    console.error(
      "Safari is already running — it may be someone's own browsing, and safaridriver has to launch "
        + "Safari itself. Quit it by hand and rerun. Nothing was touched.",
    );
    process.exit(SAFARI_ALREADY_RUNNING_EXIT);
  }
  const artefacts = reportArtefacts(artefactName(config.target));
  resetReportArtefacts(artefacts);
  clearIdentity(artefacts);
}
