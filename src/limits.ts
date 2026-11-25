// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ToolError } from './errors.js';

/** The service allows at most 2 context rounds per review session. */
export const MAX_CONTEXT_ROUNDS_PER_REVIEW = 2;

/**
 * Client copy of the service's input limits. Same constants and the same `limit` names, so a client
 * pre-check fails exactly like the service would.
 */
export const LIMITS = {
  requestBytes: 2_000_000,
  diffBytes: 1_000_000,
  diffFiles: 50,
  diffChangedLines: 8_000,
  contextFiles: 20,
  contextFileBytes: 100_000,
  contextTotalBytes: 200_000,
  rulesReviewMdBytes: 131_072,
  pathChars: 512,
  suppressReasonChars: 500,
  iterationBudgetMin: 1,
  iterationBudgetMax: 5,
  iterationBudgetDefault: 3,
  contextRounds: MAX_CONTEXT_ROUNDS_PER_REVIEW,
  manifestPaths: 2_000,
  contextResponseUnsolicitedFiles: 8,
  contextResponseEntryBytes: 100_000,
  contextResponseTotalBytes: 200_000,
  contextIterationTotalBytes: 300_000,
  /** Git metadata limits. */
  intentChars: 2_000,
  commitCount: 50,
  commitBytes: 8_192,
  /** Finding responses on resubmit. */
  responseCommentChars: 1_000,
  responsesMax: 50,
} as const;

export type LimitName =
  | 'request.bytes'
  | 'diff.bytes'
  | 'diff.files'
  | 'diff.changedLines'
  | 'context.files'
  | 'context.fileBytes'
  | 'context.totalBytes'
  | 'rules.reviewMdBytes'
  | 'path.chars'
  | 'suppress.reasonChars'
  | 'iterationBudget'
  | 'context.rounds'
  | 'manifest.paths'
  | 'contextResponse.unsolicitedFiles'
  | 'contextResponse.entryBytes'
  | 'contextResponse.totalBytes'
  | 'context.iterationTotalBytes'
  | 'intent.chars'
  | 'commits.count'
  | 'commits.bytes'
  | 'responses.max'
  | 'responses.commentChars';

export function limitExceeded(limit: LimitName, max: number, actual: number): ToolError {
  return new ToolError('LIMIT_EXCEEDED', `Input exceeds the ${limit} limit (max ${max}, actual ${actual}).`, {
    limit,
    max,
    actual,
  });
}

export function checkLimit(limit: LimitName, max: number, actual: number): void {
  if (actual > max) throw limitExceeded(limit, max, actual);
}

export const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** Length in Unicode code points (matches the service). */
export const charCount = (s: string): number => [...s].length;

export interface PayloadLimitInput {
  diff: string;
  diffFiles: number;
  diffPaths: readonly string[];
  changedLines: number;
  iterationBudget?: number;
  contextRounds?: number;
  manifest?: readonly string[];
  context: ReadonlyArray<{ path: string; content: string }>;
  rules?: { reviewMd?: string };
  /** Git metadata. */
  intent?: string;
  commits?: ReadonlyArray<{ subject: string; body?: string }>;
}

/** Client pre-check of every input limit. */
export function checkPayloadLimits(p: PayloadLimitInput): void {
  checkLimit('diff.bytes', LIMITS.diffBytes, utf8Bytes(p.diff));
  checkLimit('diff.files', LIMITS.diffFiles, p.diffFiles);
  for (const path of p.diffPaths) checkLimit('path.chars', LIMITS.pathChars, charCount(path));
  checkLimit('diff.changedLines', LIMITS.diffChangedLines, p.changedLines);
  if (p.iterationBudget !== undefined) {
    checkLimit('iterationBudget', LIMITS.iterationBudgetMax, p.iterationBudget);
  }
  if (p.contextRounds !== undefined) checkLimit('context.rounds', LIMITS.contextRounds, p.contextRounds);
  if (p.manifest !== undefined) {
    checkLimit('manifest.paths', LIMITS.manifestPaths, p.manifest.length);
    for (const path of p.manifest) checkLimit('path.chars', LIMITS.pathChars, charCount(path));
  }
  checkLimit('context.files', LIMITS.contextFiles, p.context.length);
  let total = 0;
  for (const entry of p.context) {
    checkLimit('path.chars', LIMITS.pathChars, charCount(entry.path));
    const bytes = utf8Bytes(entry.content);
    checkLimit('context.fileBytes', LIMITS.contextFileBytes, bytes);
    total += bytes;
  }
  checkLimit('context.totalBytes', LIMITS.contextTotalBytes, total);
  if (p.rules?.reviewMd !== undefined) {
    checkLimit('rules.reviewMdBytes', LIMITS.rulesReviewMdBytes, utf8Bytes(p.rules.reviewMd));
  }
  if (p.intent !== undefined) checkLimit('intent.chars', LIMITS.intentChars, charCount(p.intent));
  if (p.commits !== undefined) {
    checkLimit('commits.count', LIMITS.commitCount, p.commits.length);
    let commitBytes = 0;
    for (const c of p.commits) commitBytes += utf8Bytes(c.subject) + utf8Bytes(c.body ?? '');
    checkLimit('commits.bytes', LIMITS.commitBytes, commitBytes);
  }
}

export interface ContextResponseLimitInput {
  responses: ReadonlyArray<{ content?: string }>;
  context?: ReadonlyArray<{ path: string; content: string }>;
}

/**
 * Client pre-check of the context-route limits (service checkContextResponseLimits without the
 * iteration total, which needs the service's submitted bytes; the client uses contextRound.maxBytes).
 * Returns the round's content bytes.
 */
export function checkContextResponseLimits(body: ContextResponseLimitInput): number {
  const context = body.context ?? [];
  checkLimit('contextResponse.unsolicitedFiles', LIMITS.contextResponseUnsolicitedFiles, context.length);
  let total = 0;
  for (const r of body.responses) {
    if (r.content === undefined) continue;
    const bytes = utf8Bytes(r.content);
    checkLimit('contextResponse.entryBytes', LIMITS.contextResponseEntryBytes, bytes);
    total += bytes;
  }
  for (const entry of context) {
    checkLimit('path.chars', LIMITS.pathChars, charCount(entry.path));
    const bytes = utf8Bytes(entry.content);
    checkLimit('contextResponse.entryBytes', LIMITS.contextResponseEntryBytes, bytes);
    total += bytes;
  }
  checkLimit('contextResponse.totalBytes', LIMITS.contextResponseTotalBytes, total);
  return total;
}

/** request.bytes on the exact body that will be sent. */
export function checkRequestBytes(body: string): void {
  checkLimit('request.bytes', LIMITS.requestBytes, utf8Bytes(body));
}

export function checkSuppressReason(reason: string | undefined): void {
  if (reason !== undefined) checkLimit('suppress.reasonChars', LIMITS.suppressReasonChars, charCount(reason));
}

/** Client pre-check of finding-response limits (service checkResponsesLimits). */
export function checkResponsesLimits(responses: ReadonlyArray<{ comment?: string }>): void {
  checkLimit('responses.max', LIMITS.responsesMax, responses.length);
  for (const r of responses) {
    if (r.comment !== undefined)
      checkLimit('responses.commentChars', LIMITS.responseCommentChars, charCount(r.comment));
  }
}
