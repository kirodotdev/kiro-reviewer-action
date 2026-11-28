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
