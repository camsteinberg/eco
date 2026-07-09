// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Result of executing code in the sandbox.
 */
export type SandboxResult = {
  output: string
  error?: string
}

/**
 * Return a disabled result for local code execution.
 *
 * Eco web v1.0 does not have a reviewed, network-isolated code execution
 * sandbox. Keep this legacy helper as a safe compatibility boundary so stale
 * imports cannot create browser execution primitives from launch chat/tool
 * surfaces.
 *
 * @param code - The source code to execute
 * @param language - Programming language requested by the model/user
 * @param timeout - Ignored compatibility parameter
 */
export async function executeInSandbox(
  code: string,
  language: string,
  timeout = 5000
): Promise<SandboxResult> {
  void code
  void timeout

  const lang = language.toLowerCase()
  if (lang !== 'javascript' && lang !== 'js') {
    return { output: '', error: `${language} execution not supported locally` }
  }

  return {
    output: '',
    error:
      'Local code execution is disabled until Eco can run it in a reviewed, network-isolated sandbox.',
  }
}
