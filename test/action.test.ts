// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { Github } from '../src/github.js';
import type { Finding, ListReviewsResponse, ReviewSummary } from '../src/client/types.js';
import {
  clientTokenFor,
  commentableLines,
  escapeCommand,
  findPriorReview,
  findingIdIn,
  applyResolved,
  resolvedReason,
  input,
  safePath,
  safeText,
  splitFindings,
  renderSummary,
  type PriorReviewDeps,
} from '../src/lib.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  '+three',
  ' four',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
  '',
].join('\n');

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
    confidence: 0.9,
    verified: true,
    reviewers: [],
    ...over,
  };
}

describe('commentableLines', () => {
  it('maps added, removed and context lines per side', () => {
    const m = commentableLines(DIFF);
    const a = m.get('src/a.ts')!;
    expect([...a.right]).toEqual([1, 2, 3, 4]);
    expect([...a.left]).toEqual([1, 2, 3]);
  });

  it('uses the old path for a deleted file', () => {
    const g = commentableLines(DIFF).get('src/gone.ts')!;
    expect([...g.left]).toEqual([1, 2]);
    expect(g.right.size).toBe(0);
  });
});

describe('splitFindings', () => {
  const lines = commentableLines(DIFF);

  it('places findings on diff lines inline and the rest in the summary list', () => {
    const { inline, inlineFindings, rest } = splitFindings(
      [finding({}), finding({ startLine: 99 }), finding({ file: 'other.ts' }), finding({ side: 'old', startLine: 2 })],
      lines,
    );
    expect(inline.map((c) => `${c.path}:${c.line}:${c.side}`)).toEqual(['src/a.ts:2:RIGHT', 'src/a.ts:2:LEFT']);
    expect(inlineFindings).toHaveLength(2);
    expect(rest).toHaveLength(2);
  });

  it('drops suppressed and resolved findings', () => {
    const { inline, rest } = splitFindings([finding({ suppressed: true }), finding({ state: 'RESOLVED' })], lines);
    expect(inline).toHaveLength(0);
    expect(rest).toHaveLength(0);
  });
});

describe('safeText', () => {
  it('breaks @mentions, escapes HTML and caps length', () => {
    expect(safeText('ping @octocat now')).not.toContain('@octocat');
    expect(safeText('<img src=x>')).toBe('&lt;img src=x&gt;');
    expect(safeText('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('safePath', () => {
  it('removes backticks and control characters', () => {
    expect(safePath('a`b\nc')).toBe("a'b'c");
    expect(safePath('x'.repeat(300))).toHaveLength(200);
  });
});

describe('escapeCommand', () => {
  it('encodes %, CR and LF so text cannot start a workflow command', () => {
    expect(escapeCommand('a%b\r\n::add-mask::x')).toBe('a%25b%0D%0A::add-mask::x');
  });
});

describe('clientTokenFor', () => {
  it('is 32 hex chars and stable per repo, merge-base, head and intent', () => {
    const t = clientTokenFor('r', 'a'.repeat(40), 'b'.repeat(40), 'i');
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(clientTokenFor('r', 'a'.repeat(40), 'b'.repeat(40), 'i')).toBe(t);
    expect(clientTokenFor('r', 'a'.repeat(40), 'c'.repeat(40), 'i')).not.toBe(t);
    expect(clientTokenFor('r', 'a'.repeat(40), 'b'.repeat(40), 'edited title')).not.toBe(t);
  });
});

describe('findPriorReview', () => {
  const MB = 'a'.repeat(40);
  const summary = (id: string, over: Partial<ReviewSummary> = {}): ReviewSummary => ({
    reviewId: id,
    createdAt: '',
    updatedAt: '',
    level: 'standard',
    latestIteration: 1,
    status: 'COMPLETED',
    counts: { active: 0, blocking: 0, suppressed: 0, resolved: 0 },
    repo: 'my-repo',
    ...over,
  });
  const page = (reviews: ReviewSummary[], nextToken?: string): ListReviewsResponse => ({
    reviews,
    ...(nextToken ? { nextToken } : {}),
  });
  const stored = (over: Record<string, unknown> = {}) => ({ diff: 'D', base: { ref: 'b', commit: MB }, ...over });
  const deps = (over: Partial<PriorReviewDeps> = {}): PriorReviewDeps => ({
    repo: 'my-repo',
    diff: 'D',
    mergeBase: MB,
    level: 'standard',
    rules: {},
    list: async () => page([summary('rev-a')]),
    payload: (async () => stored()) as never,
    complete: async () => true,
    ...over,
  });

  it('returns the review whose payload diff equals the diff', async () => {
    const hit = await findPriorReview(
      deps({
        list: async () => page([summary('rev-a'), summary('rev-b')]),
        payload: (async (id: string) => stored({ diff: id === 'rev-b' ? 'D' : 'other' })) as never,
      }),
    );
    expect(hit?.reviewId).toBe('rev-b');
  });

  it('ignores other repos, incomplete reviews and reviews with blocking findings', async () => {
    const payload = vi.fn(async () => stored());
    const hit = await findPriorReview(
      deps({
        list: async () =>
          page([
            summary('rev-a', { repo: 'else' }),
            summary('rev-b', { status: 'FAILED' }),
            summary('rev-c', { counts: { active: 1, blocking: 1, suppressed: 0, resolved: 0 } }),
            // No finished iteration yet, so there is nothing to call clean.
            { ...summary('rev-d'), counts: undefined },
          ]),
        payload: payload as never,
      }),
    );
    expect(hit).toBeNull();
    expect(payload).not.toHaveBeenCalled();
  });

  it('does not accept a weaker level, another merge-base, other rules or a degraded review', async () => {
    expect(
      await findPriorReview(deps({ level: 'deep', list: async () => page([summary('rev-a', { level: 'quick' })]) })),
    ).toBeNull();
    expect(await findPriorReview(deps({ mergeBase: 'b'.repeat(40) }))).toBeNull();
    expect(await findPriorReview(deps({ rules: { reviewMd: '# other\n' } }))).toBeNull();
    expect(await findPriorReview(deps({ complete: async () => false }))).toBeNull();
    expect(
      await findPriorReview(deps({ level: 'quick', list: async () => page([summary('rev-a', { level: 'deep' })]) })),
    ).not.toBeNull();
  });

  it('follows nextToken and stops at maxScan', async () => {
    const list = vi.fn(async (t?: string) =>
      t ? page([summary('rev-z')]) : page([summary('rev-a', { repo: 'x' })], 'n'),
    );
    expect((await findPriorReview(deps({ list })))?.reviewId).toBe('rev-z');
    expect(await findPriorReview(deps({ list, maxScan: 1 }))).toBeNull();
  });

  it('treats an unreadable payload as no match', async () => {
    expect(await findPriorReview(deps({ payload: vi.fn().mockRejectedValue(new Error('404')) as never }))).toBeNull();
  });

  it('lets a list error out so the caller can fall back to a normal review', async () => {
    await expect(findPriorReview(deps({ list: vi.fn().mockRejectedValue(new Error('403')) }))).rejects.toThrow('403');
  });
});

describe('summary and comment rendering', () => {
  const review = {
    reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
    iteration: { number: 1, status: 'COMPLETED', counts: { active: 1, blocking: 0, suppressed: 0, resolved: 0 } },
  } as never;

  it('sanitises file and severity in the summary list', () => {
    const f = finding({ file: 'a`b](http://x)\n# h', severity: '**x**' as never, startLine: 3 });
    const md = renderSummary(review, [f], 0, 'h'.repeat(40));
    expect(md).not.toContain('a`b');
    expect(md).not.toContain('**x**');
    expect(md).toContain("| ⚫ Unknown · **blocking** | T | `a'b](http://x)'# h:3` · no inline comment |");
  });

  it('renders an unknown severity as unknown in an inline comment', () => {
    const { inline } = splitFindings([finding({ severity: '[x](http://y)' as never })], commentableLines(DIFF));
    expect(inline[0]!.body).toContain('_⚫ Unknown_ | _Blocking_');
    expect(inline[0]!.body).not.toContain('http://y');
  });
});

describe('Github.postReview', () => {
  const MARKER = `<!-- kiro-code-review:${'h'.repeat(40)} -->`;
  const reply = (status: number, json: unknown = null) =>
    ({ status, text: async () => (json === null ? '' : JSON.stringify(json)) }) as Response;
  const botReview = [{ user: { type: 'Bot' }, body: `${MARKER}\nx` }];

  function client(responses: Array<Response | Error>) {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchFn = vi.fn(async (url: string, init: { method: string }) => {
      calls.push({ method: init.method, url });
      const r = responses.shift();
      if (!r) throw new Error('unexpected request');
      if (r instanceof Error) throw r;
      return r;
    });
    const gh = new Github('https://api.test', 't', 'o/r', 7, { fetch: fetchFn as never, sleep: async () => {} });
    return { gh, calls };
  }

  it('does not repost after a 5xx when the review already exists', async () => {
    const { gh, calls } = client([reply(502), reply(200, botReview)]);
    await gh.postReview('h'.repeat(40), `${MARKER}\nbody`, []);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  it('retries the POST after a network error only when no marker exists', async () => {
    const { gh, calls } = client([new Error('reset'), reply(200, []), reply(200, {})]);
    await gh.postReview('h'.repeat(40), `${MARKER}\nbody`, []);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
  });

  it('retries a 429 without checking for the marker', async () => {
    const { gh, calls } = client([reply(429), reply(200, {})]);
    await gh.postReview('h'.repeat(40), `${MARKER}\nbody`, []);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
  });

  it('folds inline comments into the body on a 422, and fails fast on a 403', async () => {
    const c = [{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'b' }];
    const ok = client([reply(422), reply(200, {})]);
    await ok.gh.postReview('h'.repeat(40), 'body', c);
    expect(ok.calls).toHaveLength(2);
    const denied = client([reply(403)]);
    await expect(denied.gh.postReview('h'.repeat(40), 'body', c)).rejects.toThrow('HTTP 403');
    expect(denied.calls).toHaveLength(1);
  });

  it('hasMarker throws when the review list cannot be read, and ignores non-bot authors', async () => {
    await expect(client([reply(500), reply(500), reply(500)]).gh.hasMarker(MARKER)).rejects.toThrow('HTTP 500');
    const human = [{ user: { type: 'User' }, body: MARKER }];
    expect(await client([reply(200, human)]).gh.hasMarker(MARKER)).toBe(false);
  });
});

describe('input', () => {
  it('reads hyphenated inputs the way the runner exports them', () => {
    const env = { 'INPUT_GITHUB-TOKEN': ' tok ', 'INPUT_FAIL-ON-BLOCKING': 'false', INPUT_LEVEL: 'deep' };
    expect(input(env, 'github-token')).toBe('tok');
    expect(input(env, 'fail-on-blocking', 'true')).toBe('false');
    expect(input(env, 'level')).toBe('deep');
    expect(input({ INPUT_GITHUB_TOKEN: 'x' }, 'github-token', 'fallback')).toBe('fallback');
  });
});

describe('resolving a thread suppresses its finding', () => {
  it('embeds the finding id in each inline comment and reads it back', () => {
    const { inline } = splitFindings([finding({ findingId: 'f-00000000000000ab' })], commentableLines(DIFF));
    expect(findingIdIn(inline[0]!.body)).toBe('f-00000000000000ab');
    expect(findingIdIn('no marker here')).toBeNull();
  });

  it('marks only active, unsuppressed findings with a resolved thread', () => {
    const fs = [
      finding({ findingId: 'f-0000000000000001' }),
      finding({ findingId: 'f-0000000000000002' }),
      finding({ findingId: 'f-0000000000000003', suppressed: true }),
    ];
    const done = applyResolved(
      fs,
      new Map([
        ['f-0000000000000001', 'octocat'],
        ['f-0000000000000003', 'octocat'],
      ]),
    );
    expect(done.map((d) => d.finding.findingId)).toEqual(['f-0000000000000001']);
    expect(fs.map((f) => f.suppressed)).toEqual([true, false, true]);
    expect(splitFindings(fs, commentableLines(DIFF)).inline).toHaveLength(1);
  });

  it('builds a bounded reason from the login', () => {
    expect(resolvedReason('octocat')).toBe('Resolved on GitHub by octocat');
    expect(resolvedReason('<script>')).toBe('Resolved on GitHub by script');
  });

  it('reads resolved bot threads over GraphQL and ignores user-authored ones', async () => {
    const thread = (isResolved: boolean, type: string, id: string) => ({
      isResolved,
      resolvedBy: { login: 'octocat' },
      comments: { nodes: [{ body: `<!-- kiro-finding:${id} -->\nx`, author: { __typename: type } }] },
    });
    const body = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                thread(true, 'Bot', 'f-0000000000000001'),
                thread(false, 'Bot', 'f-0000000000000002'),
                thread(true, 'User', 'f-0000000000000003'),
              ],
            },
          },
        },
      },
    };
    const fetchFn = vi.fn<(url: string) => Promise<Response>>(
      async () => ({ status: 200, text: async () => JSON.stringify(body) }) as Response,
    );
    const gh = new Github('https://api.test', 't', 'o/r', 7, { fetch: fetchFn as never, sleep: async () => {} });
    expect([...(await gh.resolvedFindings())]).toEqual([['f-0000000000000001', 'octocat']]);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.test/graphql');
  });

  it('throws when the threads cannot be read, so nothing is suppressed', async () => {
    const fetchFn = vi.fn(async () => ({ status: 502, text: async () => '' }) as Response);
    const gh = new Github('https://api.test', 't', 'o/r', 7, { fetch: fetchFn as never, sleep: async () => {} });
    await expect(gh.resolvedFindings()).rejects.toThrow('HTTP 502');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
