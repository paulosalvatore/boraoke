# TICKET-117 — A value for `FEEDBACK_ADMIN_TOKEN` is committed on `main`, and that variable gates a live admin route

**Filed:** 2026-09-28, found during the TICKET-104 security work. **Not** introduced by any PR in flight — it is on `main` and in git history.
**Priority:** MED-HIGH pending one answer (below). Not an emergency; the repo is private.
**Type:** Security / credential hygiene
**Size:** S

## What

`work/reports/testing/TICKET-11-app-test.md:8` records a local run command containing a literal value for **`FEEDBACK_ADMIN_TOKEN`**.

That is not a made-up placeholder for a variable nothing reads. **`FEEDBACK_ADMIN_TOKEN` is consumed by shipped code**: `app/api/feedback/route.ts:76` compares a caller-supplied token against `process.env.FEEDBACK_ADMIN_TOKEN` to authorise the feedback admin path (the file's own header notes it is "never shipped to clients; fail-closed").

So a value for a real credential variable is sitting in a committed markdown file, and in git history.

## The one question that sets the severity — answer it first

**Does production set `FEEDBACK_ADMIN_TOKEN`, and if so, does it match the committed value?**

- **If production does not set it at all**, the route fails closed there and the committed string is a local-only dev value. Then this is hygiene: remove it, note it, done. **LOW.**
- **If production sets it to a different value**, same conclusion — the committed one is stale. **LOW.**
- **If production sets it to the committed value**, then a live admin credential is in the repo and in its history. **HIGH, and it gets rotated, not merely deleted** — deletion does not un-expose a credential that has been committed.

Check it by listing the production environment's variable **names** (`vercel env ls`) and comparing without printing either value. **Do not `vercel env pull`** — that writes every production secret to disk to read one, which is the practice TICKET-107 exists to stop.

## Why this was nearly waved through, which is the reusable part

`secret-scan.sh` has flagged this file, and it was assessed as benign by more than one agent on the way past — reasonably, since it looks like documentation of a dev command. The thing that changes the reading is one grep: **the variable is read by shipped code.** A credential-shaped string in a doc is noise; a credential-shaped string whose *variable name is consumed by an auth check* is a finding.

Worth making that the habit: when a scanner flags an env assignment, **grep the variable name against `app/` and `lib/` before calling it benign.** That is the check that distinguishes the two cases, and it takes seconds.

## What's needed

1. Answer the question above by comparing names/values without printing them.
2. **If live: rotate first**, then remove the value from the working tree. Whether to rewrite history is a Tech-Lead call — the repo is private, which lowers the urgency but does not make the value un-exposed.
3. **If not live:** replace the literal with a placeholder (e.g. `FEEDBACK_ADMIN_TOKEN=<your-local-token>`) and say in the doc that it is local-only.
4. While there: `work/evidence/TICKET-89/apptester-ticket-89.mjs` is also flagged, and that one **is** genuinely benign — it holds the documented `cantai-dev-host` dev fallback, which `lib/host-auth.ts` never uses in production. Leave it, and note it in the doc so the next scan does not re-litigate it.

## Constraints

- Use the **`handle-secret`** skill. Never print a value, never echo it into a report, never commit one.
- Rotation is an outward-facing action — it needs Tech-Lead authorisation before it happens, not after.
