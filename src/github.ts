// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolvedByPeople } from './conversation.js';
import { findingIdIn, markerFor, safePath } from './lib.js';

/** Reply marker on threads this action resolved because their finding is gone; these do not suppress anything. */
export const AUTO_RESOLVED_MARKER = '<!-- kiro-auto-resolved -->';

export interface ThreadReply {
  login: string;
  /** GitHub author association, e.g. OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE. */
  association: string;
  body: string;
  createdAt: string;
}

export interface FindingThread {
  id: string;
  findingId: string;
  isResolved: boolean;
  resolvedBy: string | null;
  /** This action resolved the thread because the finding no longer appeared. */
  autoResolved: boolean;
  /** Replies by people (bots excluded), oldest first. */
  replies: ThreadReply[];
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  user?: { login: string } | null;
  base: { ref: string; sha: string; repo: { full_name: string } | null };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

export interface CommitStatus {
  state: 'pending' | 'success' | 'failure' | 'error';
  context: string;
  description: string;
  target_url?: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `: TYPE: message` from the first GraphQL error, for the warning. GitHub's text names the denied resource or
 * permission, not request data; it is still bounded and stripped of control characters.
 */
export function graphqlReason(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const e = (errors[0] ?? {}) as { type?: unknown; message?: unknown };
  const parts = [e.type, e.message].filter((x): x is string => typeof x === 'string' && x !== '');
  if (parts.length === 0) return '';
  // eslint-disable-next-line no-control-regex
  const text = parts.join(': ').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return `: ${text.length > 200 ? `${text.slice(0, 199)}…` : text}`;
}

interface Reply {
  status: number;
  json: unknown;
}

export class Github {
  constructor(
    private readonly api: string,
    private readonly token: string,
    private readonly repo: string,
    private readonly pr: number,
    private readonly io: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> } = { fetch, sleep },
    private readonly graphqlUrl: string = `${api}/graphql`,
  ) {}

  /**
   * One request. GETs retry 429, 5xx and network errors (3 attempts, 1s then 2s). A POST is sent once: a 5xx or a
   * timeout does not say whether GitHub applied it, so the caller decides (see `send`). `retry` overrides this for
   * read-only POSTs such as GraphQL queries. An absolute URL is used as is.
   */
  private async call(method: string, path: string, body?: unknown, retry = method === 'GET'): Promise<Reply> {
    let last: Reply = { status: 0, json: null };
    const attempts = retry ? 3 : 1;
    const url = /^https?:\/\//.test(path) ? path : `${this.api}${path}`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.io.sleep(1_000 * 2 ** (attempt - 1));
      try {
        const res = await this.io.fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          // Non-JSON error body.
        }
        last = { status: res.status, json };
        if (res.status !== 429 && res.status < 500) return last;
      } catch {
        last = { status: 0, json: null };
      }
    }
    return last;
  }

  /** True when a review authored by a bot (the workflow token) already carries the marker. Paginates. */
  async hasMarker(marker: string): Promise<boolean> {
    for (let page = 1; page <= 10; page++) {
      const r = await this.call('GET', `/repos/${this.repo}/pulls/${this.pr}/reviews?per_page=100&page=${page}`);
      if (r.status !== 200 || !Array.isArray(r.json)) {
        throw new Error(`Could not list the PR reviews (HTTP ${r.status}).`);
      }
      const reviews = r.json as Array<{ body?: unknown; user?: { type?: unknown } | null }>;
      if (reviews.some((x) => x.user?.type === 'Bot' && typeof x.body === 'string' && x.body.includes(marker)))
        return true;
      if (reviews.length < 100) return false;
    }
    return false;
  }

  /**
   * Every inline review thread on the PR started by a bot comment that carries a finding marker. Throws when the
   * threads cannot be read, so callers fail closed.
   */
  async findingThreads(): Promise<FindingThread[]> {
    const [owner, name] = this.repo.split('/');
    const query = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              resolvedBy { login }
              comments(first: 50) {
                nodes { body createdAt authorAssociation author { __typename login } }
              }
            }
          }
        }
      }
    }`;
    type Threads = {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string;
        isResolved: boolean;
        resolvedBy: { login: string } | null;
        comments: {
          nodes: Array<{
            body: string;
            createdAt: string;
            authorAssociation: string;
            author: { __typename: string; login: string } | null;
          }>;
        };
      }>;
    };
    const out: FindingThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await this.call(
        'POST',
        this.graphqlUrl,
        { query, variables: { owner, name, pr: this.pr, after } },
        true,
      );
      const threads = (r.json as { data?: { repository?: { pullRequest?: { reviewThreads?: Threads } } } } | null)?.data
        ?.repository?.pullRequest?.reviewThreads;
      if (r.status !== 200 || !threads) throw new Error(`Could not read the PR review threads (HTTP ${r.status}).`);
      for (const t of threads.nodes) {
        const [first, ...replies] = t.comments.nodes;
        if (first?.author?.__typename !== 'Bot') continue;
        const findingId = findingIdIn(first.body);
        if (!findingId) continue;
        out.push({
          id: t.id,
          findingId,
          isResolved: t.isResolved,
          resolvedBy: t.resolvedBy?.login ?? null,
          autoResolved: replies.some((c) => c.author?.__typename === 'Bot' && c.body.includes(AUTO_RESOLVED_MARKER)),
          replies: replies
            .filter((c) => c.author !== null && c.author.__typename !== 'Bot')
            .map((c) => ({
              login: c.author!.login,
              association: c.authorAssociation,
              body: c.body,
              createdAt: c.createdAt,
            })),
        });
      }
      if (!threads.pageInfo.hasNextPage) break;
      after = threads.pageInfo.endCursor;
    }
    return out;
  }

  /** Finding ids whose thread a person resolved, mapped to who resolved it. Threads this action closed do not count. */
  async resolvedFindings(): Promise<Map<string, string>> {
    return resolvedByPeople(await this.findingThreads());
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<void> {
    const r = await this.call('POST', this.graphqlUrl, { query, variables });
    const errors = (r.json as { errors?: unknown[] } | null)?.errors;
    if (r.status !== 200 || (Array.isArray(errors) && errors.length > 0)) {
      throw new Error(`GitHub GraphQL call failed (HTTP ${r.status}${graphqlReason(errors)}).`);
    }
  }

  /**
   * Resolves the thread, then replies with the auto-resolve marker. Resolving first means a refused resolve (for
   * example a token without the needed permission) adds no reply, so retries on later pushes do not stack replies.
   */
  async autoResolveThread(threadId: string, note: string): Promise<void> {
    await this.graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }`, {
      id: threadId,
    });
    await this.graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { clientMutationId }
      }`,
      { id: threadId, body: `${AUTO_RESOLVED_MARKER}\n${note}` },
    );
  }

  /** The newest issue comment by a bot that contains `marker`, or null. Reads up to 1,000 comments. */
  async findBotComment(marker: string): Promise<{ id: number; body: string } | null> {
    let found: { id: number; body: string } | null = null;
    for (let page = 1; page <= 10; page++) {
      const r = await this.call('GET', `/repos/${this.repo}/issues/${this.pr}/comments?per_page=100&page=${page}`);
      if (r.status !== 200 || !Array.isArray(r.json)) {
        throw new Error(`Could not list the PR comments (HTTP ${r.status}).`);
      }
      for (const c of r.json as Array<{ id: number; body?: unknown; user?: { type?: unknown } | null }>) {
        if (c.user?.type === 'Bot' && typeof c.body === 'string' && c.body.includes(marker)) {
          found = { id: c.id, body: c.body };
        }
      }
      if (r.json.length < 100) break;
    }
    return found;
  }

  /** Creates the bot's sticky comment (identified by `marker`) or edits it in place. */
  async upsertComment(marker: string, body: string): Promise<void> {
    const existing = await this.findBotComment(marker);
    const r = existing
      ? await this.call('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body })
      : await this.call('POST', `/repos/${this.repo}/issues/${this.pr}/comments`, { body });
    if (r.status < 200 || r.status >= 300) throw new Error(`Could not write the PR comment (HTTP ${r.status}).`);
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    const r = await this.call('GET', `/repos/${this.repo}/pulls/${this.pr}`);
    if (r.status !== 200 || r.json === null) throw new Error(`Could not read the pull request (HTTP ${r.status}).`);
    return r.json as PullRequestInfo;
  }

  /** Best-effort extras: a failure is reported to the caller, never thrown. */
  async react(commentId: number, content: 'eyes' | '+1' | 'confused'): Promise<boolean> {
    const r = await this.call('POST', `/repos/${this.repo}/issues/comments/${commentId}/reactions`, { content });
    return r.status >= 200 && r.status < 300;
  }

  async setStatus(sha: string, status: CommitStatus): Promise<boolean> {
    const r = await this.call('POST', `/repos/${this.repo}/statuses/${sha}`, {
      ...status,
      description: status.description.slice(0, 140),
    });
    return r.status >= 200 && r.status < 300;
  }

  /** Puts `add` on the PR and takes `remove` off. */
  async setLabel(add: string, remove: string): Promise<boolean> {
    const added = await this.call('POST', `/repos/${this.repo}/issues/${this.pr}/labels`, { labels: [add] });
    const removed = await this.call(
      'DELETE',
      `/repos/${this.repo}/issues/${this.pr}/labels/${encodeURIComponent(remove)}`,
    );
    return added.status >= 200 && added.status < 300 && (removed.status < 300 || removed.status === 404);
  }

  /**
   * POSTs a review without creating duplicates. 429 is retried after a backoff (GitHub did not process it). After a
   * 5xx or a network error the review may or may not exist, so the marker is checked first: found means done,
   * not found means it is safe to try again.
   */
  private async send(url: string, payload: unknown, marker: string): Promise<Reply> {
    let last: Reply = { status: 0, json: null };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await this.io.sleep(1_000 * 2 ** (attempt - 1));
      last = await this.call('POST', url, payload);
      if (last.status >= 200 && last.status < 300) return last;
      if (last.status === 429) continue;
      if (last.status === 0 || last.status >= 500) {
        if (await this.hasMarker(marker)) return { status: 200, json: null };
        continue;
      }
      return last;
    }
    return last;
  }

  /**
   * Posts one review. Inline comments GitHub rejects (422) are folded into the body; other failures throw. `marker`
   * must be in `body`: it identifies this post when checking whether a failed POST landed anyway.
   */
  async postReview(
    headSha: string,
    body: string,
    comments: Array<{ path: string; line: number; side: string; body: string }>,
    marker: string = markerFor(headSha),
  ): Promise<void> {
    const url = `/repos/${this.repo}/pulls/${this.pr}/reviews`;
    const first = await this.send(url, { commit_id: headSha, body, event: 'COMMENT', comments }, marker);
    if (first.status >= 200 && first.status < 300) return;
    if (first.status !== 422 || comments.length === 0) {
      throw new Error(`GitHub review post failed (HTTP ${first.status}).`);
    }
    const folded = comments.map((c) => `**\`${safePath(c.path)}:${c.line}\`**\n\n${c.body}`).join('\n\n---\n\n');
    const second = await this.send(
      url,
      { commit_id: headSha, body: `${body}\n\n${folded}`.slice(0, 60_000), event: 'COMMENT' },
      marker,
    );
    if (second.status < 200 || second.status >= 300) {
      throw new Error(`GitHub review post failed (HTTP ${second.status}).`);
    }
  }
}
