# Kiro Reviewer GitHub Action

Reviews pull requests with the Kiro Reviewer service. It posts findings as inline comments with one summary comment, keeps a single review going across pushes, and lets people answer findings in the PR: resolve a thread to accept a finding, reply to explain one, or comment `/kiro-review` to re-run. It talks to the Kiro service with a Kiro API key.

## What it does

1. Skips fork PRs (no credentials are shared with forks) and, by default, drafts (`skip-drafts`). A draft is reviewed when it is marked ready, or on a `/kiro-review` comment.
2. Builds the review payload: the merge-base diff (redacted), with 50 lines of context around each change (`git diff -U50`, or `-U3` if that is over the diff size limit), `REVIEW.md` from the base commit, commit messages, the PR title and body as `intent`, and context (see below).
3. **Continues the PR's review.** The summary comment records the review id. Each push sends a new iteration of that review, so findings keep their ids and come back `NEW`, `PERSISTING` or `RESOLVED`. When the review has used its `iteration-budget` (default 5), the next push starts a new one.
4. **Skip check**, on a PR's first review only: if the same diff already has a clean, completed review under the same Kiro account (for example one made locally), it says so in the summary and stops. It requires the same repo name, merge-base, `REVIEW.md` and a level at least as deep, plus a complete review. Any error in the check is a notice, and the review proceeds.
5. Posts an inline comment only for findings that have no thread yet, closes threads whose finding is gone, and edits the one summary comment in place.
6. Sets a commit status (`Kiro Reviewer`), labels the PR `kiro-review: blocking` or `kiro-review: clean`, and writes the summary to the job's step summary.
7. Fails when unsuppressed blocking findings remain (`fail-on-blocking`), and when the review itself FAILED. A PARTIAL review posts with a warning annotation.

A diff over the service limits (1 MB, 50 files, 8,000 changed lines) is not reviewed. The job gets a warning annotation, `result=skipped-limit`, and fails unless `fail-on-skipped: false`, so padding a PR cannot dodge review. An empty diff passes with `result=skipped-empty`.

## Context

The reviewer sees more than the diff:

- **Changed files** (`include-changed-files`, default on): the full post-change contents of the modified and renamed files, up to 20 files, 100 KB per file and 200 KB in total. Added files are not attached, since the diff already carries them whole. Deleted, binary, secret-like and non-text files are skipped. If the request would exceed 2 MB, files are dropped from the end rather than skipping the review.
- **Context rounds** (`context-rounds`, default 2): the action sends the tracked file names (no content), and the reviewer may ask for files, line ranges or searches. A search is a POSIX extended regex (`git grep -E`, so `\w`/`\d` shorthand is not supported; use `[[:alnum:]]` classes) over the checkout, and a plain string matches literally. The action answers each round automatically; there is no human approval step in CI. Secret-like paths, paths outside the repository and non-text files are still refused, and every answer is redacted.

Both send repository content to the review service. Set `context-rounds: 0` and `include-changed-files: false` to send only the diff, `REVIEW.md`, commit messages and PR text.

## Review guidance

Put review guidance for your repository in a `REVIEW.md` at the repository root: conventions, areas to watch, things to ignore. The action reads it from the merge-base, not the PR head, so a PR cannot change the guidance it is reviewed against. An edit to `REVIEW.md` is reviewed as part of the diff and applies to later PRs once it merges. The file is redacted before it is sent and must be at most 128 KB.

## The review conversation

**Accept a finding: resolve its thread.** The next run suppresses the finding in the service (reason `Resolved on GitHub by <login>`) and leaves it out of the gate. GitHub has no workflow event for resolving a thread, so comment `/kiro-review` or push to update the check.

**Explain or dispute a finding: reply in its thread.** On the next push, the newest reply per finding is sent to the reviewer as a finding response. The wording picks the disposition: "fixed", "false positive", "won't fix" or "by design", "follow-up" or "later", and anything else is a question. The reviewer answers in its next iteration. A reply never clears a blocking finding on its own; resolving the thread does that. Only replies from owners, members, collaborators and the PR author count, and replies are redacted and capped at 1,000 characters.

**Commands**, as the first line of a PR comment, from owners, members and collaborators:

| Command                                  | Effect                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `/kiro-review` or `/kiro-review recheck` | Re-runs the review on the PR head and updates the check.                |
| `/kiro-review pause`                     | Stops reviewing new pushes on this PR. The last status stays as it was. |
| `/kiro-review resume`                    | Starts reviewing again.                                                 |

The action reacts 👀 to a command it runs and 😕 to one it ignores. The prefix is `/kiro-review`, not `/kiro`, because the Kiro GitHub app already answers `/kiro …` commands.

**Threads.** A finding gets one inline thread for its whole life: finding ids are content fingerprints, so a later push or a new review finds the existing thread. When a complete review no longer reports a finding, the action replies "no longer reports this" and resolves the thread. Those threads do not suppress anything, and a thread someone reopens is not closed again. Each comment carries hidden markers (`<!-- kiro-finding:f-… -->`) and only threads started by a bot count, so a user cannot suppress a finding with a comment of their own. Each comment also has a collapsed **Prompt for AI agents** to paste into a coding agent. It tells the agent to verify the claim, because the finding is model output.

Anyone who can resolve a thread, including the PR author, can clear a blocking finding. The service keeps the suppression and its reason. If the threads cannot be read, the action warns, suppresses nothing, and lists every finding in the summary instead of posting inline.

## Auth

The Action calls the Kiro service with a **Kiro API key**. Store it as a secret of a protected environment, not as a repository secret:

1. Create an environment (for example `kiro-review`) under **Settings → Environments** and add **required reviewers**.
2. Save the key there: `gh secret set KIRO_API_KEY --env kiro-review`.
3. Reference the environment from the review job (`environment: kiro-review`, as in the workflow below).

A `pull_request` workflow runs the pull request's own copy of the workflow file, so anyone who can push a branch can edit it to read a repository secret. An environment secret is released only after a required reviewer approves the run.

```yaml
- uses: kirodotdev/kiro-reviewer-action@<release-commit-sha> # v1
  with:
    kiro-api-key: ${{ secrets.KIRO_API_KEY }}
```

- The key identifies you, so the review belongs to your Kiro account. The skip check finds your own earlier reviews, such as one made locally, and no one else's.
- The request is Smithy RPC v2 CBOR to `https://app.kiro.dev/service/KiroWebBearerService/operation/<Operation>` with `Authorization: Bearer <key>` and `TokenType: API_KEY`. `endpoint` accepts only Kiro origins (`https://app.kiro.dev`, `https://eu-central-1.app.kiro.dev`). Another bare https origin needs `allow-custom-endpoint: true`, so a workflow edit cannot quietly send the key elsewhere. The key is sent only to the endpoint, and redirects are refused: if the endpoint answers with a redirect to a sign-in page, the job fails with `REDIRECT` and the host it pointed at.
- **Region.** The default is `us-east-1` (`https://app.kiro.dev`). For Frankfurt, set `region: eu-central-1` (or `region: fra`), which uses `https://eu-central-1.app.kiro.dev`. `endpoint` overrides `region`; setting both to different hosts is an error.
- The key is masked in the job log. It is not written anywhere else.
- It uses the operations `CreateCodeReview`, `UpdateCodeReview`, `ListCodeReviews`, `GetCodeReview`, `UpdateCodeReviewFinding`, `UpdateCodeReviewContext` and `GetCodeReviewIterationPayload`.

## Repo name

The skip check compares the repository directory name (`basename` of the checkout), which is also what a review from a local clone sends. A clone whose directory name differs from the GitHub repo name will not match.

## Workflow

```yaml
name: Kiro Reviewer
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write # labels and the summary comment
  statuses: write # the Kiro Reviewer commit status
concurrency:
  group: kiro-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
jobs:
  review:
    if: >-
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '/kiro-review'))
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: kiro-review # holds KIRO_API_KEY; requires reviewer approval
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: kirodotdev/kiro-reviewer-action@<release-commit-sha> # v1
        with:
          kiro-api-key: ${{ secrets.KIRO_API_KEY }}
```

- Use `pull_request`, never `pull_request_target`. The checkout must have full history (`fetch-depth: 0`).
- **Pin every action to a full commit SHA**, including this one. A tag such as `v1` can be moved, and the job runs whatever it points to with your key. Each release lists its commit SHA.
- Protect `.github/` with a CODEOWNERS entry and branch protection that requires code owner review, so workflow changes need an owner's approval.
- For a `/kiro-review` comment, `ref` is empty, so the default branch is checked out and the action switches the workspace to the PR head. It only reads that code. Do not add later steps that run code from the workspace.
- GitHub runs `issue_comment` workflows from the **default branch**, so commands work only once this workflow is there.
- **Make the gate required with the commit status, not the job.** In branch protection, require the `Kiro Reviewer` status. A run started by a comment is not a PR check, but it updates the status, and a push updates it too.

## Recipes

Report only, never fail the build:

```yaml
- uses: kirodotdev/kiro-reviewer-action@<release-commit-sha> # v1
  with:
    kiro-api-key: ${{ secrets.KIRO_API_KEY }}
    fail-on-blocking: false
```

Review one service in a monorepo (the paths filter applies to pushes; commands still run):

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths: ['services/payments/**']
```

Faster, cheaper reviews with no extra context:

```yaml
with:
  level: quick
  context-rounds: 0
  include-changed-files: false
```

Review drafts too: `skip-drafts: false`. No labels or status: `labels: false`, `commit-status: false`.

## Build and publish

`npm run build` writes `dist/index.mjs`, which the action runs. `dist/` is committed, as GitHub runs JavaScript actions without installing dependencies, so rebuild and commit it with every source change.

`npm run smoke` runs the built bundle end to end against a fake Kiro service (TLS, CBOR) and a fake GitHub API on 127.0.0.1: a first review with a context round, then a later push with a reply and a resolved thread. It needs `openssl` and disables TLS verification for the child process only.

## Known limitations

- The request and reply shapes are written by hand in `src/reviewApi.ts`, not generated from the service model. A model change will not fail the build. Timestamps arrive as epoch milliseconds and are converted to ISO strings there.
- GitHub retries: GETs retry 429, 5xx and network errors three times, but ignore `Retry-After`. The review POST is never blindly retried; after a 5xx or network error the action checks for its marker first.
- The skip check scans the newest 25 reviews and compares up to 10 stored payloads. A `repo` and diff-digest filter on `GET /reviews` would make it one call.
- Suggestions are prose. Committable ` ```suggestion ` blocks need the service to return a replacement for the exact lines.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. Third-party licenses are in `THIRD-PARTY-NOTICES`.
