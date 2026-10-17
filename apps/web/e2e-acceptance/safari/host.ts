// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The Mac-side safety rules a Safari run keeps.
 *
 * - Never touch a Safari someone is using. If Safari is already running when
 *   the run starts it stops before doing anything (exit 3): those windows may
 *   be a person's own browsing. It also could not proceed — safaridriver has
 *   to launch Safari itself; a Safari opened by hand rejects the session.
 * - Quit what it started, and CHECK that it quit. A quit request can fail
 *   silently (a Settings sheet open, say), so the quit is judged by the
 *   process being gone, never by the request having been sent.
 * - Keep a floor under the disk. A Safari session with a model in it can
 *   swap heavily; below 12 GB free the run waits for space, and below 8 GB it
 *   stops.
 */

import { execFileSync } from "node:child_process";

/** Exit status of a run that found Safari already running and touched nothing. */
export const SAFARI_ALREADY_RUNNING_EXIT = 3;

export const DISK_WAIT_GB = 12;
export const DISK_FLOOR_GB = 8;
const DISK_WAIT_MS = 5 * 60_000;
const DISK_POLL_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Is any Safari process running? `pgrep` exits 1 when nothing matches. */
export function safariRunning(): boolean {
  try {
    return execFileSync("pgrep", ["-x", "Safari"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

/** Free space on the data volume, in whole GB. */
export function freeDiskGb(): number {
  const output = execFileSync("df", ["-g", "/System/Volumes/Data"], { encoding: "utf8" });
  const fields = output.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
  const available = Number(fields[3]);
  if (!Number.isFinite(available)) throw new Error(`could not read free disk space from df: ${output}`);
  return available;
}

/**
 * Hold the run until the disk has room. Below the floor it stops at once;
 * between the floor and the wait line it waits up to five minutes for space
 * to come back, then carries on only if it is above the floor.
 */
export async function guardDisk(where: string, log: (line: string) => void): Promise<void> {
  let free = freeDiskGb();
  if (free < DISK_FLOOR_GB) {
    throw new Error(`disk: ${free} GB free at ${where}, below the ${DISK_FLOOR_GB} GB floor — stopping.`);
  }
  if (free >= DISK_WAIT_GB) return;
  log(`disk: ${free} GB free at ${where}, under ${DISK_WAIT_GB} GB — waiting up to 5 min for space`);
  const deadline = Date.now() + DISK_WAIT_MS;
  while (free < DISK_WAIT_GB && Date.now() < deadline) {
    await sleep(DISK_POLL_MS);
    free = freeDiskGb();
  }
  if (free < DISK_FLOOR_GB) {
    throw new Error(`disk: ${free} GB free at ${where}, below the ${DISK_FLOOR_GB} GB floor — stopping.`);
  }
  log(`disk: ${free} GB free at ${where}, carrying on`);
}

/**
 * Make sure Safari has quit, and say whether it has.
 *
 * Ending the WebDriver session usually quits the Safari it launched. If it is
 * still running twenty seconds later, ask it to quit (`quit app`, never a
 * window-closing script — that would also close any windows Safari restores),
 * then judge by the process alone.
 */
export async function quitSafari(): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (!safariRunning()) return true;
    await sleep(1_000);
  }
  try {
    execFileSync("osascript", ["-e", 'quit app "Safari"'], { stdio: "ignore", timeout: 30_000 });
  } catch {
    // The process check below decides; a failed request is common and silent.
  }
  for (let i = 0; i < 30; i++) {
    if (!safariRunning()) return true;
    await sleep(1_000);
  }
  return false;
}
