// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Disposition, Finding, FindingResponse } from './client/types.js';
import type { FindingThread } from './github.js';
import { LIMITS } from './limits.js';
import { redactText } from './redact.js';

/** Sticky summary comment, one per PR. */
export const SUMMARY_MARKER = '<!-- kiro-review-summary -->';
/** Sticky pause-state comment, one per PR. */
export const PAUSE_MARKER = '<!-- kiro-review-pause -->';
const PAUSED_STATE = '<!-- kiro-review-state:paused -->';

const REVIEW_ID_MARKER_RE = /<!-- kiro-review-id:(rev-[0-9a-f]{24}) -->/;

export const reviewIdMarker = (reviewId: string): string => `<!-- kiro-review-id:${reviewId} -->`;

/** The review this PR is continuing, from the sticky summary. */
export function reviewIdIn(body: string): string | null {
  return REVIEW_ID_MARKER_RE.exec(body)?.[1] ?? null;
}

/** Marks the inline-comment review for one iteration, so a POST retry can tell whether it already landed. */
export const iterationMarker = (headSha: string, reviewId: string, iteration: number): string =>
  `<!-- kiro-code-review:${headSha}:${reviewId}:${iteration} -->`;

export const isPaused = (body: string): boolean => body.includes(PAUSED_STATE);

export function pauseBody(paused: boolean, login: string): string {
  const who = login.replace(/[^\w.-]/g, '').slice(0, 100) || 'someone';
  return paused
    ? `${PAUSE_MARKER}\n${PAUSED_STATE}\nKiro Reviewer is paused on this pull request by ${who}. ` +
        'New pushes are not reviewed. Comment `/kiro-review resume` to turn it back on.'
    : `${PAUSE_MARKER}\nKiro Reviewer was resumed by ${who}.`;
}

export type Command = 'review' | 'pause' | 'resume';

/**
 * A `/kiro-review` command on the first line of a PR comment. Bare `/kiro-review` and `/kiro-review recheck` mean
 * review. The prefix is not `/kiro` because the Kiro GitHub app already answers `/kiro …` commands.
 */
export function parseCommand(body: string): Command | null {
  const first = body.trimStart().split('\n', 1)[0]!.trim();
  const m = /^\/kiro-review(?:\s+(\w+))?$/i.exec(first);
  if (!m) return null;
  const word = (m[1] ?? 'review').toLowerCase();
  if (word === 'review' || word === 'recheck') return 'review';
  if (word === 'pause' || word === 'resume') return word;
  return null;
}

/** People whose comments may drive the action: repository owners, org members and collaborators. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Maps a reply's wording to a finding disposition. Anything unrecognised is a question for the reviewer. */
export function classifyReply(text: string): Disposition {
  const t = text.trim().toLowerCase();
  if (/^(fixed|done)\b/.test(t)) return 'fixed';
  if (/\bfalse[\s-]?positive\b|^fp\b|\bnot a bug\b/.test(t)) return 'false_positive';
  if (/\bwon'?t fix\b|\bwontfix\b|\bby design\b|\bintended\b/.test(t)) return 'wont_fix';
  if (/\bdefer(red)?\b|\bfollow[\s-]?up\b|\blater\b/.test(t)) return 'deferred';
  return 'question';
}

/**
 * Turns people's replies on finding threads into resubmit `responses`: the newest trusted reply per finding, made
 * after `since`, for findings active in the previous iteration (the service rejects any other id). Commands are not
 * replies. Responses never set `acknowledged`, so a reply cannot dismiss a blocking finding; resolving the thread is
 * the explicit way to accept one.
 */
export function buildResponses(
  threads: readonly FindingThread[],
  activeIds: ReadonlySet<string>,
  since: string | null,
  prAuthor: string | null,
): FindingResponse[] {
  const out: FindingResponse[] = [];
  const seen = new Set<string>();
  for (const t of threads) {
    if (!activeIds.has(t.findingId) || seen.has(t.findingId)) continue;
    const reply = [...t.replies]
      .reverse()
      .find(
        (r) =>
          (TRUSTED_ASSOCIATIONS.has(r.association) || r.login === prAuthor) &&
          (since === null || r.createdAt > since) &&
          parseCommand(r.body) === null &&
          r.body.trim() !== '',
      );
    if (!reply) continue;
    seen.add(t.findingId);
    const comment = [...redactText(reply.body.trim(), `reply:${t.findingId}`).text]
      .slice(0, LIMITS.responseCommentChars)
      .join('');
    out.push({ findingId: t.findingId, disposition: classifyReply(reply.body), comment });
    if (out.length >= LIMITS.responsesMax) break;
  }
  return out;
}

/** Finding ids whose thread a person resolved, mapped to who resolved it. Threads this action closed do not count. */
export function resolvedByPeople(threads: readonly FindingThread[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of threads) if (t.isResolved && !t.autoResolved) out.set(t.findingId, t.resolvedBy ?? 'unknown');
  return out;
}

export interface ThreadPlan {
  /** Active findings with no open thread yet. */
  toPost: Finding[];
  /** Open threads whose finding no longer appears. */
  toAutoResolve: FindingThread[];
}

/**
 * Which findings get a new inline comment and which open threads are closed. A finding keeps one thread across
 * pushes (finding ids are content fingerprints). A thread a person resolved suppresses its finding, so it is never
 * reopened. Threads are only auto-resolved after a complete review, since a missing reviewer is not a fix.
 */
export function planThreads(
  findings: readonly Finding[],
  threads: readonly FindingThread[],
  reviewComplete: boolean,
): ThreadPlan {
  const active = new Set(findings.filter((f) => f.state !== 'RESOLVED').map((f) => f.findingId));
  const open = new Set(threads.filter((t) => !t.isResolved).map((t) => t.findingId));
  const humanResolved = new Set(threads.filter((t) => t.isResolved && !t.autoResolved).map((t) => t.findingId));
  const toPost = findings.filter(
    (f) => f.state !== 'RESOLVED' && !f.suppressed && !open.has(f.findingId) && !humanResolved.has(f.findingId),
  );
  // A thread this action already closed once and a person reopened stays open: the reopen says the issue is still there.
  const toAutoResolve = reviewComplete
    ? threads.filter((t) => !t.isResolved && !t.autoResolved && !active.has(t.findingId))
    : [];
  return { toPost, toAutoResolve };
}

/** Text for the job's step summary: the sticky summary without HTML comments. */
export const stepSummaryText = (summary: string): string => summary.replace(/<!--[\s\S]*?-->\n?/g, '').trim() + '\n';
