// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContextRequest, ContextRequestKind, ContextResponseRequest } from '../client/types.js';
import { ToolError } from '../errors.js';
import { LIMITS, utf8Bytes } from '../limits.js';
import { redactText, type RedactionLocation } from '../redact.js';
import { checkRequestPath, type PathRefusal } from '../safety.js';
import { decodeRepoText, grepRepo, readRepoFile } from './git.js';

/**
 * Answers a context round locally. Nothing here touches the network: each request is
 * either provided (redacted content), declined (by the user, refused locally, not text or too large)
 * or not found. Every decision, with its local reason, goes into the approval summary.
 */

export type ContextDecisionKind = 'provide' | 'declined' | 'not_found';

export interface ContextDecision {
  requestId: string;
  kind: ContextRequestKind;
  /** Display target: the path, `path:start-end`, or the search query. Untrusted text. */
  target: string;
  /** The reviewer's reason. Untrusted model text. */
  reason: string;
  decision: ContextDecisionKind;
  localReason?: string;
  bytes: number;
}

export interface AnswerInput {
  top: string;
  headSha: string;
  includeUncommitted: boolean;
  requests: readonly ContextRequest[];
  /** Request ids the user does not want shared. */
  decline: ReadonlySet<string>;
  /** contextRound.maxBytes: the round's byte budget. */
  maxBytes: number;
}

export interface AnswerResult {
  responses: ContextResponseRequest['responses'];
  decisions: ContextDecision[];
  redactions: RedactionLocation[];
}

export const LOCAL_REASON = {
  userDeclined: 'declined by you',
  secret: 'refused: secret-like path',
  outside: 'refused: outside repository',
  invalid: 'refused: invalid path',
  invalidQuery: 'refused: invalid query',
  notText: 'not text',
  tooLarge: 'too large',
} as const;

/** Local reason for a refused path; null for NOT_FOUND (answered not_found). */
export function refusalReason(reason: PathRefusal): string | null {
  switch (reason) {
    case 'DENYLISTED':
      return LOCAL_REASON.secret;
    case 'OUTSIDE_REPO':
    case 'GIT_DIR':
      return LOCAL_REASON.outside;
    case 'INVALID_PATH':
      return LOCAL_REASON.invalid;
    case 'NOT_FOUND':
      return null;
  }
}

function targetOf(r: ContextRequest): string {
  if (r.kind === 'search') return r.query ?? '';
  if (r.kind === 'range') return `${r.path ?? ''}:${r.startLine ?? '?'}-${r.endLine ?? '?'}`;
  return r.path ?? '';
}

type Content =
  { content: string; redactions: RedactionLocation[] } | { decision: 'declined' | 'not_found'; localReason?: string };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Reads one file request's text, or the reason it cannot be provided. */
async function readText(input: AnswerInput, rel: string | null): Promise<{ text: string; posix: string } | Content> {
  const check = checkRequestPath(input.top, rel ?? '');
  if (!check.ok) {
    const localReason = refusalReason(check.reason);
    return localReason === null ? { decision: 'not_found' } : { decision: 'declined', localReason };
  }
  let buf: Buffer | null;
  try {
    buf = await readRepoFile(input.top, input.headSha, check.posix, input.includeUncommitted);
  } catch (e) {
    if (e instanceof ToolError && e.code === 'LIMIT_EXCEEDED') {
      return { decision: 'declined', localReason: LOCAL_REASON.tooLarge };
    }
    throw e;
  }
  if (buf === null) return { decision: 'not_found' };
  const text = decodeRepoText(buf);
  if (text === null) return { decision: 'declined', localReason: LOCAL_REASON.notText };
  return { text, posix: check.posix };
}

async function contentFor(input: AnswerInput, r: ContextRequest): Promise<Content> {
  if (r.kind === 'search') {
    const query = r.query ?? '';
    if (query.trim() === '' || CONTROL_RE.test(query)) {
      return { decision: 'declined', localReason: LOCAL_REASON.invalidQuery };
    }
    const lines = await grepRepo(input.top, input.headSha, query, input.includeUncommitted);
    if (lines.length === 0) return { decision: 'not_found' };
    const red = redactText(lines.join('\n'), `search ${r.requestId}`);
    return { content: red.text, redactions: red.redactions };
  }
  const read = await readText(input, r.path);
  if (!('text' in read)) return read;
  // Redact the whole file so multi-line secrets are caught, then keep the requested lines.
  const red = redactText(read.text, read.posix);
  if (r.kind === 'file') return { content: red.text, redactions: red.redactions };
  const lines = red.text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = r.startLine ?? 1;
  const end = Math.max(start, r.endLine ?? start);
  if (start < 1 || start > lines.length) return { decision: 'not_found' };
  return {
    content: lines.slice(start - 1, end).join('\n'),
    redactions: red.redactions.filter((x) => x.line >= start && x.line <= end),
  };
}

export async function answerRequests(input: AnswerInput): Promise<AnswerResult> {
  const responses: AnswerResult['responses'] = [];
  const decisions: ContextDecision[] = [];
  const redactions: RedactionLocation[] = [];
  let total = 0;
  for (const r of input.requests) {
    const base = { requestId: r.requestId, kind: r.kind, target: targetOf(r), reason: r.reason };
    const c: Content = input.decline.has(r.requestId)
      ? { decision: 'declined', localReason: LOCAL_REASON.userDeclined }
      : await contentFor(input, r);
    if ('content' in c) {
      const bytes = utf8Bytes(c.content);
      if (bytes <= LIMITS.contextResponseEntryBytes && total + bytes <= input.maxBytes) {
        total += bytes;
        responses.push({ requestId: r.requestId, status: 'provided', content: c.content });
        decisions.push({ ...base, decision: 'provide', bytes });
        redactions.push(...c.redactions);
        continue;
      }
      responses.push({ requestId: r.requestId, status: 'declined' });
      decisions.push({ ...base, decision: 'declined', localReason: LOCAL_REASON.tooLarge, bytes: 0 });
      continue;
    }
    responses.push({ requestId: r.requestId, status: c.decision });
    decisions.push({
      ...base,
      decision: c.decision,
      ...(c.localReason !== undefined ? { localReason: c.localReason } : {}),
      bytes: 0,
    });
  }
  return { responses, decisions, redactions };
}
