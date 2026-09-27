# TICKET-107 — Put boraoke's production secrets in the Credential Vault

**Filed:** 2026-09-27, from the TICKET-106 spike, which had to pull every production secret to disk to read three of them.
**Priority:** MED-HIGH — not an active leak, but the current path forces a bad one every time.
**Type:** Security hygiene
**Size:** S

## Why

boraoke has **no Credential Vault entry**. So an agent that legitimately needs a production credential — the TICKET-106 spike needed the Upstash REST URL and token to read the live `search.list` spend counter — has only one route: `vercel env pull`, which writes **every** production secret to a file on disk in order to read three of them.

That worked and was cleaned up properly this time: the spike never printed a value, shredded the file afterwards, and the TM verified independently that no env file remained and nothing env-shaped reached the branch. **The problem is that the safe outcome depended entirely on the agent being careful**, and the blast radius is disproportionate to the need — pulling the whole environment to read three values means every future credential read starts by putting the full set of production secrets on the filesystem.

The house already has the mechanism that avoids this: the **`vault`** skill reads a single credential through `scripts/vault.sh` and can inject it into a child process's environment without it ever touching disk or being echoed. boraoke simply isn't enrolled.

## What's needed

- Enrol boraoke's production credentials in the Credential Vault (`vault/vault.age`) with per-key entries, so an agent can request exactly the one it needs.
- At minimum the keys a spike or a gate realistically needs: the Upstash REST URL + token (live queue/room/spend-counter state) and the YouTube Data API key. Enumerate what production actually has before choosing — do not guess the set.
- Tier each key appropriately. The YouTube key meters a real paid-adjacent quota and the Upstash credentials reach live patron data (nicknames, queued titles), so weigh whether either warrants GATED tier rather than defaulting everything to the cheap tier.
- Record in the product's docs that `vercel env pull` is **not** the sanctioned read path for a single credential, so the next agent doesn't rediscover it as the only option.

## Constraints

- Use the **`handle-secret`** and **`vault`** skills throughout. Never print a value, never commit one, and delete any plaintext intermediate.
- This ticket touches real production credentials, so it does not get a speculative implementation: confirm what is in the production environment first, then enrol.
- Rotation is out of scope unless enrolment reveals a key that was exposed. If it does, that is a separate escalation, not a quiet fix.

## Acceptance

An agent needing one boraoke production credential can obtain it through the `vault` skill without writing any secret to disk, and `vercel env pull` is no longer required for a single-credential read.

## 2026-09-27 UPDATE — this is now BLOCKING a gate, and the obvious fix is the wrong one

The TICKET-108 App Tester gate came back **BLOCKED** on this. With no `YOUTUBE_API_KEY` available locally, `/api/search` returns `{"degraded":true,"reason":"no-api-key"}`, so the held result pool is always empty, so local narrowing can only ever starve-and-refetch — the environment reproduces the *old* per-keystroke behaviour and the new behaviour is unreachable. The tester correctly refused to mock the backend rather than report on a simulation. So five of the six things that gate exists to check cannot be exercised at all.

**The obvious unblock — enrol the production key and test with it — is a bad idea, and worth stating explicitly so nobody does it.** Every real search in a gate run spends from the **same 100-calls/day `search.list` bucket that is the bottleneck this whole line of work exists to relieve**. A gate run costing 10-20 calls is 10-20% of the daily cap, taken from the Tech Lead on a day he may be testing. Tests competing with production for the exact resource under conservation is a standing hazard, not a one-off inconvenience.

**What is actually needed: a SEPARATE test/dev YouTube Data API key, in its own Google Cloud project, with its own 100/day bucket.** Then a gate run costs nothing that production needs, and the two budgets can never interfere. This requires a Google Cloud console action, so it is a Tech-Lead / credentials item rather than something an agent can provision.

So this ticket now has two parts, and the second is the one blocking work:
1. Enrol boraoke's existing production credentials in the Vault (the original scope) — Upstash REST URL + token, the production YouTube key.
2. **Provision a separate test/dev YouTube Data API key and enrol that too**, and make it the key local/gate runs use. Until this exists, any gate touching live search is blocked-or-expensive, and "blocked" is the honest state rather than a gate that quietly tests nothing.
