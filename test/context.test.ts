// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GetReviewResponse } from '../src/client/types.js';
import { scanDiff } from '../src/collect/diffInfo.js';
import { answerRound, awaitingRound, changedFileContext, declineRound } from '../src/context.js';
import { git, makeRepo, rm, write } from './helpers.js';

function reviewWith(iteration: Partial<GetReviewResponse['iteration']>): GetReviewResponse {
  return { iteration: { number: 1, status: 'RUNNING', ...iteration } } as GetReviewResponse;
}

describe('changedFileContext', () => {
  it('sends post-change contents of modified text files and skips added files, which the diff carries whole', async () => {
    const repo = realpathSync(makeRepo());
    try {
      write(repo, 'src/added.ts', 'export const c = 1;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'more');
      const head = git(repo, 'rev-parse', 'HEAD');
      const diff = git(repo, 'diff', 'mainline', head);
      const files = scanDiff(diff).files;
      expect(files.find((f) => f.path === 'src/added.ts')?.status).toBe('added');
      const ctx = await changedFileContext(repo, head, files, 200_000);
      expect(ctx).toEqual([
        { path: 'src/users.ts', content: 'export const a = 1;\nexport const b = "x" + req.query.id;\n' },
      ]);
      expect(await changedFileContext(repo, head, files, 5)).toEqual([]);
    } finally {
      rm(repo);
    }
  });

  it('skips secret-like and oversized modified files', async () => {
    const repo = realpathSync(makeRepo());
    try {
      write(repo, 'src/keep.ts', 'export const a = 1;\n');
      write(repo, '.env', 'TOKEN=x\n');
      write(repo, 'big.txt', 'x'.repeat(100_001));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'more');
      const head = git(repo, 'rev-parse', 'HEAD');
      const files = ['src/keep.ts', '.env', 'big.txt'].map((path) => ({
        path,
        oldPath: path,
        status: 'modified' as const,
        added: 1,
        removed: 0,
      }));
      const ctx = await changedFileContext(repo, head, files, 200_000);
      expect(ctx.map((c) => c.path)).toEqual(['src/keep.ts']);
    } finally {
      rm(repo);
    }
  });
});

describe('changedFileContext with a file git refuses to read', () => {
  it('skips a file over the read buffer and keeps the rest', async () => {
    const repo = realpathSync(makeRepo());
    try {
      write(repo, 'huge.txt', 'x'.repeat(2_200_000));
      write(repo, 'small.ts', 'export const s = 1;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'huge');
      const head = git(repo, 'rev-parse', 'HEAD');
      const files = ['huge.txt', 'small.ts'].map((path) => ({
        path,
        oldPath: path,
        status: 'modified' as const,
        added: 1,
        removed: 0,
      }));
      const ctx = await changedFileContext(repo, head, files, 200_000);
      expect(ctx.map((c) => c.path)).toEqual(['small.ts']);
    } finally {
      rm(repo);
    }
  });
});

describe('context rounds', () => {
  const round = {
    round: 1,
    state: 'AWAITING',
    requestedAt: null,
    expiresAt: null,
    respondedAt: null,
    maxBytes: 200_000,
  };

  it('declines every request of an open round, and nothing when no round is open', () => {
    const open = reviewWith({
      status: 'NEEDS_CONTEXT',
      contextRound: round as never,
      contextRequests: [{ requestId: 'r1c1' }, { requestId: 'r1c2' }] as never,
    });
    expect(declineRound(open)).toEqual({
      round: 1,
      responses: [
        { requestId: 'r1c1', status: 'declined' },
        { requestId: 'r1c2', status: 'declined' },
      ],
    });
    expect(declineRound(reviewWith({ status: 'RUNNING' }))).toBeNull();
  });

  it('finds an open round only while the service is waiting for context', () => {
    expect(awaitingRound(reviewWith({ status: 'NEEDS_CONTEXT', contextRound: round as never }))?.round).toBe(1);
    expect(
      awaitingRound(reviewWith({ status: 'NEEDS_CONTEXT', contextRound: { ...round, state: 'RESPONDED' } as never })),
    ).toBeNull();
    expect(awaitingRound(reviewWith({ status: 'RUNNING', contextRound: round as never }))).toBeNull();
  });

  it('answers requests from the checkout and refuses secret-like paths', async () => {
    const repo = realpathSync(makeRepo());
    try {
      write(repo, 'src/helper.ts', 'export const h = 2;\n');
      write(repo, '.env', 'TOKEN=x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'helper');
      const head = git(repo, 'rev-parse', 'HEAD');
      const req = (requestId: string, path: string) => ({
        requestId,
        kind: 'file',
        path,
        startLine: null,
        endLine: null,
        query: null,
        reason: 'r',
      });
      const body = await answerRound(
        repo,
        head,
        reviewWith({
          status: 'NEEDS_CONTEXT',
          contextRound: round as never,
          contextRequests: [req('r1c1', 'src/helper.ts'), req('r1c2', '.env'), req('r1c3', 'nope.ts')] as never,
        }),
      );
      expect(body?.round).toBe(1);
      const byId = Object.fromEntries(body!.responses.map((r) => [r.requestId, r]));
      expect(byId.r1c1).toMatchObject({ status: 'provided', content: 'export const h = 2;\n' });
      expect(byId.r1c2!.status).toBe('declined');
      expect(byId.r1c3!.status).toBe('not_found');
    } finally {
      rm(repo);
    }
  });
});
