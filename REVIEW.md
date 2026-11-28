# Review guidance

## README.md is written for customers

Everything in `README.md` is read by people outside the team who are setting up the action in their own repositories. When a PR changes `README.md`, review the new text from their point of view and flag:

- Internal names, links or details customers can't use: internal tools, wikis, design docs, ticket IDs, account IDs, internal endpoints or service-side implementation details.
- Examples that won't work as written: YAML that doesn't parse, inputs the action doesn't have, wrong defaults, or placeholders without instructions for filling them in.
- Steps that assume knowledge a new user doesn't have, or that skip a required setting such as a secret, permission or workflow trigger.
- Text that is inaccurate, vague or hard to follow: undefined jargon, claims the code doesn't support, or the same thing called by two names.
- Security guidance that is weakened or missing, such as using `pull_request_target`, pointing `uses:` at a branch instead of a release, or making a secret available to fork PRs.
