// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { cbor } from '@smithy/core/cbor';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_BASE_MS,
  bffCall,
  DEFAULT_ENDPOINT,
  loadBffConfig,
  redirectHost,
  serviceCodeOf,
  type BffConfig,
} from '../src/bff.js';
import { ToolError } from '../src/errors.js';
import { createReviewApi, fromWire, toGetReview } from '../src/reviewApi.js';

const CONFIG: BffConfig = { endpoint: 'https://bff.test', apiKey: 'ksk_exampleexampleexample' };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: string | undefined;
}

const PROTOCOL = { 'smithy-protocol': 'rpc-v2-cbor', 'content-type': 'application/cbor' };
const reply = (status: number, body: unknown, headers: Record<string, string> = PROTOCOL) =>
  new Response(body === null ? null : cbor.serialize(body), { status, headers });

/** A fake BFF: answers in order and records what was sent. */
function fakeBff(replies: Array<Response | Error>) {
  const sent: Sent[] = [];
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: cbor.deserialize(init.body as Uint8Array) as Record<string, unknown>,
      redirect: init.redirect,
    });
    const r = replies.shift();
    if (!r) throw new Error('unexpected request');
    if (r instanceof Error) throw r;
    return r;
  });
  return { sent, sleep, fetchFn, deps: { fetch: fetchFn as never, sleep, random: () => 0 } };
}

const catching = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (e) {
    return e as ToolError;
  }
  throw new Error('expected a rejection');
};

describe('loadBffConfig', () => {
  it('defaults the endpoint, trims inputs and keeps only the origin', () => {
    expect(loadBffConfig({ apiKey: ' ksk_abc123456 ' })).toEqual({
      endpoint: 'https://app.kiro.dev',
      apiKey: 'ksk_abc123456',
    });
    expect(DEFAULT_ENDPOINT).toBe('https://app.kiro.dev');
    expect(
      loadBffConfig({ endpoint: 'https://beta.kiro.test/', apiKey: 'k12345678', allowCustomEndpoint: true }).endpoint,
    ).toBe('https://beta.kiro.test');
  });

  it('accepts only Kiro origins unless allowCustomEndpoint is set', () => {
    expect(loadBffConfig({ endpoint: 'https://eu-central-1.app.kiro.dev', apiKey: 'k12345678' }).endpoint).toBe(
      'https://eu-central-1.app.kiro.dev',
    );
    expect(() => loadBffConfig({ endpoint: 'https://attacker.test', apiKey: 'k12345678' })).toThrow(
      /not a Kiro origin/,
    );
    expect(() => loadBffConfig({ endpoint: 'https://app.kiro.dev.attacker.test', apiKey: 'k12345678' })).toThrow(
      /not a Kiro origin/,
    );
  });

  it('refuses an endpoint that is not a bare https origin, since the key is sent there', () => {
    for (const endpoint of [
      'http://app.kiro.dev',
      'https://app.kiro.dev/v1',
      'https://app.kiro.dev/?a=1',
      'https://user:pw@app.kiro.dev',
      'not a url',
    ]) {
      expect(() => loadBffConfig({ endpoint, apiKey: 'k12345678' })).toThrow(/endpoint/i);
    }
  });

  it('requires a key without whitespace', () => {
    expect(() => loadBffConfig({})).toThrow(/No Kiro API key/);
    expect(() => loadBffConfig({ apiKey: '   ' })).toThrow(/No Kiro API key/);
    expect(() => loadBffConfig({ apiKey: 'ksk_a b' })).toThrow(/whitespace/);
  });

  it('resolves the endpoint from region, with fra aliasing eu-central-1', () => {
    expect(loadBffConfig({ region: 'us-east-1', apiKey: 'k12345678' }).endpoint).toBe('https://app.kiro.dev');
    expect(loadBffConfig({ region: 'eu-central-1', apiKey: 'k12345678' }).endpoint).toBe(
      'https://eu-central-1.app.kiro.dev',
    );
    expect(loadBffConfig({ region: ' FRA ', apiKey: 'k12345678' }).endpoint).toBe('https://eu-central-1.app.kiro.dev');
  });

  it('allows endpoint and region together when they agree, and rejects a conflict', () => {
    expect(
      loadBffConfig({
        region: 'eu-central-1',
        endpoint: 'https://eu-central-1.app.kiro.dev',
        apiKey: 'k12345678',
      }).endpoint,
    ).toBe('https://eu-central-1.app.kiro.dev');
    expect(() =>
      loadBffConfig({ region: 'us-east-1', endpoint: 'https://eu-central-1.app.kiro.dev', apiKey: 'k12345678' }),
    ).toThrow(/region or endpoint/i);
  });

  it('rejects an unknown region', () => {
    expect(() => loadBffConfig({ region: 'ap-south-1', apiKey: 'k12345678' })).toThrow(/Unknown region/);
  });
});

describe('bffCall', () => {
  it('posts a CBOR body to the operation path with the API key identity headers', async () => {
    const f = fakeBff([reply(200, { reviewId: 'rev-1' })]);
    const out = await bffCall<{ reviewId: string }>(
      CONFIG,
      'GetCodeReview',
      { reviewId: 'rev-1', iteration: undefined },
      f.deps,
    );
    expect(out).toEqual({ reviewId: 'rev-1' });
    expect(f.sent[0]!.url).toBe('https://bff.test/service/KiroWebBearerService/operation/GetCodeReview');
    expect(f.sent[0]!.headers).toMatchObject({
      'content-type': 'application/cbor',
      accept: 'application/cbor',
      'smithy-protocol': 'rpc-v2-cbor',
      authorization: 'Bearer ksk_exampleexampleexample',
      TokenType: 'API_KEY',
    });
    expect(f.sent[0]!.headers).not.toHaveProperty('X-Kiro-Idp');
    expect(f.sent[0]!.body).toEqual({ reviewId: 'rev-1' });
    expect(Object.keys(f.sent[0]!.body)).toEqual(['reviewId']);
    expect(f.sent[0]!.redirect).toBe('manual');
  });

  it('refuses a success reply that is not an rpc-v2-cbor response', async () => {
    const e = await catching(bffCall(CONFIG, 'GetCodeReview', {}, fakeBff([reply(200, { ok: true }, {})]).deps));
    expect(e.details.serviceCode).toBe('BAD_REPLY');
  });

  it('maps error replies to the codes the recovery logic is written against', async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [
        409,
        {
          __type: 'com.amazon.kirowebportalservice#CodeReviewConflictException',
          message: 'm',
          reason: 'ITERATION_IN_PROGRESS',
        },
        'ITERATION_IN_PROGRESS',
      ],
      [
        409,
        { __type: 'CodeReviewConflictException', message: 'm', reason: 'CONTEXT_WINDOW_CLOSED' },
        'CONTEXT_WINDOW_CLOSED',
      ],
      [404, { __type: 'com.amazon.kirowebportalservice#ResourceNotFoundException', message: 'gone' }, 'NOT_FOUND'],
      [400, { __type: 'com.amazon.kirowebportalservice#BadRequestException', message: 'bad' }, 'VALIDATION_ERROR'],
      [403, { __type: 'com.amazon.kirowebportalservice#ForbiddenException', message: 'no' }, 'ACCESS_DENIED'],
      [
        401,
        {
          __type: 'com.amazon.kirowebportalservice#UnauthorizedException',
          message: 'echoes ksk_exampleexampleexample',
        },
        'UNAUTHORIZED',
      ],
    ];
    for (const [status, body, code] of cases) {
      const f = fakeBff([reply(status, body)]);
      const e = await catching(bffCall(CONFIG, 'CreateCodeReview', {}, f.deps));
      expect(e.code).toBe('SERVICE_ERROR');
      expect(e.details).toMatchObject({ httpStatus: status, serviceCode: code });
      expect(e.message).not.toContain('ksk_');
      expect(f.fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('retries 5xx and 429 with backoff, and gives up with the last error', async () => {
    const ok = fakeBff([
      reply(503, { __type: 'ServiceUnavailableException', message: 'x' }),
      reply(429, { __type: 'ThrottlingException' }),
      reply(200, { a: 1 }),
    ]);
    expect(await bffCall(CONFIG, 'ListCodeReviews', {}, ok.deps)).toEqual({ a: 1 });
    expect(ok.sleep.mock.calls.map((c) => c[0])).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2]);
    const bad = fakeBff([reply(500, { message: 'a' }), reply(500, { message: 'b' }), reply(500, { message: 'c' })]);
    const e = await catching(bffCall(CONFIG, 'ListCodeReviews', {}, bad.deps));
    expect(e.details.httpStatus).toBe(500);
    expect(bad.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('reports a network failure after three attempts', async () => {
    const f = fakeBff([new Error('reset'), new Error('reset'), new Error('reset')]);
    const e = await catching(bffCall(CONFIG, 'GetCodeReview', {}, f.deps));
    expect(e.code).toBe('NETWORK_ERROR');
    expect(f.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('refuses a redirect without retrying, so the key never reaches another host', async () => {
    const f = fakeBff([new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })]);
    const e = await catching(bffCall(CONFIG, 'GetCodeReview', {}, f.deps));
    expect(e.details.serviceCode).toBe('REDIRECT');
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a reply over the size cap', async () => {
    const big = new Response(new Uint8Array(1), {
      status: 200,
      headers: { ...PROTOCOL, 'content-length': String(9 * 1024 * 1024) },
    });
    const e = await catching(bffCall(CONFIG, 'GetCodeReview', {}, fakeBff([big]).deps));
    expect(e.message).toContain('RESPONSE_TOO_LARGE');
  });
});

describe('redirectHost', () => {
  it('shows only a plain hostname, never the path, query or credentials', () => {
    expect(redirectHost('https://idp.example.com/oauth2/authorize?state=secret&client_id=x')).toBe('idp.example.com');
    expect(redirectHost('http://127.0.0.1:9/x')).toBe('127.0.0.1');
    expect(redirectHost('https://user:pw@host.test/')).toBe('host.test');
    expect(redirectHost('/relative/path')).toBeNull();
    expect(redirectHost('')).toBeNull();
    expect(redirectHost(null)).toBeNull();
  });
});

describe('serviceCodeOf', () => {
  it('falls back to the status and keeps unknown error names', () => {
    expect(serviceCodeOf(500, null)).toBe('HTTP_500');
    expect(serviceCodeOf(401, null)).toBe('UNAUTHORIZED');
    expect(serviceCodeOf(500, { __type: 'ns#InternalFailureException' })).toBe('InternalFailureException');
    expect(serviceCodeOf(409, { __type: 'CodeReviewConflictException', reason: 'not an enum value' })).toBe('CONFLICT');
  });
});

describe('fromWire', () => {
  it('turns timestamp members into ISO strings and 64-bit integers into numbers', () => {
    const out = fromWire({
      createdAt: 1763424000000,
      nested: [{ expiresAt: 1763424000000, inputTokens: 7n }],
      round: 1763424000000,
    }) as {
      createdAt: string;
      nested: Array<{ expiresAt: string; inputTokens: number }>;
      round: number;
    };
    expect(out.createdAt).toBe('2025-11-18T00:00:00.000Z');
    expect(out.nested[0]).toEqual({ expiresAt: '2025-11-18T00:00:00.000Z', inputTokens: 7 });
    expect(out.round).toBe(1763424000000);
  });
});

describe('toGetReview', () => {
  const wire = {
    reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: 1763424000000,
    updatedAt: 1763424060000,
    iteration: {
      number: 1,
      status: 'NEEDS_CONTEXT',
      createdAt: 1763424000000,
      cache: { hit: false },
      completeness: { context: { planner: 'REQUESTED' } },
      contextRequests: [{ requestId: 'r1c1', kind: 'file', path: 'a.ts', reason: 'why' }],
      contextRound: { round: 1, state: 'AWAITING', expiresAt: 1763424120000, maxBytes: 200000 },
      modelUsage: { calls: 1n, inputTokens: 10n, outputTokens: 2n },
    },
    findings: [{ findingId: 'f-0000000000000001', title: 't', feedback: { vote: 'up', updatedAt: 1763424000000 } }],
  };

  it('normalizes timestamps and fills absent optional members with null', () => {
    const r = toGetReview(wire);
    expect(r.createdAt).toBe('2025-11-18T00:00:00.000Z');
    expect(r.iteration.createdAt).toBe('2025-11-18T00:00:00.000Z');
    expect(r.iteration.contextRound?.expiresAt).toBe('2025-11-18T00:02:00.000Z');
    expect(r.iteration).toMatchObject({
      error: null,
      startedAt: null,
      completedAt: null,
      cache: { hit: false, cachedAt: null },
    });
    expect(r.iteration.completeness?.context?.round).toBeNull();
    expect(r.iteration.contextRequests?.[0]).toMatchObject({
      path: 'a.ts',
      startLine: null,
      endLine: null,
      query: null,
    });
    expect(r.iteration.modelUsage).toEqual({ calls: 1, inputTokens: 10, outputTokens: 2 });
    expect(r.findings[0]).toMatchObject({ suggestion: null, ruleId: null, confidence: null, resolvedIteration: null });
    expect(r.findings[0]!.feedback?.updatedAt).toBe('2025-11-18T00:00:00.000Z');
  });

  it('does not change its input', () => {
    const copy = JSON.stringify(wire, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    toGetReview(wire);
    expect(JSON.stringify(wire, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).toBe(copy);
  });
});

describe('createReviewApi', () => {
  const base = { ref: 'origin/main', commit: 'a'.repeat(40) };
  const request = {
    clientToken: 'tok12345',
    level: 'standard' as const,
    iterationBudget: 5,
    contextRounds: 2,
    base,
    head: { ref: 'feat', commit: 'b'.repeat(40) },
    diff: 'diff',
    context: [{ path: 'a.ts', content: 'x' }],
    intent: 'why',
    client: { name: 'n', version: 'v', repo: 'r', faultInjection: 'reviewer_failure' as const },
    unknownMember: 'dropped',
  };

  it('creates a review with only members the BFF model defines', async () => {
    const f = fakeBff([
      reply(200, {
        reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
        iteration: 1,
        status: 'QUEUED',
        iterationBudget: 5,
        warnings: [],
        excludedFiles: [],
      }),
    ]);
    const out = await createReviewApi(CONFIG, f.deps).create(request as never);
    expect(out.reviewId).toBe('rev-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(f.sent[0]!.url.endsWith('/operation/CreateCodeReview')).toBe(true);
    expect(Object.keys(f.sent[0]!.body).sort()).toEqual(
      [
        'base',
        'clientToken',
        'client',
        'context',
        'contextRounds',
        'diff',
        'head',
        'intent',
        'iterationBudget',
        'level',
      ].sort(),
    );
    expect(f.sent[0]!.body.client).toEqual({ name: 'n', version: 'v', repo: 'r' });
  });

  it('resubmits by review id with whitelisted finding responses and no level', async () => {
    const f = fakeBff([
      reply(200, {
        reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
        iteration: 2,
        status: 'QUEUED',
        iterationBudget: 5,
        warnings: [],
        excludedFiles: [],
      }),
    ]);
    await createReviewApi(CONFIG, f.deps).resubmit('rev-aaaaaaaaaaaaaaaaaaaaaaaa', {
      ...request,
      responses: [{ findingId: 'f-0000000000000001', disposition: 'false_positive', comment: 'c', extra: 1 }],
    } as never);
    expect(f.sent[0]!.url.endsWith('/operation/UpdateCodeReview')).toBe(true);
    expect(f.sent[0]!.body.reviewId).toBe('rev-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(f.sent[0]!.body).not.toHaveProperty('level');
    expect(f.sent[0]!.body.responses).toEqual([
      { findingId: 'f-0000000000000001', disposition: 'false_positive', comment: 'c' },
    ]);
  });

  it('lists, gets, suppresses, answers context and reads a payload with the right operations and members', async () => {
    const f = fakeBff([
      reply(200, {
        reviews: [
          {
            reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
            createdAt: 1763424000000,
            updatedAt: 1763424000000,
            status: 'RUNNING',
          },
        ],
        nextToken: 'n',
      }),
      reply(200, wire()),
      reply(200, {
        reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
        findingId: 'f-0000000000000001',
        suppressed: true,
        createdAt: 1,
      }),
      reply(200, { reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa', round: 1 }),
      reply(200, {
        reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
        iteration: 1,
        sentAt: 1763424000000,
        expiresAt: 1763427600000,
        diff: 'd',
        base,
      }),
    ]);
    const api = createReviewApi(CONFIG, f.deps);
    const list = await api.list('tok');
    expect(list.reviews[0]!.counts).toBeUndefined();
    expect(list.reviews[0]!.createdAt).toBe('2025-11-18T00:00:00.000Z');
    await api.get('rev-aaaaaaaaaaaaaaaaaaaaaaaa', 2);
    await api.suppress('rev-aaaaaaaaaaaaaaaaaaaaaaaa', 'f-0000000000000001', 'Resolved on GitHub by octocat');
    await api.respondContext('rev-aaaaaaaaaaaaaaaaaaaaaaaa', 1, {
      round: 1,
      responses: [{ requestId: 'r1c1', status: 'provided', content: 'x' }],
    });
    const payload = await api.payload('rev-aaaaaaaaaaaaaaaaaaaaaaaa', 1);
    expect(payload.sentAt).toBe('2025-11-18T00:00:00.000Z');
    expect(f.sent.map((s) => [s.url.split('/').pop(), s.body])).toEqual([
      ['ListCodeReviews', { maxResults: 25, nextToken: 'tok' }],
      ['GetCodeReview', { reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa', iteration: 2 }],
      [
        'UpdateCodeReviewFinding',
        {
          reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
          findingId: 'f-0000000000000001',
          reason: 'Resolved on GitHub by octocat',
        },
      ],
      [
        'UpdateCodeReviewContext',
        {
          reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
          iteration: 1,
          round: 1,
          responses: [{ requestId: 'r1c1', status: 'provided', content: 'x' }],
        },
      ],
      ['GetCodeReviewIterationPayload', { reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa', iteration: 1 }],
    ]);
  });

  it('asks for the latest iteration when none is given', async () => {
    const f = fakeBff([reply(200, wire())]);
    await createReviewApi(CONFIG, f.deps).get('rev-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(f.sent[0]!.body).toEqual({ reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa' });
  });

  function wire() {
    return {
      reviewId: 'rev-aaaaaaaaaaaaaaaaaaaaaaaa',
      createdAt: 1763424000000,
      updatedAt: 1763424000000,
      iteration: { number: 2, status: 'COMPLETED', createdAt: 1763424000000, cache: { hit: false } },
      findings: [],
    };
  }
});
