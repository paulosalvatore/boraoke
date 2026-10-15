# TICKET-140 — Cyber Security gate (D-011) — PR #95

**Verdict: PASS-WITH-NOTES** (no BLOCKER, no HIGH; 1 MEDIUM, 3 LOW, INFO notes)

**Head audited:** `71a6d5e` on `ticket/140-paste-link`, worktree `.worktrees/t140-paste-link` (verified with `git rev-parse --short HEAD`).
**Scope:** `git diff origin/ticket/126-search-limits...HEAD` (stacked on PR #90), 29 files. Followed the data into `app/api/queue/route.ts` (full POST), `lib/embed-cache.ts`, `lib/queue-rate-limit.ts`, `lib/client-ip.ts`, `lib/host-auth.ts`, `vercel.json`, `.env.example`.
**Inputs read:** plan `work/plans/TICKET-140-plan.md`, dev report `work/reports/dev/TICKET-140-dev.md`, prior `work/reports/review/TICKET-61-cyber.md` (LOW-3 on the origin override).
**CI note:** boraoke has no `verify-green-local.sh`; per the TM brief only targeted jest and small probes were run (no build, no e2e, no server, no real key). The TM confirms the full green verdict before merge.

## Evidence run here

- Targeted jest, START 19:00:11 load 50.05, END 19:00:14 load 50.05: `npx jest __tests__/youtube.test.ts __tests__/api-video-meta.test.ts __tests__/api-queue.test.ts` → `Test Suites: 3 passed, 3 total`, `Tests: 134 passed, 134 total`.
- Parser probe (ts-node, transpile-only, on `lib/youtube.ts` and on the base branch's `lib/youtube.ts`), results quoted per finding below.
- Grep of every reader of `BORAOKE_E2E_STUBS`, `YOUTUBE_API_ORIGIN`, `YOUTUBE_OEMBED_ORIGIN` across the worktree (excluding `node_modules`, `.git`): runtime readers are only `lib/youtube.ts:237-272` and `:383`; others are `jest.env.ts`, `playwright.config.ts`, tests, docs and a stale `.next-apptest` server chunk.
- Client bundle check on the dev's existing `.next` build (18:41, contains the PR's `youtube-nocookie` string, so it is this PR's code): `grep -rl "local-stub-key\|YOUTUBE_API_KEY" .next/static` → empty; `grep -rlo "AIza…" .next/static .next/server` → empty.

## Focus items

### 1. `GET /api/video-meta` — OK

- **SSRF:** `v` must pass `isValidVideoId` (`^[A-Za-z0-9_-]{11}$`, `app/api/video-meta/route.ts:22`) before anything else. `fetchOEmbed` re-validates, uses a constant origin (`https://www.youtube.com`, or a loopback override, see item 2), a constant path `/oembed`, and puts the id into a fixed `https://www.youtube.com/watch?v=<id>` inside `URLSearchParams`. `redirect: "error"` (`lib/youtube.ts:388`). No user-controlled host or path anywhere.
- **Cache poisoning / key confusion:** key is `vm:<validated id>`; the id alphabet has no `:` or separators; the only other prefix in the codebase on this Redis is `ec:`. Values are written only from upstream answers for that same id (videos.list also checks `item.id === videoId`). Reads re-sanitise (`fromStored` → `cleanMetaText`, duration regex). The client cannot write the cache. Response is `Cache-Control: private`, so no shared CDN key.
- **Rate limit:** `videoMetaRateLimitOk(clientIpFrom(req))` (`route.ts:25`), imported from `@/lib/client-ip` — the same function `lib/host-auth.ts:453` re-exports for the queue route. 60/min/IP, per instance, LRU 2000 buckets, same shape as the submit limiter. Invalid ids 400 before charging, which is fine (no outbound work).
- **Size / timeouts:** 800 ms `AbortSignal.timeout`, which also aborts the body read. `res.json()` is not size-capped, but the host is fixed (INFO-1). Strings capped at 120/80 chars before caching or returning.
- **Error leakage:** 400 static string, 429 `{}`, every failure is `{}` 200. Nothing upstream is echoed.
- **Data API:** `resolveVideoTitle` calls cache + oEmbed only; confirmed by test "returns title + channel from oEmbed, with zero Data API calls".

### 2. e2e stub redirect — cannot activate in production — OK

`overrideAllowed()` (`lib/youtube.ts:237-240`) reads only `process.env`: `NODE_ENV !== "production"`, or `BORAOKE_E2E_STUBS === "1" && !VERCEL`. No request input reaches it (grep above: only `lib/youtube.ts` reads these vars at runtime). On the deployed site: Vercel always sets `VERCEL=1`, and `next start`/Vercel runs with `NODE_ENV=production`, so both branches are false. `vercel.json` sets no env; `.env.example` does not list the stub vars. Even if an operator set them by mistake: the override is honoured only for a loopback hostname (`127.0.0.1`, `localhost`, `[::1]`; `new URL().hostname` is compared exactly, so `127.0.0.1@evil.com` resolves to `evil.com` and is refused), and `videoApiKey()` (`:270`) substitutes `"local-stub-key"` whenever the API override is active, so the real key is never sent to a stub, in dev or in a local prod build. This closes the residual of TICKET-61 LOW-3. In the browser, the non-`NEXT_PUBLIC_` vars inline to `undefined`, so the client cannot activate it either.

### 3. Server trust — OK, with the ruling below

`source` now only feeds the `song_queued` telemetry label (`route.ts` around line 113); `lookupForSubmit` runs for every submit at `route.ts:223` regardless of `source`, `videoId` vs `youtubeUrl`, or any other field. No client field skips the embeddability check. Server title overwrites the client title whenever any lookup produced one (`route.ts:236`).

**Ruling on the last-resort client title: DROP IT** (LOW-1 below). The TM's lean is right.

### 4. Embeddability 422 and fail-open — OK

The 422 is a playback-quality refusal, not a moderation control. A fail-open (`unknown`) result lets the song continue into the unchanged path: the moderation branch (pending store) and `addEntry` both come after the lookup, so moderation still applies to every song. A patron cannot force a timeout on the server's outbound Google call, and an `unknown` verdict is cached for only 10 minutes. The worst a fail-open does is let a non-embeddable video in, which the TV watchdog skips, as before TICKET-61. The cache can't be poisoned to block a legitimate video: only Google's answer for that id writes `ec:`.

### 5. Parser (`lib/youtube.ts`) — look-alikes refused, but quadratic regex (MEDIUM-1)

Look-alike probe, all refused (`null`): `youtube.com.evil.com`, `evil.com/youtube.com/…`, `youtube.com@evil.com`, `youtu.be.evil.com`, `evilyoutu.be`, `youtube.com.` (trailing dot), `javascript:`, `ftp:`, `music.youtube.com.evil`, `xn--youtube-.com`, nocookie `/embed/<id>/extra`, `youtu.be/<id>/x`, 12-char `v`, `v=../../etc`, `%2e%2e%2f`, share text with `youtu.be/` inside another host's query. Accepted (host really is YouTube after WHATWG parsing, output is only the 11-char id): `evil.com@youtube.com` (userinfo), `youtube.com\@evil.com` (backslash = slash), full-width `ｙoutube.com` (IDNA). The parser's only output is a validated 11-char id, so a mis-parse can never steer a host. Words: `Imagination`, `unbreakable`, `BITTERSWEET`, `rock-n-roll` → null; `Blink182abc` → id (documented trade-off). Client and server import the same `parseYouTubeVideoId`.

The input is not length-capped before the regexes, and one of them is quadratic — see MEDIUM-1.

### 6. Quota — bounded as before (LOW-2)

A client can force a `videos.list` miss per submit by sending a fresh random 11-char id. That is bounded by the existing submit limiter (10/min/patronUuid, 60/min/IP, per instance) and was already possible before this PR, since a `youtubeUrl` body always counted as a paste. The PR does not widen the attacker's reach; it raises legitimate spend (every search pick on a miss). See LOW-2.

## Findings

### MEDIUM-1 — Quadratic regex on unbounded input, before the rate limit

- **Where:** `lib/youtube.ts:79` `stripSharePunctuation`: `.replace(/[)>\]}"'”’.,;:!?]+$/, "")`, reached from `parseYouTubeVideoId` (`:27` onward, no length cap), called by `POST /api/queue` at `app/api/queue/route.ts:103`, **before** the submit rate limit (`:145`), and by the patron's search box on every input.
- **Why:** a long run of trailing-set characters not followed by end-of-string backtracks at every start position (O(n²)). Measured on this head vs the base branch:

  | input | this PR | base |
  |---|---|---|
  | 4,000 `.` + `a` | 33.2 ms | 0.0 ms |
  | `youtu` + 4,000 `.` + `a b` (share path) | 30.1 ms | 0.0 ms |
  | 2,000 | 11.6 ms | 0.0 ms |
  | 512 | 0.8 ms | 0.0 ms |
  | 100,000 | 20,028 ms | — |

  The server body cap (4096 bytes, `route.ts` `MAX_BODY_BYTES`) limits a single request to about 33 ms CPU, but that is an unauthenticated, un-rate-limited amplification of roughly 30× over a normal parse on the hottest mutation route. On the client, there is no `maxLength`, so pasting about 100k characters freezes the patron's own tab for about 20 s (self-only).
- **Remediation:** cap the input before any regex (e.g. return `null` above 512 chars for the whole input, or above about 300 per token; a real share text is far below that). Also, or instead, make the trailing strip linear: a manual loop from the end, or `/[)>\]}"'”’.,;:!?]+$/` applied to `token.slice(-16)`. Add a regression test with a 4,000-char punctuation run and a time budget, proven to fail on the current code.

### LOW-1 — Patron-sent title as last resort: ruling DROP

- **Where:** `app/api/queue/route.ts:175` (entry built with client `title`), kept when `lookup.meta` is null (`:236` only overwrites).
- **Why:** the fallback is reachable on demand, not only during outages. A non-existent or private id makes oEmbed return 404 → `missing`, and `videos.list` return no item → `unknown`. Both lookups "fail", so an arbitrary 120-char string is stored and shown on the venue TV queue, the host view and the patron queue as the song's title. That contradicts the PR's "the stored title is server-derived". The impact is limited: React escapes it, the free-text `nickname` already reaches the TV, and before this PR every title was client-sent. So it is not a regression, but there is no reason to keep it. The display cost of dropping it is small: during a full YouTube outage a search pick shows `youtu.be/<id>` instead of its title.
- **Remediation:** ignore the body `title` for storage. Still validate its length or ignore it entirely, and store only `lookup.meta` fields. The `songLabel` fallback already renders `youtu.be/<id>`. Update the route test "client title only when every lookup failed" to assert that the client title is never stored.

### LOW-2 — Metadata-pool drain by distinct random ids (pre-existing bound, higher legitimate spend)

- **Where:** `lib/video-meta.ts` `lookupForSubmit` → `fetchVideoDetails` on every `ec:` miss; reached from `route.ts:223`.
- **Why:** one IP with rotating patronUuids can trigger 60 cache-missing `videos.list` calls per minute per instance (about 3,600 units/h/IP). The ~10k/day pool also feeds the nightly karaoke-index harvest (`playlistItems.list`) and search durations, so draining it degrades the index and those durations. Every outcome fails open; there is no security bypass. This is unchanged from TICKET-61/95 (a URL body was always a paste), so it is not introduced here. TICKET-67 tracks the cross-instance limiter.
- **Remediation (follow-up, not this PR):** a global daily budget for submit-path `videos.list` calls (e.g. a Redis counter, falling back to oEmbed-only once spent). Optionally, cache `unknown` for nonexistent ids (empty `items`) as a definite `missing` for a longer TTL.

### LOW-3 — `lib/youtube.ts` (imported by a client component) now reads `process.env.YOUTUBE_API_KEY`

- **Where:** `lib/youtube.ts:270-272` `videoApiKey()`, in the module `components/SongSearch.tsx` imports for the parser.
- **Why:** this is exactly the hazard TICKET-61's cyber report flagged. **No value leaks today:** Next inlines only `NEXT_PUBLIC_*`, and the built client chunks contain neither `YOUTUBE_API_KEY` nor `local-stub-key`, nor any `AIza…` string (checked on the PR's `.next` build). It relies on tree-shaking and naming conventions, though, rather than a hard guard.
- **Remediation (follow-up):** move `videoApiKey`, `fetchVideoDetails`, `fetchOEmbed` and the override logic into a `lib/youtube-server.ts` with `import "server-only"` (as `lib/video-meta.ts` already does), and leave the parser in the shared module.

### INFO

- **INFO-1:** `res.json()` in `fetchVideoDetails` / `fetchOEmbed` has no byte cap. Both hosts are fixed Google origins and the 800 ms timeout bounds the read, so this is acceptable. `fetchVideoDetails` follows redirects (no `redirect: "error"`, unlike oEmbed); the host is fixed, so this is consistency only.
- **INFO-2:** `/api/video-meta` can be used as a rate-limited oEmbed relay with random ids (60/min/IP/instance). The worst case is YouTube throttling the egress IP's oEmbed, which degrades previews and submit-path title fallback. Acceptable.
- **INFO-3:** worst-case submit hold on a full miss is now about 1.6 s (800 ms videos.list + 800 ms oEmbed), up from 0.8 s. It sits after the rate limit and `checkSubmit`. Acceptable; noted for the Reviewer.

## Friction

- The same "parser regex without a length cap" pattern has appeared before. Proposed class-level guardrail: a `prove-your-test-can-fail` addendum, or a reviewer checklist line, saying that any new regex on untrusted text gets a length cap before matching plus a pathological-input timing test.
