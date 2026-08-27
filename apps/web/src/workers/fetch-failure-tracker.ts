// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Wraps a fetch implementation so a load can tell, afterwards, whether any
 * request for a model file failed to come back.
 *
 * Why: when the browser has evicted a model's weights and the person is
 * offline, Transformers.js does not surface the fetch failure — it logs a
 * warning and later crashes on the missing data ("Cannot read properties of
 * undefined (reading 'tokenizer_class')", seen live 2026-08-27). Matching
 * that text would be guesswork; a fetch that rejected (network down, host
 * unreachable) or came back non-OK is evidence that the files are not here
 * and could not be fetched. The worker consults this after a failed init.
 *
 * A non-OK response counts too: TJS's metadata probe treats a 404 as "does
 * not exist" and carries on, and a proxy error page is not model bytes.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type FetchFailureTracker = {
  fetch: FetchLike;
  /** True once any wrapped call rejected or returned a non-2xx status. */
  readonly failed: boolean;
};

export function createFetchFailureTracker(impl: FetchLike): FetchFailureTracker {
  let failed = false;
  const wrapped: FetchLike = async (input, init) => {
    let response: Response;
    try {
      response = await impl(input, init);
    } catch (err) {
      failed = true;
      throw err;
    }
    if (!response.ok) failed = true;
    return response;
  };
  return {
    fetch: wrapped,
    get failed() {
      return failed;
    },
  };
}
