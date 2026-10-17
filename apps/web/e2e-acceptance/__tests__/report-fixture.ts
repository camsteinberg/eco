// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { PickReport } from "../lib/report";

/**
 * Two walks covering every shape a row and a table can take: each verdict, a
 * null first token and KV reason, evidence carrying a pipe and a newline, an
 * aborted walk, and provisioning notes.
 */
export const FIXTURE_PICKS: readonly PickReport[] = [
  {
    order: 0,
    startedAt: "2026-10-16T10:00:00.000Z",
    finishedAt: "2026-10-16T10:40:00.000Z",
    modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
    label: "Eco Fast",
    slot: "eco-fast",
    rows: [
      {
        task: 1,
        turn: 1,
        label: "first reply on a cold start",
        modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
        firstTokenMs: 412.6,
        kvReason: "miss/cold",
        result: "PASS",
        evidence: "chat usable in 5210 ms, no setup error surface; reply: Hello | there\nfriend",
      },
      {
        task: 2,
        turn: 10,
        label: "turn 10: What was my rent again?",
        modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
        firstTokenMs: null,
        kvReason: null,
        result: "FAIL",
        evidence: `rent figure from turn 2 lost; reply: ${"x".repeat(200)}`,
      },
      {
        task: 3,
        turn: 1,
        label: "summary of a ~4,400-character paste",
        modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
        firstTokenMs: 900,
        kvReason: "reuse",
        result: "RECORDED",
        evidence: "120 chars back from 4400 in; summary: Gardens.",
      },
      {
        task: 6,
        turn: 7,
        label: "context boundary never appeared",
        modelId: "candidate/lfm2.5-1.2b-instruct-onnx",
        firstTokenMs: null,
        kvReason: null,
        result: "EXPECTED-FAIL",
        evidence: "6 pastes of 4400 chars did not surface a divider or notice",
      },
    ],
  },
  {
    order: 1,
    startedAt: "2026-10-16T10:41:00.000Z",
    finishedAt: "2026-10-16T11:02:00.000Z",
    modelId: "candidate/lfm2-2.6b-onnx",
    label: "Eco Deeper",
    slot: "eco-smart",
    rows: [
      {
        task: 0,
        turn: 0,
        label: "the walk itself did not finish",
        modelId: "candidate/lfm2-2.6b-onnx",
        firstTokenMs: null,
        kvReason: null,
        result: "FAIL",
        evidence: "walk ended timedOut: Test timeout of 5400000ms exceeded.",
      },
    ],
    abortedAt: { task: 0, reason: "Test timeout of 5400000ms exceeded." },
    notes: ["during setup the model host refused 2 request(s) (first: 404 https://models.example/a); the app fetched those files through its own proxy"],
  },
];

/** The option sets a run passes `assembleReport`: full, smoke, a task list, and WebLLM. */
export const FIXTURE_OPTIONS = {
  full: {},
  smoke: { smoke: true, tasks: [1, 4, 8, 12] },
  oneTask: { smoke: true, tasks: [2] },
  webllm: { smoke: true, tasks: [1, 12, 13, 14], runtime: "webllm" },
} as const satisfies Record<string, { smoke?: boolean; tasks?: readonly number[]; runtime?: "onnx" | "webllm" }>;
