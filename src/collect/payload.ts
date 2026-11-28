// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { ClientInfo, FindingResponse, SubmitRequest } from '../client/types.js';

/** Canonical JSON: object keys sorted recursively, no whitespace, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface BuildPayloadInput {
  reviewId?: string;
  level?: SubmitRequest['level'];
  iterationBudget?: number;
  baseRef: string;
  mergeBase: string;
  headRef: string;
  headSha: string;
  includeUncommitted: boolean;
  diff: string;
  rules?: { reviewRulesYaml?: string; reviewMd?: string };
  context: Array<{ path: string; content: string }>;
  repo: string;
  clientVersion: string;
  clientToken: string;
  /** New reviews only; sent when > 0. */
  contextRounds?: number;
  /** Sent when non-empty. */
  manifest?: string[];
  /** Author's intent; sent when present. Already redacted by the caller. */
  intent?: string;
  /** Commit messages; sent when non-empty. Subjects/bodies already redacted by the caller. */
  commits?: Array<{ subject: string; body?: string }>;
  /** Finding responses; sent when non-empty. Comments already redacted by the caller. */
  responses?: FindingResponse[];
  faultInjection?: ClientInfo['faultInjection'];
}

const CLIENT_FIELD_RE = /^[\w .@/-]{1,100}$/;

/** Builds the SubmitReview or ResubmitReview request body. */
export function buildPayload(i: BuildPayloadInput): SubmitRequest {
  const payload: SubmitRequest = {
    clientToken: i.clientToken,
    base: { ref: i.baseRef, commit: i.mergeBase },
    head: i.includeUncommitted ? { ref: i.headRef } : { ref: i.headRef, commit: i.headSha },
    diff: i.diff,
    client: {
      name: 'kiro-reviewer-action',
      version: i.clientVersion,
      ...(CLIENT_FIELD_RE.test(i.repo) ? { repo: i.repo } : {}),
      ...(i.faultInjection ? { faultInjection: i.faultInjection } : {}),
    },
  };
  if (!i.reviewId) {
    payload.level = i.level ?? 'standard';
    payload.iterationBudget = i.iterationBudget ?? 3;
    if (i.contextRounds !== undefined && i.contextRounds > 0) payload.contextRounds = i.contextRounds;
  }
  if (i.manifest && i.manifest.length > 0) payload.manifest = i.manifest;
  if (i.intent !== undefined && i.intent !== '') payload.intent = i.intent;
  if (i.commits && i.commits.length > 0) payload.commits = i.commits;
  if (i.reviewId && i.responses && i.responses.length > 0) payload.responses = i.responses;
  if (i.rules?.reviewRulesYaml !== undefined || i.rules?.reviewMd !== undefined) {
    const { reviewRulesYaml, reviewMd } = i.rules;
    payload.rules = {
      source: 'base',
      revision: i.mergeBase,
      // The BFF still names this field autosdeYaml.
      ...(reviewRulesYaml !== undefined ? { autosdeYaml: reviewRulesYaml } : {}),
      ...(reviewMd !== undefined ? { reviewMd } : {}),
    };
  }
  if (i.context.length > 0) payload.context = i.context;
  return payload;
}
