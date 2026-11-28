// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { loadBffConfig } from './bff.js';
import {
  TERMINAL_STATUSES,
  type ContextResponseRequest,
  type FindingResponse,
  type GetReviewResponse,
  type SubmitResponse,
} from './client/types.js';
import { scanDiff } from './collect/diffInfo.js';
import { collectRepo, listTrackedFiles, REF_RE } from './collect/git.js';
import { buildManifest } from './collect/manifest.js';
import { buildPayload, canonicalJson, sha256Hex } from './collect/payload.js';
import { answerRound, awaitingRound, changedFileContext, declineRound } from './context.js';
import {
  buildResponses,
  isPaused,
  iterationMarker,
  parseCommand,
  PAUSE_MARKER,
  resolvedByPeople,
  pauseBody,
  planThreads,
  reviewIdIn,
  stepSummaryText,
  SUMMARY_MARKER,
  TRUSTED_ASSOCIATIONS,
} from './conversation.js';
import { ToolError } from './errors.js';
import { Github, type CommitStatus, type FindingThread, type PullRequestInfo } from './github.js';
import { checkPayloadLimits, checkRequestBytes, LIMITS, utf8Bytes } from './limits.js';
import { redactDiff, redactText } from './redact.js';
import { createReviewApi } from './reviewApi.js';
import {
  applyResolved,
  clientTokenFor,
  commentableLines,
  escapeCommand,
  findPriorReview,
  input,
  isComplete,
  postableFindings,
  renderSkipped,
  renderSummary,
  resolvedReason,
  REVIEW_ID_RE,
  splitFindings,
} from './lib.js';

const CLIENT_VERSION = '0.3.0-gha';
const POLL_MS = 10_000;
const DEADLINE_MS = 15 * 60_000;
const MAX_INLINE = 50;
const SHA_RE = /^[0-9a-f]{40}$/;
const LABEL_BLOCKING = 'kiro-review: blocking';
const LABEL_CLEAN = 'kiro-review: clean';

type Env = Record<string, string | undefined>;

interface PullRequestEvent {
  repository: { full_name: string };
  pull_request: PullRequestInfo;
}

interface IssueCommentEvent {
  repository: { full_name: string };
  issue: { number: number; pull_request?: unknown };
  comment: { id: number; body: string; author_association: string; user: { login: string } };
}

const execFileAsync = promisify(execFile);

function setOutput(env: Env, name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`Refusing to write a multi-line value to output ${name}.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const notice = (msg: string): void => console.log(`::notice::${escapeCommand(msg)}`);
const fail = (msg: string): void => console.log(`::error::${escapeCommand(msg)}`);
const warn = (msg: string): void => console.log(`::warning::${escapeCommand(msg)}`);
const errText = (e: unknown): string => (e instanceof Error ? e.message : 'error');
const serviceCode = (e: unknown): string | undefined =>
  e instanceof ToolError && typeof e.details.serviceCode === 'string' ? e.details.serviceCode : undefined;

/** Set once the PR is known; the top-level handlers use it to report a final status for any outcome. */
let reportStatus: (state: CommitStatus['state'], description: string) => Promise<void> = async () => {};

/**
 * A `/kiro-review` command runs on the default branch checkout. Switch the workspace to the PR head (detached) and
 * make sure the base commit is present. The checkout is only read as data; nothing in it is executed.
 * The fetch authenticates with `token` through env config, so it works with `persist-credentials: false`.
 */
async function checkoutPullRequest(top: string, pr: PullRequestInfo, token: string): Promise<void> {
  if (!SHA_RE.test(pr.head.sha) || !SHA_RE.test(pr.base.sha)) throw new Error('The pull request has no valid SHAs.');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  console.log(`::add-mask::${basic}`);
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileAsync('git', ['-C', top, ...args], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, env });
  await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${pr.number}/head`, pr.base.sha], {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
  await git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', pr.head.sha]);
}

async function run(env: Env): Promise<number> {
  const eventName = env.GITHUB_EVENT_NAME;
  if (!env.GITHUB_EVENT_PATH || (eventName !== 'pull_request' && eventName !== 'issue_comment')) {
    notice('Not a pull_request or issue_comment event; nothing to review.');
    return 0;
  }
  const raw = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as PullRequestEvent | IssueCommentEvent;
  const repoName = raw.repository.full_name;
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const prNumber =
    eventName === 'pull_request'
      ? (raw as PullRequestEvent).pull_request.number
      : (raw as IssueCommentEvent).issue.number;
  const githubToken = input(env, 'github-token', env.GITHUB_TOKEN);
  const gh = new Github(
    apiUrl,
    githubToken,
    repoName,
    prNumber,
    undefined,
    env.GITHUB_GRAPHQL_URL ?? `${apiUrl}/graphql`,
  );

  let pr: PullRequestInfo;
  if (eventName === 'issue_comment') {
    const ev = raw as IssueCommentEvent;
    if (!ev.issue.pull_request) {
      notice('The comment is not on a pull request.');
      return 0;
    }
    const command = parseCommand(ev.comment.body);
    if (!command) {
      notice('The comment is not a /kiro-review command.');
      return 0;
    }
    if (!TRUSTED_ASSOCIATIONS.has(ev.comment.author_association)) {
      notice(`Ignoring /kiro-review from ${ev.comment.user.login}: only owners, members and collaborators can use it.`);
      await gh.react(ev.comment.id, 'confused');
      setOutput(env, 'result', 'ignored-command');
      return 0;
    }
    await gh.react(ev.comment.id, 'eyes');
    pr = await gh.getPullRequest();
    if (pr.head.repo?.full_name !== repoName) {
      notice('Pull request is from a fork; skipping (no credentials are shared with forks).');
      setOutput(env, 'result', 'skipped-fork');
      return 0;
    }
    if (command !== 'review') {
      await gh.upsertComment(PAUSE_MARKER, pauseBody(command === 'pause', ev.comment.user.login));
      notice(command === 'pause' ? 'Reviews are paused on this pull request.' : 'Reviews are resumed.');
      setOutput(env, 'result', command === 'pause' ? 'paused' : 'resumed');
      return 0;
    }
    await checkoutPullRequest(env.GITHUB_WORKSPACE ?? process.cwd(), pr, githubToken);
  } else {
    pr = (raw as PullRequestEvent).pull_request;
    if (pr.head.repo?.full_name !== repoName) {
      notice('Pull request is from a fork; skipping (no credentials are shared with forks).');
      setOutput(env, 'result', 'skipped-fork');
      return 0;
    }
    if (pr.draft && input(env, 'skip-drafts', 'true') === 'true') {
      notice('Draft pull request; skipping. It is reviewed when marked ready for review.');
      setOutput(env, 'result', 'skipped-draft');
      return 0;
    }
    try {
      const pause = await gh.findBotComment(PAUSE_MARKER);
      if (pause && isPaused(pause.body)) {
        notice('Reviews are paused on this pull request. Comment /kiro-review resume to turn them back on.');
        setOutput(env, 'result', 'paused');
        return 0;
      }
    } catch (e) {
      warn(`Could not read the pause state (${errText(e)}); reviewing.`);
    }
  }

  if (input(env, 'commit-status', 'true') === 'true') {
    const context = input(env, 'status-context', 'Kiro Reviewer');
    const runUrl =
      env.GITHUB_RUN_ID !== undefined
        ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repoName}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined;
    let warned = false;
    reportStatus = async (state, description) => {
      const ok = await gh.setStatus(pr.head.sha, {
        state,
        context,
        description,
        ...(runUrl ? { target_url: runUrl } : {}),
      });
      if (!ok && !warned) {
        warned = true;
        warn('Could not set the commit status; the workflow needs `statuses: write`.');
      }
    };
    await reportStatus('pending', 'Reviewing…');
  }
  return review(env, gh, pr);
}

async function review(env: Env, gh: Github, pr: PullRequestInfo): Promise<number> {
  // The key is sent to the endpoint, so both are validated before anything else runs.
  const bff = loadBffConfig({
    endpoint: input(env, 'endpoint'),
    region: input(env, 'region'),
    allowCustomEndpoint: input(env, 'allow-custom-endpoint', 'false') === 'true',
    apiKey: input(env, 'kiro-api-key') || env.KIRO_API_KEY,
  });
  console.log(`::add-mask::${escapeCommand(bff.apiKey)}`);
  const api = createReviewApi(bff);
  const headSha = pr.head.sha;
  const short = headSha.slice(0, 7);
  const baseLabel = REF_RE.test(`origin/${pr.base.ref}`) ? `origin/${pr.base.ref}` : pr.base.sha;

  // The base SHA from the event, not the branch name: any valid branch name works and the merge-base is stable.
  const repo = await collectRepo({
    repoPath: env.GITHUB_WORKSPACE ?? process.cwd(),
    base: pr.base.sha,
    includeUncommitted: false,
    contextFiles: [],
  });
  if (repo.headSha !== headSha) {
    throw new Error(
      'Checked-out HEAD is not the PR head. Check out github.event.pull_request.head.sha with fetch-depth: 0.',
    );
  }
  const diff = redactDiff(repo.diff);
  const { reviewRulesYaml: rawYaml, reviewMd: rawMd } = repo.rules;
  const rules = {
    ...(rawYaml !== undefined ? { reviewRulesYaml: redactText(rawYaml, 'REVIEW_RULES.yaml').text } : {}),
    ...(rawMd !== undefined ? { reviewMd: redactText(rawMd, 'REVIEW.md').text } : {}),
  };
  const intentText = redactText(`${pr.title}\n\n${pr.body ?? ''}`.trim(), 'intent').text;
  const intent = [...intentText].slice(0, LIMITS.intentChars).join('');
  const commits = repo.commits.map((c, i) => ({
    subject: redactText(c.subject, `commit[${i}].subject`).text,
    ...(c.body !== undefined ? { body: redactText(c.body, `commit[${i}].body`).text } : {}),
  }));

  const info = scanDiff(diff.text);
  const diffPaths = info.files.flatMap((f) => [f.path, ...(f.oldPath && f.oldPath !== f.path ? [f.oldPath] : [])]);

  const level = input(env, 'level', 'standard');
  if (level !== 'quick' && level !== 'standard' && level !== 'deep') {
    throw new Error('The level input must be quick, standard or deep.');
  }
  const budgetRaw = input(env, 'iteration-budget', String(LIMITS.iterationBudgetMax));
  const iterationBudget = Number(budgetRaw);
  if (!/^\d+$/.test(budgetRaw) || iterationBudget < 1 || iterationBudget > LIMITS.iterationBudgetMax) {
    throw new Error(`The iteration-budget input must be 1 to ${LIMITS.iterationBudgetMax}.`);
  }
  const contextRoundsRaw = input(env, 'context-rounds', String(LIMITS.contextRounds));
  let contextRounds = Number(contextRoundsRaw);
  if (!/^\d+$/.test(contextRoundsRaw) || contextRounds > LIMITS.contextRounds) {
    throw new Error(`The context-rounds input must be 0 to ${LIMITS.contextRounds}.`);
  }
  // The reviewer can request files by name only when it can see the tracked file names. Without a manifest it
  // cannot ask for anything, so a failed listing turns rounds off instead of failing the review.
  let manifest: string[] = [];
  if (contextRounds > 0) {
    try {
      manifest = buildManifest(await listTrackedFiles(repo.toplevel, headSha, false), diffPaths);
    } catch (e) {
      warn(`Could not list the tracked files (${errText(e)}); context rounds are off.`);
      contextRounds = 0;
    }
  }
  let context =
    input(env, 'include-changed-files', 'false') === 'true'
      ? await changedFileContext(repo.toplevel, headSha, info.files, LIMITS.contextTotalBytes)
      : [];

  checkPayloadLimits({
    diff: diff.text,
    diffFiles: info.files.length,
    diffPaths,
    changedLines: info.changedLines,
    manifest,
    context,
    rules,
    intent,
    ...(commits.length > 0 ? { commits } : {}),
  });

  // The PR's earlier review, from the sticky summary. Each push continues it while it has iterations left, so
  // findings keep their ids and come back NEW, PERSISTING or RESOLVED.
  let threads: FindingThread[] = [];
  let threadsReadable = true;
  try {
    threads = await gh.findingThreads();
  } catch (e) {
    threadsReadable = false;
    warn(`Could not read the review threads (${errText(e)}); replies are not sent and no inline comments are posted.`);
  }
  let priorId: string | null = null;
  try {
    const sticky = await gh.findBotComment(SUMMARY_MARKER);
    priorId = sticky ? reviewIdIn(sticky.body) : null;
  } catch (e) {
    warn(`Could not read the summary comment (${errText(e)}); starting a new review.`);
  }
  let prev: GetReviewResponse | null = null;
  if (priorId) {
    try {
      prev = await api.get(priorId);
    } catch (e) {
      notice(`Could not load the earlier review ${priorId} (${errText(e)}); starting a new review.`);
    }
  }
  let continueId = prev && prev.latestIteration < prev.iterationBudget ? prev.reviewId : null;
  if (prev && !continueId) {
    notice(`Review ${prev.reviewId} used all ${prev.iterationBudget} iterations; starting a new review.`);
  }

  // Skip when the same diff already has a clean, completed review under the same Kiro account, for example one
  // made locally. Only for a PR's first review. This is an optimisation: any failure falls through to a review.
  if (!priorId && input(env, 'skip-existing', 'true') === 'true') {
    let prior = null;
    try {
      prior = await findPriorReview({
        repo: repo.repoName,
        diff: diff.text,
        mergeBase: repo.mergeBase,
        level,
        rules,
        list: (nextToken) => api.list(nextToken),
        payload: (id, n) => api.payload(id, n),
        complete: async (id, n) => {
          const r = await api.get(id, n);
          const c = r.iteration.completeness;
          return (
            r.iteration.status === 'COMPLETED' &&
            c != null &&
            c.reviewersFailed.length === 0 &&
            !c.budgetExhausted &&
            !c.deadlineHit &&
            !c.nothingReviewable
          );
        },
      });
    } catch (e) {
      notice(`Could not check for an earlier review (${errText(e)}); reviewing instead.`);
    }
    if (prior && REVIEW_ID_RE.test(prior.reviewId)) {
      const body = renderSkipped(prior, headSha);
      await writeSummary(gh, env, body);
      await reportStatus('success', `Already reviewed (${prior.reviewId})`);
      setOutput(env, 'result', 'skipped-existing');
      setOutput(env, 'review-id', prior.reviewId);
      return 0;
    }
  }

  // People's replies on finding threads since the last iteration, sent as finding responses.
  const activeIds = new Set(
    (prev?.findings ?? []).filter((f) => f.state === 'NEW' || f.state === 'PERSISTING').map((f) => f.findingId),
  );
  const replies =
    continueId && threadsReadable
      ? buildResponses(threads, activeIds, prev?.iteration.createdAt ?? null, pr.user?.login ?? null)
      : [];

  /** The request for a new review (`reviewId` absent) or a resubmit, with context trimmed until it fits. */
  const fit = (reviewId: string | null, responses: FindingResponse[]) => {
    const build = () =>
      buildPayload({
        ...(reviewId ? { reviewId } : {}),
        level,
        iterationBudget,
        baseRef: baseLabel,
        mergeBase: repo.mergeBase,
        headRef: repo.headRef,
        headSha,
        includeUncommitted: false,
        diff: diff.text,
        rules,
        context,
        repo: repo.repoName,
        clientVersion: CLIENT_VERSION,
        // The token covers every input that changes the payload, so a re-run with other settings or new replies
        // is a new iteration, and a plain re-run replays the same one.
        clientToken: clientTokenFor(
          repo.repoName,
          repo.mergeBase,
          headSha,
          `${intent}|rounds=${contextRounds}|files=${context.map((c) => c.path).join(',')}|rev=${reviewId ?? ''}|` +
            `responses=${sha256Hex(canonicalJson(responses))}`,
        ),
        contextRounds,
        manifest,
        intent,
        ...(commits.length > 0 ? { commits } : {}),
        ...(responses.length > 0 ? { responses } : {}),
      });
    let payload = build();
    // Upfront context is optional: drop files from the end until the request fits, rather than skip the review.
    while (context.length > 0 && utf8Bytes(canonicalJson(payload)) > LIMITS.requestBytes) {
      context = context.slice(0, -1);
      payload = build();
    }
    checkRequestBytes(canonicalJson(payload));
    return payload;
  };

  /** Polls until the latest iteration is terminal. */
  const waitForTerminal = async (id: string, iteration?: number, onPoll?: (r: GetReviewResponse) => Promise<void>) => {
    const started = Date.now();
    for (;;) {
      const r = await api.get(id, iteration);
      if (TERMINAL_STATUSES.includes(r.iteration.status)) return r;
      if (onPoll) await onPoll(r);
      if (Date.now() - started > DEADLINE_MS) throw new Error(`Review ${id} did not finish within 15 minutes.`);
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
  };

  let submitted: SubmitResponse | null = null;
  if (continueId) {
    let responses = replies;
    for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
      try {
        submitted = await api.resubmit(continueId, fit(continueId, responses));
      } catch (e) {
        const code = serviceCode(e);
        if (code === 'VALIDATION_ERROR' && responses.length > 0) {
          warn('The thread replies could not be sent as finding responses; resubmitting without them.');
          responses = [];
        } else if (code === 'ITERATION_IN_PROGRESS' && attempt === 0) {
          notice(`An earlier iteration of ${continueId} is still running; waiting for it first.`);
          await waitForTerminal(continueId);
        } else if (code === 'ITERATION_BUDGET_EXHAUSTED' || code === 'NOT_FOUND' || code === 'ACCESS_DENIED') {
          notice(`Could not continue review ${continueId} (${code}); starting a new review.`);
          continueId = null;
          break;
        } else {
          throw e;
        }
      }
    }
    if (replies.length > 0 && submitted)
      notice(`Sent ${replies.length} thread repl${replies.length === 1 ? 'y' : 'ies'} to the reviewer.`);
  }
  if (!submitted) submitted = await api.create(fit(null, []));
  const reviewId = submitted.reviewId;
  if (!REVIEW_ID_RE.test(reviewId)) throw new Error('The service returned an unexpected review id.');
  console.log(
    `${continueId ? `Iteration ${submitted.iteration} of ${reviewId}` : `New review ${reviewId}`}: ` +
      `${info.files.length} files, ${utf8Bytes(diff.text)} bytes, ${context.length} context files, ` +
      `${manifest.length} manifest paths, up to ${contextRounds} context rounds.`,
  );

  const answeredRounds = new Set<number>();
  const result = await waitForTerminal(reviewId, submitted.iteration, async (r) => {
    const round = awaitingRound(r);
    if (round && !answeredRounds.has(round.round)) {
      answeredRounds.add(round.round);
      await respondToContext(r);
    }
  });

  /**
   * Sends the checkout's answers for an open round. Context is best-effort: any failure here is a warning and the
   * review goes on. If answering fails, every request is declined so the service does not wait out the window.
   */
  async function respondToContext(r: GetReviewResponse): Promise<void> {
    let body: ContextResponseRequest | null;
    try {
      body = await answerRound(repo.toplevel, headSha, r);
    } catch (e) {
      warn(`Could not answer the context round (${errText(e)}); declining it.`);
      body = declineRound(r);
    }
    if (!body) return;
    try {
      await api.respondContext(reviewId, r.iteration.number, body);
      const provided = body.responses.filter((x) => x.status === 'provided').length;
      notice(`Context round ${body.round}: provided ${provided} of ${body.responses.length} requested items.`);
    } catch (e) {
      warn(
        serviceCode(e) === 'CONTEXT_WINDOW_CLOSED'
          ? `Context round ${body.round} closed before the answer arrived; the review continues without it.`
          : `Could not send context round ${body.round} (${errText(e)}); the review continues without it.`,
      );
    }
  }

  setOutput(env, 'review-id', reviewId);
  // A FAILED review has no findings; passing it as clean would let a reviewer outage through the gate.
  if (result.iteration.status === 'FAILED') {
    fail(`Review ${reviewId} failed (${result.iteration.error?.code ?? 'unknown error'}); no findings were produced.`);
    await writeSummary(gh, env, renderSummary(result, [], 0, headSha));
    await reportStatus('failure', 'The review failed');
    setOutput(env, 'result', 'failed');
    return 1;
  }
  const partial = result.iteration.status === 'PARTIAL';
  if (partial) warn(`Review ${reviewId} is PARTIAL; findings may be incomplete.`);

  // Re-read the threads: a person may have resolved one while the review ran.
  if (threadsReadable) {
    try {
      threads = await gh.findingThreads();
    } catch (e) {
      threadsReadable = false;
      warn(`Could not re-read the review threads (${errText(e)}); no inline comments are posted.`);
    }
  }

  // A thread a person resolved suppresses its finding: recorded in the service, and dropped from the gate.
  let suppressed = 0;
  if (threadsReadable) {
    for (const { finding, resolvedBy } of applyResolved(result.findings, resolvedByPeople(threads))) {
      await api.suppress(reviewId, finding.findingId, resolvedReason(resolvedBy));
      suppressed++;
      notice(`Suppressed ${finding.findingId}: ${resolvedReason(resolvedBy)}.`);
    }
  }

  // One thread per finding across pushes: post only findings without a thread, and close threads whose finding is
  // gone after a complete review.
  const lines = commentableLines(diff.text);
  const complete = isComplete(result.iteration);
  const plan = threadsReadable ? planThreads(result.findings, threads, complete) : { toPost: [], toAutoResolve: [] };
  let autoResolved = 0;
  for (const t of plan.toAutoResolve) {
    try {
      await gh.autoResolveThread(
        t.id,
        `Kiro Reviewer no longer reports this at \`${short}\`, so this thread is closed. Reopen it if the issue is still there.`,
      );
      autoResolved++;
    } catch (e) {
      warn(`Could not close a fixed finding's thread (${errText(e)}).`);
    }
  }
  const { inline, inlineFindings } = splitFindings(plan.toPost, lines);
  const shown = inline.slice(0, MAX_INLINE);
  // The summary lists every active finding that has no inline thread: off the changed lines, over the inline cap,
  // or all of them when the threads could not be read.
  const posted = new Set(inlineFindings.slice(0, MAX_INLINE).map((f) => f.findingId));
  const threaded = new Set(threads.map((t) => t.findingId));
  const offLine = postableFindings(result.findings).filter(
    (f) => !posted.has(f.findingId) && !(threadsReadable && threaded.has(f.findingId)),
  );
  const summary = renderSummary(
    result,
    offLine,
    { posted: shown.length, suppressed, autoResolved },
    headSha,
    info.files,
  );
  await writeSummary(gh, env, summary);
  // Posted after the summary so the summary sits above the inline findings on a first run.
  if (shown.length > 0) {
    const marker = iterationMarker(headSha, reviewId, result.iteration.number);
    await gh.postReview(
      headSha,
      `${marker}\nInline comments for the ${shown.length} new finding${shown.length === 1 ? '' : 's'} at \`${short}\`. Totals are in the summary comment above.`,
      shown,
      marker,
    );
  }

  const blocking = postableFindings(result.findings).filter((f) => f.blocking).length;
  if (input(env, 'labels', 'true') === 'true') {
    const ok =
      blocking > 0 ? await gh.setLabel(LABEL_BLOCKING, LABEL_CLEAN) : await gh.setLabel(LABEL_CLEAN, LABEL_BLOCKING);
    if (!ok) warn('Could not update the PR labels; the workflow needs `issues: write` or `pull-requests: write`.');
  }
  setOutput(env, 'result', partial ? 'partial' : 'reviewed');
  setOutput(env, 'blocking', String(blocking));
  const enforce = input(env, 'fail-on-blocking', 'true') === 'true';
  if (blocking > 0 && enforce) {
    fail(`${blocking} blocking finding${blocking === 1 ? '' : 's'} in ${reviewId}.`);
    await reportStatus('failure', `${blocking} blocking finding${blocking === 1 ? '' : 's'}`);
    return 1;
  }
  await reportStatus(
    'success',
    blocking > 0
      ? `${blocking} blocking (not enforced)`
      : partial
        ? 'No blocking findings (partial review)'
        : 'No blocking findings',
  );
  return 0;
}

/** Edits the sticky summary and mirrors it to the job's step summary. A failed write is a warning. */
async function writeSummary(gh: Github, env: Env, body: string): Promise<void> {
  try {
    await gh.upsertComment(SUMMARY_MARKER, body);
  } catch (e) {
    warn(`Could not write the summary comment (${errText(e)}); the next push starts a new review.`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummaryText(body));
}

run(process.env).then(
  (code) => {
    process.exitCode = code;
  },
  async (e: unknown) => {
    if (e instanceof ToolError && e.code === 'EMPTY_DIFF') {
      notice('There are no changes to review.');
      setOutput(process.env, 'result', 'skipped-empty');
      await reportStatus('success', 'No changes to review');
      return;
    }
    // An unreviewed oversized PR must not look like a pass; fail unless the workflow opts out.
    if (e instanceof ToolError && e.code === 'LIMIT_EXCEEDED') {
      warn(`This pull request was NOT reviewed: ${e.message}`);
      setOutput(process.env, 'result', 'skipped-limit');
      const enforce = input(process.env, 'fail-on-skipped', 'true') === 'true';
      await reportStatus(enforce ? 'failure' : 'success', 'Too large to review');
      if (enforce) process.exitCode = 1;
      return;
    }
    fail(e instanceof Error ? e.message : String(e));
    await reportStatus('error', 'The review could not run');
    process.exitCode = 1;
  },
);
