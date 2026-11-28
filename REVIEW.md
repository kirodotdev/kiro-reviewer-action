# Review guidance

## Keep README.md in sync with the code

`README.md` is the action's only user documentation. When a PR changes user-visible behavior without updating `README.md` to match, flag it. Name the README section that is now wrong or missing.

Check these pairs:

- `action.yml` inputs and outputs, including names, defaults and descriptions, against the **Action inputs** table and any recipe that uses them.
- Size and count limits in `src/limits.ts` (diff size, file counts, changed lines, changed-file attachments, rule-file sizes) against the numbers in **What code does Kiro receive?**, **Why was a review skipped?** and **Give Kiro repository-specific guidance**.
- What `src/collect/` sends to the service against **What code does Kiro receive?**.
- Skip and result paths in `src/main.ts` (`skipped-*` results, fork and draft handling, paused reviews) against **Why was a review skipped?** and **Review drafts automatically**.
- `/kiro-review` commands in `src/conversation.ts` and how threads and replies are handled against **Work with review findings**.
- Rule files the action reads (`REVIEW.md`, `REVIEW_RULES.yaml`) and their supported fields against **Give Kiro repository-specific guidance**.
- Endpoint, region and authentication handling against **Use the Frankfurt region**, **Add your Kiro API key to GitHub** and **Optional: use a protected environment**.
- The required workflow triggers and permissions against the workflow in **Add the workflow**.

Also flag README examples that no longer match the code, such as YAML that sets a removed or renamed input.

Internal refactors, tests and changes with no user-visible effect don't need README changes.

## README.md is written for customers

Everything in `README.md` is read by people outside the team who are setting up the action in their own repositories. When a PR changes `README.md`, review the new text from their point of view and flag:

- Internal names, links or details customers can't use: internal tools, wikis, design docs, ticket IDs, account IDs, internal endpoints or service-side implementation details.
- Examples that won't work as written: YAML that doesn't parse, inputs the action doesn't have, wrong defaults, or placeholders without instructions for filling them in.
- Steps that assume knowledge a new user doesn't have, or that skip a required setting such as a secret, permission or workflow trigger.
- Text that is inaccurate, vague or hard to follow: undefined jargon, claims the code doesn't support, or the same thing called by two names.
- Security guidance that is weakened or missing, such as using `pull_request_target`, pointing `uses:` at a branch instead of a release, or making a secret available to fork PRs.
