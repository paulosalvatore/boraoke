# TICKET-123 — CI only triggers on `pull_request`, so nothing ever re-verifies `main`

**Filed:** 2026-09-28, from the TICKET-116 review, which corrected that ticket's own premise.
**Priority:** MED — three-line change, and it is the actual gap TICKET-116 was reaching for.
**Type:** CI
**Size:** XS

## What

`.github/workflows/ci.yml` declares exactly one trigger:

```yaml
on:
  pull_request:
    branches: [main]
```

Verified: **every workflow run in this repository's history is a `pull_request` event.** There has never been a run against `main` itself.

So the suite gates changes *entering* `main` and never checks `main` afterwards. Anything that becomes true only after a merge — an interaction between two PRs that were each green alone, a semantic conflict a clean textual merge hides, or a change to a shared fixture — is invisible.

## Why it matters

This is the **narrow, real version** of the gap TICKET-116 wrongly described as "nothing runs the e2e suite". The suite *is* run, on every PR, and those runs pass. What is missing is the post-merge check, and a post-merge check is the only thing that can catch a merge-introduced problem.

Concretely: two PRs can each be green against `main` at review time and conflict semantically once both have landed. `git` reports no conflict, both gates were green, and nothing runs again. On this product that is not hypothetical — five PRs merged in a single day, several touching the same TV surface and the same e2e helpers.

## What's needed

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
```

Then decide what happens when a post-merge run fails, because a red `main` nobody looks at is barely better than no run:

- At minimum it must be **visible** — the run's failure should reach whoever is on that product, not just sit in the Actions tab.
- Consider whether a post-merge failure should block the next merge, or simply raise a loud signal. Blocking is stronger but can wedge a product behind an unrelated flake; **note that TICKET-116 makes the suite deterministic enough for blocking to be reasonable**, which it was not before.

## Constraints

- The suite now runs against a production build (TICKET-116), so a `push` run costs a build. Check the current runtime (~4 minutes on a runner) against how often `main` moves; on this product that was 26 commits in one day, so **consider whether every push needs a run or whether it should be debounced**, and weigh the Actions-minutes cost deliberately rather than by default.
- **Do not add the trigger without deciding the failure path.** An unwatched red `main` is how TICKET-116's situation persisted.

## Acceptance

`main` is verified after every merge (or on a deliberate, documented cadence), and a failure is surfaced to a human rather than only recorded.
