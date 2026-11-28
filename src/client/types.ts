// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Review API request and response types.
 */

export type ReviewLevel = 'quick' | 'standard' | 'deep';
export type IterationStatus = 'QUEUED' | 'RUNNING' | 'NEEDS_CONTEXT' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
export type Outcome = 'IN_PROGRESS' | 'FINDINGS' | 'NO_FINDINGS' | 'INCOMPLETE';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'nit';
export type FindingState = 'NEW' | 'PERSISTING' | 'RESOLVED';

/** Author disposition of a previous-iteration finding on resubmit. */
export type Disposition = 'fixed' | 'false_positive' | 'wont_fix' | 'deferred' | 'question';

/** One author response to a previous-iteration finding (resubmit `responses`). */
export interface FindingResponse {
  findingId: string;
  disposition: Disposition;
  /** Author free text (untrusted); redacted before staging. */
  comment?: string;
  /** Explicit, digest-bound user approval for a blocking dismissal; set only after an in-chat "yes". */
  acknowledged?: boolean;
}

/** One entry of a finding's thread (maps to a GitHub thread reply in the Web phase). */
export interface ThreadEntry {
  author: 'agent' | 'reviewer';
  text: string;
  iteration: number;
}

export const TERMINAL_STATUSES: readonly IterationStatus[] = ['COMPLETED', 'PARTIAL', 'FAILED'];

export interface RefCommit {
  ref: string;
  commit: string;
}

export interface RulesPayload {
  source: 'base';
  revision: string;
  autosdeYaml?: string;
  reviewMd?: string;
}

export interface ClientInfo {
  name?: string;
  version?: string;
  repo?: string;
  /** Dev-only test hook (service FAULT_INJECTION=enabled only); set by the smoke harness. */
  faultInjection?: 'reviewer_failure' | 'context_request';
}

/** ResubmitReview request. */
export interface ResubmitRequest {
  clientToken?: string;
  base: RefCommit;
  head?: { ref: string; commit?: string };
  diff: string;
  rules?: RulesPayload;
  context?: Array<{ path: string; content: string }>;
  client?: ClientInfo;
  /** Repo-relative tracked paths (names only) the reviewer may request. */
  manifest?: string[];
  /** Author's free-text intent for the change. */
  intent?: string;
  /** Commit messages for merge-base..HEAD, newest first; author/email/timestamp excluded. */
  commits?: Array<{ subject: string; body?: string }>;
  /** Author dispositions of the previous iteration's findings; resubmit only. */
  responses?: FindingResponse[];
}

/** SubmitReview request. */
export interface SubmitRequest extends ResubmitRequest {
  level?: ReviewLevel;
  iterationBudget?: number;
  /** Context rounds allowed for the review session, 0..2 (service default 0). */
  contextRounds?: number;
}

/** Session context-round accounting (Submit/Resubmit 202 and GetReview). */
export interface ContextRoundsInfo {
  allowed: number;
  used: number;
  max: number;
}

export interface SubmitResponse {
  reviewId: string;
  iteration: number;
  status: IterationStatus;
  iterationBudget: number;
  warnings: string[];
  /** Paths the service excluded from review (generated, fixture, lock, vendored; FILES_EXCLUDED). */
  excludedFiles?: string[];
  contextRounds?: ContextRoundsInfo;
}

export type ContextRequestKind = 'file' | 'range' | 'search';
export type ContextResponseStatus = 'provided' | 'declined' | 'not_found';

/** A reviewer-planned context request (GetReview `iteration.contextRequests`; absent fields are null). */
export interface ContextRequest {
  requestId: string;
  kind: ContextRequestKind;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  query: string | null;
  /** Untrusted model text: escape and truncate before display. */
  reason: string;
}

export type ContextRoundState = 'PLANNED' | 'AWAITING' | 'RESPONDED' | 'APPLIED' | 'TIMED_OUT' | 'EXPIRED';

/** GetReview `iteration.contextRound`. */
export interface ContextRoundView {
  round: number;
  state: ContextRoundState;
  requestedAt: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  /** Bytes this round may still carry (responses + unsolicited). */
  maxBytes: number;
}

/** `completeness.context`. */
export interface ContextOutcome {
  planner: 'DISABLED' | 'ROUNDS_EXHAUSTED' | 'NOT_RUN' | 'BUDGET_EXHAUSTED' | 'FAILED' | 'NO_REQUESTS' | 'REQUESTED';
  round: number | null;
  requested: string[];
  provided: string[];
  declined: string[];
  notFound: string[];
  unanswered: string[];
  timedOut: boolean;
  unsolicited: number;
  entries: Array<{
    source: 'requested' | 'client';
    requestId: string | null;
    kind: ContextRequestKind | null;
    path: string | null;
    bytes: number;
  }>;
  missing: boolean;
}

/** POST /reviews/{id}/iterations/{n}/context body. */
export interface ContextResponseRequest {
  round: number;
  responses: Array<{ requestId: string; status: ContextResponseStatus; content?: string }>;
  context?: Array<{ path: string; content: string }>;
}

/** 202 of the context route. */
export interface ContextResponseAccepted {
  reviewId: string;
  iteration: number;
  round: number;
  status: string;
  provided: string[];
  declined: string[];
  notFound: string[];
  unanswered: string[];
  unsolicited: number;
}

export interface Completeness {
  reviewersPlanned: string[];
  reviewersSucceeded: string[];
  reviewersFailed: Array<{ reviewer: string; code: string }>;
  verify: string;
  budgetExhausted: boolean;
  deadlineHit: boolean;
  candidatesTruncated: boolean;
  findingsTruncated: boolean;
  /** Service-side: every changed file was binary. */
  nothingReviewable?: boolean;
  /** Custom rule ids whose file-patterns matched a reviewed file, and those that did not. */
  rulesApplied?: string[];
  rulesSkipped?: string[];
  context?: ContextOutcome;
}

export interface Counts {
  active: number;
  blocking: number;
  suppressed: number;
  resolved: number;
}

export interface IterationView {
  number: number;
  status: IterationStatus;
  outcome: Outcome;
  completeness?: Completeness | null;
  counts: Counts;
  modelUsage?: { calls: number; inputTokens: number; outputTokens: number } | null;
  warnings: string[];
  /** Paths the service excluded from review (FILES_EXCLUDED). */
  excludedFiles?: string[];
  /** Result cache: hit means an identical earlier review was reused with no model calls. */
  cache?: { hit: boolean; cachedAt: string | null };
  /** Requests of this iteration's context round (empty without a round). */
  contextRequests?: ContextRequest[];
  contextRound?: ContextRoundView | null;
  error: { code: string; stage?: string; message: string } | null;
  base?: RefCommit;
  rulesRevision?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface Finding {
  findingId: string;
  fingerprint: string;
  file: string;
  side: 'new' | 'old';
  startLine: number;
  endLine: number;
  title: string;
  explanation: string;
  suggestion: string | null;
  severity: Severity;
  category: string;
  ruleId: string | null;
  blocking: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  state: FindingState;
  firstSeenIteration: number;
  resolvedIteration: number | null;
  carriedForward: boolean;
  /** null when verify was FAILED or SKIPPED_BUDGET. */
  confidence: number | null;
  verified: boolean;
  reviewers: string[];
  /** Finding-response thread. */
  thread?: ThreadEntry[];
  /** Blocking finding set aside by the author with digest-bound approval; stays in counts.blocking. */
  dismissedByAuthor?: boolean;
  dismissalReason?: string | null;
  dismissalDisposition?: Disposition | null;
  /** The author claimed `fixed` but the fingerprint tracking kept the finding. */
  claimedFixedStillPresent?: boolean;
  /** The user's feedback on the finding. */
  feedback?: FindingFeedback | null;
}

export type FeedbackVote = 'up' | 'down';
export type FeedbackReason = 'wrong' | 'not_relevant' | 'too_minor' | 'already_handled' | 'other';

export interface FindingFeedback {
  vote: FeedbackVote;
  reason: FeedbackReason | null;
  comment: string | null;
  updatedAt: string;
}

/** A review in `GET /reviews`. */
export interface ReviewSummary {
  reviewId: string;
  createdAt: string;
  updatedAt: string;
  level: ReviewLevel;
  latestIteration: number;
  status: IterationStatus;
  /** Counts of the latest finished iteration; absent until one has finished. */
  counts?: Counts;
  repo?: string;
  headRef?: string;
  baseRef?: string;
}

export interface ListReviewsResponse {
  reviews: ReviewSummary[];
  nextToken?: string;
}

export interface IterationPayloadResponse {
  reviewId: string;
  iteration: number;
  sentAt: string;
  base: RefCommit;
  head?: { ref: string; commit?: string };
  level?: ReviewLevel;
  diff: string;
  context: Array<{ path: string; content: string }>;
  rules?: RulesPayload;
  intent?: string;
  commits?: Array<{ subject: string; body?: string }>;
  responses?: FindingResponse[];
  manifestCount: number;
  contextRounds: Array<{
    round: number;
    sentAt: string;
    responses: ContextResponseRequest['responses'];
    context: Array<{ path: string; content: string }>;
  }>;
  expiresAt: string;
}

export interface GetReviewResponse {
  reviewId: string;
  level: ReviewLevel;
  iterationBudget: number;
  latestIteration: number;
  createdAt: string;
  updatedAt: string;
  iterations: Array<{ number: number; status: IterationStatus }>;
  iteration: IterationView;
  findings: Finding[];
  contextRounds?: ContextRoundsInfo;
}
