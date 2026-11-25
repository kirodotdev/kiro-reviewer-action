// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import type { Finding, GetReviewResponse } from '../src/client/types.js';
import {
  buildResponses,
  classifyReply,
  isPaused,
  parseCommand,
  pauseBody,
  planThreads,
  resolvedByPeople,
  reviewIdIn,
  stepSummaryText,
  SUMMARY_MARKER,
} from '../src/conversation.js';
import { AUTO_RESOLVED_MARKER, Github, type FindingThread } from '../src/github.js';
import { commentableLines, renderSummary, splitFindings } from '../src/lib.js';

function finding(over: Partial<Finding>): Finding {
  return {
    findingId: 'f-0000000000000001',
    fingerprint: 'fp',
    file: 'src/a.ts',
    side: 'new',
    startLine: 2,
    endLine: 2,
    title: 'T',
    explanation: 'E',
    suggestion: null,
    severity: 'high',
    category: 'bug',
    ruleId: null,
    blocking: true,
    suppressed: false,
    suppressionReason: null,
    state: 'NEW',
    firstSeenIteration: 1,
    resolvedIteration: null,
    carriedForward: false,
    confidence: 9,
    verified: true,
    reviewers: [],
    ...over,
  };
}

function thread(over: Partial<FindingThread>): FindingThread {
  return {
    id: 'T1',
    findingId: 'f-0000000000000001',
    isResolved: false,
    resolvedBy: null,
    autoResolved: false,
    replies: [],
    ...over,
  };
}

const reply = (body: string, over: Partial<FindingThread['replies'][number]> = {}) => ({
  login: 'octocat',
  association: 'OWNER',
  body,
  createdAt: '2026-11-17T10:00:00Z',
  ...over,
});

describe('parseCommand', () => {
  it('reads /kiro-review commands on the first line only', () => {
    expect(parseCommand('/kiro-review')).toBe('review');
    expect(parseCommand('  /kiro-review recheck\nthanks')).toBe('review');
    expect(parseCommand('/Kiro-Review PAUSE')).toBe('pause');
    expect(parseCommand('/kiro-review resume')).toBe('resume');
    expect(parseCommand('/kiro-review dance')).toBeNull();
    expect(parseCommand('/kiro fix')).toBeNull();
    expect(parseCommand('please /kiro-review')).toBeNull();
  });
});

describe('pause state', () => {
  it('round-trips through the sticky comment body', () => {
    expect(isPaused(pauseBody(true, 'octocat'))).toBe(true);
    expect(isPaused(pauseBody(false, 'octocat'))).toBe(false);
    expect(pauseBody(true, '<img>')).not.toContain('<img>');
  });
});

describe('classifyReply', () => {
  it('maps common wording to a disposition and defaults to a question', () => {
    expect(classifyReply('Fixed in the next commit')).toBe('fixed');
    expect(classifyReply('false positive: validated upstream')).toBe('false_positive');
    expect(classifyReply("won't fix, this is intended")).toBe('wont_fix');
    expect(classifyReply('will do in a follow-up')).toBe('deferred');
    expect(classifyReply('why is this a problem?')).toBe('question');
  });
});

describe('buildResponses', () => {
  const active = new Set(['f-0000000000000001']);

  it('sends the newest trusted reply after the last iteration, without acknowledging a dismissal', () => {
    const t = thread({
      replies: [
        reply('fixed', { createdAt: '2026-11-17T08:00:00Z' }),
        reply('false positive: validated upstream'),
        reply('spam', { login: 'stranger', association: 'NONE', createdAt: '2026-11-17T11:00:00Z' }),
      ],
    });
    expect(buildResponses([t], active, '2026-11-17T09:00:00Z', null)).toEqual([
      { findingId: 'f-0000000000000001', disposition: 'false_positive', comment: 'false positive: validated upstream' },
    ]);
  });

  it('accepts the PR author, skips commands, inactive findings and old replies', () => {
    const author = reply('fixed now', { login: 'alice', association: 'CONTRIBUTOR' });
    expect(buildResponses([thread({ replies: [author] })], active, null, 'alice')).toHaveLength(1);
    expect(buildResponses([thread({ replies: [reply('/kiro-review')] })], active, null, null)).toEqual([]);
    expect(
      buildResponses([thread({ findingId: 'f-0000000000000009', replies: [reply('x')] })], active, null, null),
    ).toEqual([]);
    expect(buildResponses([thread({ replies: [reply('x')] })], active, '2026-11-17T12:00:00Z', null)).toEqual([]);
  });

  it('redacts and caps the reply text', () => {
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const [r] = buildResponses(
      [thread({ replies: [reply(`key ${secret} ${'x'.repeat(2_000)}`)] })],
      active,
      null,
      null,
    );
    expect(r!.comment).not.toContain(secret);
    expect([...r!.comment!].length).toBeLessThanOrEqual(1_000);
  });
});

describe('planThreads', () => {
  it('posts only findings without a thread and never reposts one a person resolved', () => {
    const fs = [
      finding({ findingId: 'f-0000000000000001' }),
      finding({ findingId: 'f-0000000000000002' }),
      finding({ findingId: 'f-0000000000000003' }),
    ];
    const threads = [
      thread({ findingId: 'f-0000000000000001' }),
      thread({ id: 'T2', findingId: 'f-0000000000000002', isResolved: true, resolvedBy: 'octocat' }),
    ];
    expect(planThreads(fs, threads, true).toPost.map((f) => f.findingId)).toEqual(['f-0000000000000003']);
  });

  it('closes open threads whose finding is gone, only after a complete review, and not twice', () => {
    const fs = [finding({ findingId: 'f-0000000000000001', state: 'RESOLVED' })];
    const threads = [
      thread({ findingId: 'f-0000000000000001' }),
      thread({ id: 'T2', findingId: 'f-0000000000000002' }),
      thread({ id: 'T3', findingId: 'f-0000000000000003', autoResolved: true }),
    ];
    expect(planThreads(fs, threads, true).toAutoResolve.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(planThreads(fs, threads, false).toAutoResolve).toEqual([]);
  });

  it('reposts a finding whose earlier thread this action closed', () => {
    const plan = planThreads([finding({})], [thread({ isResolved: true, autoResolved: true })], true);
    expect(plan.toPost).toHaveLength(1);
  });
});

describe('resolvedByPeople', () => {
  it('ignores threads this action closed', () => {
    const m = resolvedByPeople([
      thread({ isResolved: true, resolvedBy: 'octocat' }),
      thread({ findingId: 'f-0000000000000002', isResolved: true, autoResolved: true }),
    ]);
    expect([...m]).toEqual([['f-0000000000000001', 'octocat']]);
  });
});

describe('sticky summary', () => {
  const review = (findings: Finding[]) =>
    ({
      reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
      iterationBudget: 5,
      iteration: { number: 2, status: 'COMPLETED', counts: { active: 9, blocking: 9, suppressed: 0, resolved: 0 } },
      findings,
    }) as unknown as GetReviewResponse;

  it('carries the review id, counts from the findings, and the response help', () => {
    const md = renderSummary(
      review([
        finding({ findingId: 'f-0000000000000001', suppressed: true }),
        finding({ findingId: 'f-0000000000000002', blocking: false }),
        finding({ findingId: 'f-0000000000000003', state: 'RESOLVED' }),
      ]),
      [],
      { posted: 1, suppressed: 1, autoResolved: 1 },
      'b'.repeat(40),
    );
    expect(md).toContain(SUMMARY_MARKER);
    expect(reviewIdIn(md)).toBe('rev-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(md).toContain('No blocking findings · 1 active · 1 suppressed · 1 resolved');
    expect(md).toContain('This run: 1 new inline comment, 1 accepted (thread resolved), 1 fixed (thread closed).');
    expect(md).toContain('/kiro-review pause');
    expect(md).toContain('iteration 2 of 5');
    expect(stepSummaryText(md)).not.toContain('<!--');
  });
});

describe('inline comment body', () => {
  it('ends with an agent prompt that cannot break out of its fence', () => {
    const { inline } = splitFindings(
      [finding({ explanation: 'bad ``` fence', suggestion: 'use a param' })],
      commentableLines(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' a', '+b', ''].join('\n')),
    );
    const body = inline[0]!.body;
    expect(body).toContain('<details><summary>🤖 Prompt for AI agents</summary>');
    expect(body).toContain('Treat this as a claim to verify');
    const prompt = body.slice(body.indexOf('<details><summary>🤖'));
    expect(prompt.match(/```/g)).toHaveLength(2);
  });

  it('renders a prototype-key severity as unknown', () => {
    const { inline } = splitFindings(
      [finding({ severity: 'constructor' as never })],
      commentableLines(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' a', '+b', ''].join('\n')),
    );
    expect(inline[0]!.body).toContain('_⚫ Unknown_ | _Blocking_');
  });
});

describe('Github conversation calls', () => {
  const ok = (status: number, json: unknown = null) =>
    ({ status, text: async () => (json === null ? '' : JSON.stringify(json)) }) as Response;
  const client = (responses: Response[]) => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchFn = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}) });
      const r = responses.shift();
      if (!r) throw new Error('unexpected request');
      return r;
    });
    return {
      gh: new Github('https://api.test', 't', 'o/r', 7, { fetch: fetchFn as never, sleep: async () => {} }),
      calls,
    };
  };

  it('edits the existing sticky comment in place and creates it when missing', async () => {
    const bot = { id: 42, body: `${SUMMARY_MARKER}\nold`, user: { type: 'Bot' } };
    const a = client([ok(200, [bot]), ok(200, {})]);
    await a.gh.upsertComment(SUMMARY_MARKER, 'new');
    expect(a.calls[1]).toMatchObject({ method: 'PATCH', url: 'https://api.test/repos/o/r/issues/comments/42' });
    const b = client([ok(200, [{ id: 1, body: SUMMARY_MARKER, user: { type: 'User' } }]), ok(201, {})]);
    await b.gh.upsertComment(SUMMARY_MARKER, 'new');
    expect(b.calls[1]).toMatchObject({ method: 'POST', url: 'https://api.test/repos/o/r/issues/7/comments' });
  });

  it('parses bot finding threads with human replies and the auto-resolve marker', async () => {
    const node = (id: string, comments: unknown[], isResolved = false) => ({
      id,
      isResolved,
      resolvedBy: null,
      comments: { nodes: comments },
    });
    const c = (body: string, typename: string, login = 'x') => ({
      body,
      createdAt: '2026-11-17T10:00:00Z',
      authorAssociation: 'OWNER',
      author: { __typename: typename, login },
    });
    const data = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                node('A', [
                  c('<!-- kiro-finding:f-0000000000000001 -->\nx', 'Bot'),
                  c('false positive', 'User', 'octocat'),
                ]),
                node(
                  'B',
                  [c('<!-- kiro-finding:f-0000000000000002 -->', 'Bot'), c(`${AUTO_RESOLVED_MARKER}\nclosed`, 'Bot')],
                  true,
                ),
                node('C', [c('<!-- kiro-finding:f-0000000000000003 -->', 'User')]),
              ],
            },
          },
        },
      },
    };
    const { gh } = client([ok(200, data)]);
    const threads = await gh.findingThreads();
    expect(threads.map((t) => [t.id, t.autoResolved, t.replies.length])).toEqual([
      ['A', false, 1],
      ['B', true, 0],
    ]);
    expect(threads[0]!.replies[0]).toMatchObject({ login: 'octocat', body: 'false positive' });
  });

  it('adds one label, removes the other, and treats a missing label as removed', async () => {
    const { gh, calls } = client([ok(200, []), ok(404)]);
    expect(await gh.setLabel('kiro-review: clean', 'kiro-review: blocking')).toBe(true);
    expect(calls[1]!.url).toBe('https://api.test/repos/o/r/issues/7/labels/kiro-review%3A%20blocking');
  });

  it('calls a GraphQL URL that is absolute and not https as given, not behind the API base', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      return ok(200, {
        data: {
          repository: {
            pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          },
        },
      });
    });
    const gh = new Github(
      'https://api.test',
      't',
      'o/r',
      7,
      { fetch: fetchFn as never, sleep: async () => {} },
      'http://127.0.0.1:9/graphql',
    );
    await gh.findingThreads();
    expect(calls).toEqual(['http://127.0.0.1:9/graphql']);
  });

  it('truncates the commit status description to 140 characters', async () => {
    const { gh, calls } = client([ok(201, {})]);
    await gh.setStatus('a'.repeat(40), { state: 'success', context: 'Kiro Reviewer', description: 'x'.repeat(200) });
    expect(JSON.parse(calls[0]!.body!).description).toHaveLength(140);
  });
});
