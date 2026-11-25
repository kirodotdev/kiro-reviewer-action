// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContextResponseRequest, GetReviewResponse } from './client/types.js';
import { answerRequests } from './collect/contextAnswers.js';
import type { DiffFileInfo } from './collect/diffInfo.js';
import { decodeRepoText, readRepoFile } from './collect/git.js';
import { ToolError } from './errors.js';
import { checkContextResponseLimits, LIMITS, utf8Bytes } from './limits.js';
import { redactText } from './redact.js';
import { checkRequestPath } from './safety.js';

export interface ContextFile {
  path: string;
  content: string;
}

/**
 * Post-change contents of the changed files, sent as upfront context. Added files are skipped, since the diff already
 * carries them whole, and so are deleted, binary, secret-like, non-text and oversized files. Files are taken in diff order until the file count or `maxBytes` is reached.
 */
export async function changedFileContext(
  top: string,
  headSha: string,
  files: readonly DiffFileInfo[],
  maxBytes: number,
): Promise<ContextFile[]> {
  const out: ContextFile[] = [];
  let total = 0;
  for (const f of files) {
    if (out.length >= LIMITS.contextFiles) break;
    if (f.status === 'added' || f.status === 'deleted' || f.status === 'binary') continue;
    const check = checkRequestPath(top, f.path);
    if (!check.ok) continue;
    let buf: Buffer | null;
    try {
      buf = await readRepoFile(top, headSha, check.posix, false);
    } catch (e) {
      // Upfront context is best-effort: a file that is too large or unreadable is skipped, not fatal.
      if (e instanceof ToolError) continue;
      throw e;
    }
    if (buf === null) continue;
    const text = decodeRepoText(buf);
    if (text === null) continue;
    const content = redactText(text, check.posix).text;
    const bytes = utf8Bytes(content);
    if (bytes > LIMITS.contextFileBytes || total + bytes > maxBytes) continue;
    out.push({ path: check.posix, content });
    total += bytes;
  }
  return out;
}

/** The open context round of the latest iteration, or null when the service is not waiting for context. */
export function awaitingRound(
  review: GetReviewResponse,
): NonNullable<GetReviewResponse['iteration']['contextRound']> | null {
  const round = review.iteration.contextRound;
  return review.iteration.status === 'NEEDS_CONTEXT' && round?.state === 'AWAITING' ? round : null;
}

/** Declines every request of the open round, so the service stops waiting. Null when no round is open. */
export function declineRound(review: GetReviewResponse): ContextResponseRequest | null {
  const round = awaitingRound(review);
  if (!round) return null;
  return {
    round: round.round,
    responses: (review.iteration.contextRequests ?? []).map((q) => ({ requestId: q.requestId, status: 'declined' })),
  };
}

/**
 * Answers every request of an open round from the checkout. Nothing is declined: the checkout is the PR's own code,
 * and secret-like paths, paths outside the repository and non-text files are still refused by the shared checks.
 */
export async function answerRound(
  top: string,
  headSha: string,
  review: GetReviewResponse,
): Promise<ContextResponseRequest | null> {
  const round = awaitingRound(review);
  if (!round) return null;
  const answered = await answerRequests({
    top,
    headSha,
    includeUncommitted: false,
    requests: review.iteration.contextRequests ?? [],
    decline: new Set(),
    // The round may carry more than one response accepts; cap at the response limit so a large answer is trimmed,
    // not rejected as a whole.
    maxBytes: Math.min(round.maxBytes, LIMITS.contextResponseTotalBytes),
  });
  const body: ContextResponseRequest = { round: round.round, responses: answered.responses };
  checkContextResponseLimits(body);
  return body;
}
