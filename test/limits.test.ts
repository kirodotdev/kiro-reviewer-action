// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import {
  checkContextResponseLimits,
  checkPayloadLimits,
  checkRequestBytes,
  checkResponsesLimits,
  checkSuppressReason,
  LIMITS,
  MAX_CONTEXT_ROUNDS_PER_REVIEW,
  type LimitName,
  type PayloadLimitInput,
} from '../src/limits.js';

const ok: PayloadLimitInput = { diff: 'x', diffFiles: 1, diffPaths: ['a.ts'], changedLines: 1, context: [] };

function limitOf(fn: () => void): LimitName | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe('LIMIT_EXCEEDED');
    return (e as ToolError).details.limit as LimitName;
  }
}

describe('client limits (same names as the service)', () => {
  const cases: Array<[LimitName, (n: number) => PayloadLimitInput, number]> = [
    ['diff.bytes', (n) => ({ ...ok, diff: 'a'.repeat(n) }), LIMITS.diffBytes],
    ['diff.files', (n) => ({ ...ok, diffFiles: n }), LIMITS.diffFiles],
    ['path.chars', (n) => ({ ...ok, diffPaths: ['p'.repeat(n)] }), LIMITS.pathChars],
    ['diff.changedLines', (n) => ({ ...ok, changedLines: n }), LIMITS.diffChangedLines],
    ['iterationBudget', (n) => ({ ...ok, iterationBudget: n }), LIMITS.iterationBudgetMax],
    [
      'context.files',
      (n) => ({ ...ok, context: Array.from({ length: n }, (_, i) => ({ path: `c${i}`, content: '' })) }),
      LIMITS.contextFiles,
    ],
    [
      'context.fileBytes',
      (n) => ({ ...ok, context: [{ path: 'c', content: 'a'.repeat(n) }] }),
      LIMITS.contextFileBytes,
    ],
    ['rules.reviewMdBytes', (n) => ({ ...ok, rules: { reviewMd: 'a'.repeat(n) } }), LIMITS.rulesReviewMdBytes],
    ['context.rounds', (n) => ({ ...ok, contextRounds: n }), LIMITS.contextRounds],
    [
      'manifest.paths',
      (n) => ({ ...ok, manifest: Array.from({ length: n }, (_, i) => `f${i}`) }),
      LIMITS.manifestPaths,
    ],
    ['intent.chars', (n) => ({ ...ok, intent: '😀'.repeat(n) }), LIMITS.intentChars],
    [
      'commits.count',
      (n) => ({ ...ok, commits: Array.from({ length: n }, (_, i) => ({ subject: `s${i}` })) }),
      LIMITS.commitCount,
    ],
    [
      'commits.bytes',
      (n) => ({ ...ok, commits: [{ subject: 'a'.repeat(100), body: 'b'.repeat(n - 100) }] }),
      LIMITS.commitBytes,
    ],
  ];
  for (const [name, make, max] of cases) {
    it(`${name}: max accepted, max+1 rejected`, () => {
      expect(limitOf(() => checkPayloadLimits(make(max)))).toBeNull();
      expect(limitOf(() => checkPayloadLimits(make(max + 1)))).toBe(name);
    });
  }

  it('git metadata constants mirror the service', () => {
    expect(LIMITS.intentChars).toBe(2_000);
    expect(LIMITS.commitCount).toBe(50);
    expect(LIMITS.commitBytes).toBe(8_192);
  });

  it('context.totalBytes', () => {
    const files = (each: number) => [
      { path: 'a', content: 'a'.repeat(each) },
      { path: 'b', content: 'b'.repeat(each) },
      { path: 'c', content: 'c'.repeat(LIMITS.contextTotalBytes - 2 * each) },
    ];
    expect(limitOf(() => checkPayloadLimits({ ...ok, context: files(50_000) }))).toBeNull();
    const over = [...files(50_000), { path: 'd', content: 'd' }];
    expect(limitOf(() => checkPayloadLimits({ ...ok, context: over }))).toBe('context.totalBytes');
  });

  it('accepts a real-world 37.5 KB REVIEW.md and rejects 131,073 bytes', () => {
    const real = 'a'.repeat(38_400);
    expect(limitOf(() => checkPayloadLimits({ ...ok, rules: { reviewMd: real } }))).toBeNull();
    const over = 'a'.repeat(131_073);
    expect(limitOf(() => checkPayloadLimits({ ...ok, rules: { reviewMd: over } }))).toBe('rules.reviewMdBytes');
  });

  it('request.bytes and suppress.reasonChars', () => {
    expect(limitOf(() => checkRequestBytes('a'.repeat(LIMITS.requestBytes)))).toBeNull();
    expect(limitOf(() => checkRequestBytes('a'.repeat(LIMITS.requestBytes + 1)))).toBe('request.bytes');
    expect(limitOf(() => checkSuppressReason('r'.repeat(500)))).toBeNull();
    expect(limitOf(() => checkSuppressReason('r'.repeat(501)))).toBe('suppress.reasonChars');
  });

  it('manifest paths are checked against path.chars', () => {
    expect(limitOf(() => checkPayloadLimits({ ...ok, manifest: ['p'.repeat(512)] }))).toBeNull();
    expect(limitOf(() => checkPayloadLimits({ ...ok, manifest: ['p'.repeat(513)] }))).toBe('path.chars');
  });

  it('context response limits: unsolicited count, entry bytes, path chars and round total', () => {
    const blob = (n: number) => 'a'.repeat(n);
    const files = (count: number) => Array.from({ length: count }, (_, i) => ({ path: `x${i}`, content: '' }));
    expect(limitOf(() => checkContextResponseLimits({ responses: [], context: files(8) }))).toBeNull();
    expect(limitOf(() => checkContextResponseLimits({ responses: [], context: files(9) }))).toBe(
      'contextResponse.unsolicitedFiles',
    );
    expect(limitOf(() => checkContextResponseLimits({ responses: [{ content: blob(100_000) }] }))).toBeNull();
    expect(limitOf(() => checkContextResponseLimits({ responses: [{ content: blob(100_001) }] }))).toBe(
      'contextResponse.entryBytes',
    );
    expect(
      limitOf(() => checkContextResponseLimits({ responses: [], context: [{ path: 'c', content: blob(100_001) }] })),
    ).toBe('contextResponse.entryBytes');
    expect(
      limitOf(() => checkContextResponseLimits({ responses: [], context: [{ path: 'p'.repeat(513), content: '' }] })),
    ).toBe('path.chars');
    const two = [{ content: blob(100_000) }, { content: blob(100_000) }];
    expect(checkContextResponseLimits({ responses: two })).toBe(200_000);
    expect(limitOf(() => checkContextResponseLimits({ responses: two, context: [{ path: 'c', content: 'x' }] }))).toBe(
      'contextResponse.totalBytes',
    );
  });

  it('mirrors the service context-round constants', () => {
    expect(MAX_CONTEXT_ROUNDS_PER_REVIEW).toBe(2);
    expect(LIMITS).toMatchObject({
      contextRounds: 2,
      manifestPaths: 2_000,
      contextResponseUnsolicitedFiles: 8,
      contextResponseEntryBytes: 100_000,
      contextResponseTotalBytes: 200_000,
      contextIterationTotalBytes: 300_000,
    });
  });

  it('matches the service constants', () => {
    expect(LIMITS).toMatchObject({
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
      iterationBudgetMax: 20,
    });
  });
});

describe('checkResponsesLimits', () => {
  const resp = (comment?: string) => ({ findingId: 'f-0000000000000001', disposition: 'fixed', comment });

  it('accepts up to responsesMax and rejects one more', () => {
    const many = (n: number) => Array.from({ length: n }, () => resp());
    expect(() => checkResponsesLimits(many(LIMITS.responsesMax))).not.toThrow();
    try {
      checkResponsesLimits(many(LIMITS.responsesMax + 1));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).details).toMatchObject({ limit: 'responses.max', max: LIMITS.responsesMax });
    }
  });

  it('rejects a comment over the char limit', () => {
    expect(() => checkResponsesLimits([resp('x'.repeat(LIMITS.responseCommentChars))])).not.toThrow();
    try {
      checkResponsesLimits([resp('x'.repeat(LIMITS.responseCommentChars + 1))]);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ToolError).details).toMatchObject({ limit: 'responses.commentChars' });
    }
  });
});
