// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { bffCall, type BffConfig, type BffDeps } from './bff.js';
import type {
  ContextResponseRequest,
  GetReviewResponse,
  IterationPayloadResponse,
  ListReviewsResponse,
  ResubmitRequest,
  SubmitRequest,
  SubmitResponse,
} from './client/types.js';

/** What the Action needs from the review service. The BFF implements it; tests fake it. */
export interface ReviewApi {
  create(req: SubmitRequest): Promise<SubmitResponse>;
  resubmit(reviewId: string, req: ResubmitRequest): Promise<SubmitResponse>;
  list(nextToken?: string): Promise<ListReviewsResponse>;
  get(reviewId: string, iteration?: number): Promise<GetReviewResponse>;
  suppress(reviewId: string, findingId: string, reason: string): Promise<void>;
  respondContext(reviewId: string, iteration: number, body: ContextResponseRequest): Promise<void>;
  payload(reviewId: string, iteration: number): Promise<IterationPayloadResponse>;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

/** Members the BFF reports as epoch milliseconds. The rest of the Action works with ISO-8601 strings. */
const TIMESTAMP_KEYS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'cachedAt',
  'requestedAt',
  'expiresAt',
  'respondedAt',
  'sentAt',
]);

/** Copies a decoded reply: timestamps become ISO strings and 64-bit integers become numbers. */
export function fromWire(v: unknown, key?: string): unknown {
  if (typeof v === 'bigint') return fromWire(Number(v), key);
  if (Array.isArray(v)) return v.map((x) => fromWire(x));
  if (v !== null && typeof v === 'object') {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) out[k] = fromWire(x, k);
    return out;
  }
  if (typeof v === 'number' && key !== undefined && TIMESTAMP_KEYS.has(key)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return v;
}

/** The model leaves unset members absent; the Action's types say `null`. */
function nullable(o: Rec, keys: readonly string[]): void {
  for (const k of keys) if (o[k] === undefined) o[k] = null;
}

export function toGetReview(wire: unknown): GetReviewResponse {
  const r = rec(fromWire(wire));
  const it = rec(r.iteration);
  nullable(it, ['completeness', 'contextRound', 'error', 'startedAt', 'completedAt', 'rulesRevision']);
  nullable(rec(it.cache), ['cachedAt']);
  nullable(rec(rec(it.completeness).context), ['round']);
  for (const q of list(it.contextRequests)) nullable(q, ['path', 'startLine', 'endLine', 'query']);
  for (const f of list(r.findings)) {
    nullable(f, [
      'suggestion',
      'ruleId',
      'suppressionReason',
      'resolvedIteration',
      'confidence',
      'dismissalReason',
      'dismissalDisposition',
      'feedback',
    ]);
  }
  return r as unknown as GetReviewResponse;
}

export function toList(wire: unknown): ListReviewsResponse {
  return rec(fromWire(wire)) as unknown as ListReviewsResponse;
}

const pick = (o: object, keys: readonly string[]): Rec => {
  const src = o as Rec;
  const out: Rec = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

const REQUEST_KEYS = [
  'clientToken',
  'base',
  'head',
  'diff',
  'rules',
  'context',
  'intent',
  'commits',
  'manifest',
] as const;

/** Only members the BFF model defines: the server may reject an unknown one. */
function wireRequest(req: SubmitRequest | ResubmitRequest, extra: readonly string[]): Rec {
  const out = pick(req, [...REQUEST_KEYS, ...extra]);
  if (req.client) out.client = pick(req.client, ['name', 'version', 'repo']);
  if (req.responses) {
    out.responses = req.responses.map((r) => pick(r, ['findingId', 'disposition', 'comment', 'acknowledged']));
  }
  return out;
}

export function createReviewApi(config: BffConfig, deps?: BffDeps): ReviewApi {
  const call = <T>(op: string, input: object): Promise<T> => bffCall<T>(config, op, input, deps);
  const submitted = (wire: unknown): SubmitResponse => rec(fromWire(wire)) as unknown as SubmitResponse;
  return {
    async create(req) {
      return submitted(await call('CreateCodeReview', wireRequest(req, ['level', 'iterationBudget', 'contextRounds'])));
    },
    async resubmit(reviewId, req) {
      return submitted(await call('UpdateCodeReview', { reviewId, ...wireRequest(req, []) }));
    },
    async list(nextToken) {
      return toList(await call('ListCodeReviews', { maxResults: 25, ...(nextToken ? { nextToken } : {}) }));
    },
    async get(reviewId, iteration) {
      return toGetReview(await call('GetCodeReview', { reviewId, ...(iteration ? { iteration } : {}) }));
    },
    async suppress(reviewId, findingId, reason) {
      await call('UpdateCodeReviewFinding', { reviewId, findingId, reason });
    },
    async respondContext(reviewId, iteration, body) {
      await call('UpdateCodeReviewContext', { reviewId, iteration, ...pick(body, ['round', 'responses', 'context']) });
    },
    async payload(reviewId, iteration) {
      return rec(
        fromWire(await call('GetCodeReviewIterationPayload', { reviewId, iteration })),
      ) as unknown as IterationPayloadResponse;
    },
  };
}
