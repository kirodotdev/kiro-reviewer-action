// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// End-to-end smoke: the built bundle (dist/index.mjs) against a fake BFF (TLS + CBOR) and a fake GitHub API, both on
// 127.0.0.1. Needs openssl for a throwaway certificate; TLS verification is off for the child process only.
// Run `npm run build` first, then `npm run smoke`.
/* global process, console, Buffer, URL */
import { cbor } from '@smithy/core/cbor';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kcra-smoke-'));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// --- repo with a base and a feature commit
const work = path.join(tmp, 'work');
execFileSync('mkdir', ['-p', path.join(work, 'src')]);
sh(work, 'init', '-q', '-b', 'main');
sh(work, 'config', 'user.email', 't@example.com');
sh(work, 'config', 'user.name', 't');
writeFileSync(path.join(work, 'src/a.ts'), 'export const a = 1;\nexport const b = 2;\n');
sh(work, 'add', '-A');
sh(work, 'commit', '-q', '-m', 'base');
const baseSha = sh(work, 'rev-parse', 'HEAD');
sh(work, 'checkout', '-q', '-b', 'feat');
writeFileSync(
  path.join(work, 'src/a.ts'),
  'export const a = 1;\nconst q = "SELECT * FROM t WHERE id = " + id;\nexport const b = 2;\n',
);
sh(work, 'commit', '-qam', 'add query');
const headSha = sh(work, 'rev-parse', 'HEAD');

// --- cert
const key = path.join(tmp, 'k.pem');
const crt = path.join(tmp, 'c.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    crt,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ],
  { stdio: 'ignore' },
);

const T0 = Date.parse('2026-11-17T09:00:00Z');
const REV = 'rev-' + 'a'.repeat(24);
const F1 = 'f-0000000000000001';
const F2 = 'f-0000000000000002';
const finding = (id, o = {}) => ({
  findingId: id,
  fingerprint: 'fp' + id,
  file: 'src/a.ts',
  side: 'new',
  startLine: 2,
  endLine: 2,
  title: 'SQL built from input',
  explanation: 'concatenation',
  severity: 'high',
  category: 'security',
  blocking: true,
  suppressed: false,
  state: 'NEW',
  firstSeenIteration: 1,
  carriedForward: false,
  verified: true,
  reviewers: ['security'],
  thread: [],
  dismissedByAuthor: false,
  claimedFixedStillPresent: false,
  ...o,
});
const counts = (n) => ({ active: n, blocking: n, suppressed: 0, resolved: 0 });
const iteration = (number, status, o = {}) => ({
  number,
  status,
  outcome: status === 'COMPLETED' ? 'FINDINGS' : 'IN_PROGRESS',
  counts: counts(1),
  modelUsage: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  warnings: [],
  excludedFiles: [],
  cache: { hit: false },
  contextRequests: [],
  base: { ref: 'main', commit: baseSha },
  createdAt: T0,
  ...o,
});
const getReply = (it, findings) => ({
  reviewId: REV,
  level: 'standard',
  iterationBudget: 5,
  contextRounds: { allowed: 2, used: 1, max: 2 },
  latestIteration: it.number,
  createdAt: T0,
  updatedAt: T0,
  iterations: [{ number: it.number, status: it.status }],
  iteration: it,
  findings,
});

let bffCalls = [];
let ghCalls = [];
let scenario = null;

const bffServer = https.createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const op = req.url.split('/').pop();
    const body = chunks.length ? cbor.deserialize(new Uint8Array(Buffer.concat(chunks))) : {};
    bffCalls.push({ op, body, headers: req.headers });
    const out = scenario.bff(op, body);
    res.writeHead(200, { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor' });
    res.end(Buffer.from(cbor.serialize(out)));
  });
});

const ghServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    ghCalls.push({ method: req.method, url: req.url, body });
    const json = (status, v) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.method === 'GET' && /\/issues\/7\/comments/.test(req.url)) return json(200, scenario.comments);
    if (req.url === '/graphql') return json(200, /reviewThreads/.test(body.query) ? scenario.threads : { data: {} });
    if (req.method === 'DELETE') return json(404, {});
    return json(req.method === 'POST' ? 201 : 200, []);
  });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const bffPort = await listen(bffServer);
const ghPort = await listen(ghServer);

const event = path.join(tmp, 'event.json');
writeFileSync(
  event,
  JSON.stringify({
    repository: { full_name: 'o/r' },
    pull_request: {
      number: 7,
      title: 'Add query',
      body: 'adds a query',
      draft: false,
      user: { login: 'alice' },
      base: { ref: 'main', sha: baseSha, repo: { full_name: 'o/r' } },
      head: { ref: 'feat', sha: headSha, repo: { full_name: 'o/r' } },
    },
  }),
);

async function run(name, sc) {
  scenario = sc;
  bffCalls = [];
  ghCalls = [];
  const out = path.join(tmp, name + '.out');
  const summary = path.join(tmp, name + '.summary');
  writeFileSync(out, '');
  writeFileSync(summary, '');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    GITHUB_WORKSPACE: work,
    GITHUB_RUN_ID: '1',
    GITHUB_API_URL: `http://127.0.0.1:${ghPort}`,
    GITHUB_GRAPHQL_URL: `http://127.0.0.1:${ghPort}/graphql`,
    GITHUB_OUTPUT: out,
    GITHUB_STEP_SUMMARY: summary,
    'INPUT_GITHUB-TOKEN': 'ghs_fake',
    'INPUT_KIRO-API-KEY': 'ksk_smokeKEY123456',
    INPUT_ENDPOINT: `https://127.0.0.1:${bffPort}`,
    'INPUT_ALLOW-CUSTOM-ENDPOINT': 'true',
  };
  const child = spawn('node', [path.join(ROOT, 'dist/index.mjs')], { env });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const code = await new Promise((r) => child.on('close', r));
  return {
    code,
    log,
    outputs: readFileSync(out, 'utf8'),
    stepSummary: readFileSync(summary, 'utf8'),
    bff: bffCalls,
    gh: ghCalls,
  };
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failures++;
};
const ops = (r) => r.bff.map((c) => c.op);

// ---------- Scenario 1: first review, one context round, one blocking finding
{
  let gets = 0;
  const r = await run('first', {
    comments: [],
    threads: {
      data: {
        repository: {
          pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        },
      },
    },
    bff(op) {
      if (op === 'ListCodeReviews') return { reviews: [] };
      if (op === 'CreateCodeReview')
        return {
          reviewId: REV,
          iteration: 1,
          status: 'QUEUED',
          iterationBudget: 5,
          contextRounds: { allowed: 2, used: 0, max: 2 },
          warnings: [],
          excludedFiles: [],
        };
      if (op === 'GetCodeReview') {
        gets++;
        if (gets === 1) {
          return getReply(
            iteration(1, 'NEEDS_CONTEXT', {
              contextRequests: [{ requestId: 'r1c1', kind: 'file', path: 'src/a.ts', reason: 'why' }],
              contextRound: { round: 1, state: 'AWAITING', maxBytes: 200000, expiresAt: T0 + 120000 },
            }),
            [],
          );
        }
        return getReply(
          iteration(1, 'COMPLETED', {
            completeness: {
              reviewersPlanned: ['security'],
              reviewersSucceeded: ['security'],
              reviewersFailed: [],
              verify: 'OK',
              budgetExhausted: false,
              deadlineHit: false,
              candidatesTruncated: false,
              findingsTruncated: false,
              nothingReviewable: false,
              rulesApplied: [],
              rulesSkipped: [],
              context: {
                planner: 'REQUESTED',
                requested: [],
                provided: [],
                declined: [],
                notFound: [],
                unanswered: [],
                timedOut: false,
                unsolicited: 0,
                entries: [],
                missing: false,
              },
            },
          }),
          [finding(F1)],
        );
      }
      if (op === 'UpdateCodeReviewContext')
        return {
          reviewId: REV,
          iteration: 1,
          round: 1,
          status: 'RESPONDED',
          provided: ['r1c1'],
          declined: [],
          notFound: [],
          unanswered: [],
          unsolicited: 0,
        };
      return {};
    },
  });
  console.log('--- first review: exit', r.code, '| outputs:', r.outputs.replace(/\n/g, ' '));
  console.log('GH:', r.gh.map((c) => `${c.method} ${c.url}`).join(' | '));
  console.log(
    'LOG:',
    r.log
      .split('\n')
      .filter((l) => /::warning|::error|::notice/.test(l))
      .join(' // '),
  );
  check('exit code 1 (blocking finding)', r.code === 1, `code ${r.code}\n${r.log}`);
  check(
    'BFF op order',
    JSON.stringify(ops(r)) ===
      JSON.stringify([
        'ListCodeReviews',
        'CreateCodeReview',
        'GetCodeReview',
        'UpdateCodeReviewContext',
        'GetCodeReview',
      ]),
    ops(r).join(','),
  );
  const create = r.bff.find((c) => c.op === 'CreateCodeReview');
  check('new reviews default to 20 iterations', create?.body.iterationBudget === 20);
  check(
    'API key identity headers on every call',
    r.bff.every(
      (c) =>
        c.headers.authorization === 'Bearer ksk_smokeKEY123456' &&
        c.headers.tokentype === 'API_KEY' &&
        c.headers['smithy-protocol'] === 'rpc-v2-cbor',
    ),
  );
  check(
    'create carries diff, base, level, token, manifest, changed-file context',
    !!create &&
      create.body.diff.includes('SELECT') &&
      create.body.base.commit === baseSha &&
      create.body.level === 'standard' &&
      /^[0-9a-f]{32}$/.test(create.body.clientToken) &&
      create.body.manifest.includes('src/a.ts') &&
      create.body.context.some((c) => c.path === 'src/a.ts'),
    JSON.stringify(Object.keys(create?.body ?? {})),
  );
  const ctx = r.bff.find((c) => c.op === 'UpdateCodeReviewContext');
  check(
    'context answered with the file',
    !!ctx &&
      ctx.body.reviewId === REV &&
      ctx.body.iteration === 1 &&
      ctx.body.round === 1 &&
      ctx.body.responses[0].status === 'provided' &&
      ctx.body.responses[0].content.includes('SELECT'),
    JSON.stringify(ctx?.body),
  );
  const review = r.gh.find((c) => c.method === 'POST' && /pulls\/7\/reviews/.test(c.url));
  check(
    'inline comment on src/a.ts:2 with finding marker and agent prompt',
    !!review &&
      review.body.comments?.[0]?.path === 'src/a.ts' &&
      review.body.comments[0].line === 2 &&
      review.body.comments[0].body.includes(`kiro-finding:${F1}`) &&
      review.body.comments[0].body.includes('Prompt for AI agents'),
    JSON.stringify(review?.body ?? null).slice(0, 300),
  );
  const sticky = r.gh.find((c) => c.method === 'POST' && /issues\/7\/comments/.test(c.url));
  check(
    'sticky summary created with review id and 1 blocking',
    !!sticky && sticky.body.body.includes(`kiro-review-id:${REV}`) && sticky.body.body.includes('**1 blocking**'),
    sticky?.body?.body,
  );
  check(
    'status pending then failure',
    r.gh
      .filter((c) => /statuses/.test(c.url))
      .map((c) => c.body.state)
      .join() === 'pending,failure',
    r.gh
      .filter((c) => /statuses/.test(c.url))
      .map((c) => c.body?.state)
      .join(),
  );
  check(
    'label set to blocking',
    r.gh.some((c) => /labels/.test(c.url) && c.method === 'POST' && c.body.labels?.[0] === 'kiro-review: blocking'),
  );
  check(
    'outputs result=reviewed blocking=1',
    /result=reviewed/.test(r.outputs) && /blocking=1/.test(r.outputs) && r.outputs.includes(`review-id=${REV}`),
    r.outputs,
  );
  check(
    'step summary written without HTML comments',
    r.stepSummary.includes('Kiro Reviewer') && !r.stepSummary.includes('<!--'),
  );
  check(
    'API key masked in the log and never printed',
    r.log.includes('::add-mask::ksk_smokeKEY123456') && r.log.split('ksk_smokeKEY123456').length === 2,
    r.log,
  );
}

// ---------- Scenario 2: a push to a PR that already has a review; a reply and a resolved thread
{
  const prevIter = iteration(1, 'COMPLETED');
  const r_state = { resubmitted: false };
  const nodes = [
    {
      id: 'T1',
      isResolved: false,
      resolvedBy: null,
      comments: {
        nodes: [
          {
            body: `<!-- kiro-finding:${F1} -->\nfinding`,
            createdAt: '2026-11-17T09:00:00Z',
            authorAssociation: 'NONE',
            author: { __typename: 'Bot', login: 'github-actions' },
          },
          {
            body: 'false positive: validated upstream',
            createdAt: '2026-11-17T10:00:00Z',
            authorAssociation: 'OWNER',
            author: { __typename: 'User', login: 'octocat' },
          },
        ],
      },
    },
    {
      id: 'T2',
      isResolved: true,
      resolvedBy: { login: 'octocat' },
      comments: {
        nodes: [
          {
            body: `<!-- kiro-finding:${F2} -->\nfinding`,
            createdAt: '2026-11-17T09:00:00Z',
            authorAssociation: 'NONE',
            author: { __typename: 'Bot', login: 'github-actions' },
          },
        ],
      },
    },
  ];
  const r = await run('push', {
    comments: [
      {
        id: 5,
        body: `<!-- kiro-review-summary -->\n<!-- kiro-review-id:${REV} -->\n### Kiro Reviewer`,
        user: { type: 'Bot' },
      },
    ],
    threads: {
      data: {
        repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
      },
    },
    bff(op, body) {
      if (op === 'GetCodeReview' && !body.iteration && !r_state.resubmitted)
        return getReply(prevIter, [finding(F1), finding(F2, { startLine: 1, blocking: false })]);
      if (op === 'UpdateCodeReview') {
        r_state.resubmitted = true;
        return {
          reviewId: REV,
          iteration: 2,
          status: 'QUEUED',
          iterationBudget: 5,
          contextRounds: { allowed: 2, used: 1, max: 2 },
          warnings: [],
          excludedFiles: [],
        };
      }
      if (op === 'GetCodeReview')
        return getReply(
          iteration(2, 'COMPLETED', {
            completeness: {
              reviewersPlanned: [],
              reviewersSucceeded: [],
              reviewersFailed: [],
              verify: 'OK',
              budgetExhausted: false,
              deadlineHit: false,
              candidatesTruncated: false,
              findingsTruncated: false,
              nothingReviewable: false,
              rulesApplied: [],
              rulesSkipped: [],
              context: {
                planner: 'NO_REQUESTS',
                requested: [],
                provided: [],
                declined: [],
                notFound: [],
                unanswered: [],
                timedOut: false,
                unsolicited: 0,
                entries: [],
                missing: false,
              },
            },
            createdAt: T0 + 3600000,
          }),
          [finding(F1, { state: 'PERSISTING' }), finding(F2, { state: 'PERSISTING', startLine: 1, blocking: false })],
        );
      return {};
    },
  });
  console.log('--- push: exit', r.code, '| outputs:', r.outputs.replace(/\n/g, ' '));
  console.log('GH:', r.gh.map((c) => `${c.method} ${c.url}`).join(' | '));
  console.log(
    'LOG:',
    r.log
      .split('\n')
      .filter((l) => /::warning|::error|::notice/.test(l))
      .join(' // '),
  );
  check('exit code 1 (F1 still blocking)', r.code === 1, `code ${r.code}\n${r.log}`);
  check(
    'continues the PR review, no new review created, no list scan',
    JSON.stringify(ops(r)) ===
      JSON.stringify(['GetCodeReview', 'UpdateCodeReview', 'GetCodeReview', 'UpdateCodeReviewFinding']),
    ops(r).join(','),
  );
  const upd = r.bff.find((c) => c.op === 'UpdateCodeReview');
  check(
    'resubmit has reviewId, no level, and the reply as a response',
    !!upd &&
      upd.body.reviewId === REV &&
      !('level' in upd.body) &&
      JSON.stringify(upd.body.responses) ===
        JSON.stringify([
          { findingId: F1, disposition: 'false_positive', comment: 'false positive: validated upstream' },
        ]),
    JSON.stringify(upd?.body?.responses),
  );
  const sup = r.bff.find((c) => c.op === 'UpdateCodeReviewFinding');
  check(
    'resolved thread suppresses F2 with a reason',
    !!sup &&
      sup.body.findingId === F2 &&
      sup.body.reviewId === REV &&
      /Resolved on GitHub by octocat/.test(sup.body.reason),
    JSON.stringify(sup?.body),
  );
  const edit = r.gh.find((c) => c.method === 'PATCH' && /comments\/5/.test(c.url));
  check(
    'sticky summary edited in place; counts exclude the suppressed finding',
    !!edit && edit.body.body.includes('**1 blocking**') && edit.body.body.includes('1 accepted'),
    edit?.body?.body,
  );
  check(
    'no duplicate inline review posted (both findings already have threads)',
    !r.gh.some((c) => c.method === 'POST' && /pulls\/7\/reviews/.test(c.url)),
    '',
  );
  check(
    'no second summary comment created',
    !r.gh.some((c) => c.method === 'POST' && /issues\/7\/comments/.test(c.url)),
    '',
  );
}
bffServer.close();
ghServer.close();
console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
