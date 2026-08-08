# TICKET-76 — Saved rooms should open straight into admin

## Reported

> "Open admin button should open with the code already set automatically."

In the landing page's "Suas salas" card, the `Admin` link for a created room lands on `/<room>/admin?expired=1`, which shows the login gate and makes the host retype the host code.

## Diagnosis

Nothing was broken. The behaviour was the designed one, and the reason it hurt is a lifetime, not a bug.

- The host session cookie had a **12-hour** TTL (`SESSION_MAX_AGE_SECONDS`, `lib/host-auth.ts`). A host who ran a venue night on Friday was genuinely logged out by Saturday.
- `?expired=1` is set only on a positive 401 from the session probe (`components/SavedRooms.tsx`). It carries **no auth meaning** — it is purely a copy hint so the gate can say "sua sessão expirou" instead of a bare login form.
- The host code is **deliberately never persisted anywhere**. `lib/room-memory.ts` carries a load-bearing SECURITY INVARIANT: `RememberedRoom` has no host-code field and `rememberCreatedRoom` defensively strips any `hostCode`-shaped property. Server-side only `hostCodeHash` is stored (`lib/rooms.ts`, `lib/host-auth.ts`). The raw code exists exactly once, in the `POST /api/rooms` response rendered by `/new`.

## The literal request was rejected

The Tech Lead asked for the code to be prefilled/auto-set. That is not implementable safely, and was rejected on two independent grounds.

**The host code is a non-rotatable permanent credential.** Because only its hash is stored, the raw code can never be recovered or reissued to the legitimate host. A leak is therefore permanent and unrevocable — there is no "reset the code" path to fall back on.

1. **Never put the host code in a URL.** It leaks through browser history, the `Referer` header to third parties, shared or screenshotted links, and server/proxy access logs. Combined with the non-rotatability above, one screenshot of an address bar is a permanent room takeover.
2. **Never store the host code in `localStorage`.** That breaks the documented invariant and converts any XSS on the origin from a bounded session theft into permanent, unrevocable room takeover.

## What was implemented instead

A **rolling 30-day session**.

1. `SESSION_MAX_AGE_SECONDS` raised from `60 * 60 * 12` to `60 * 60 * 24 * 30`.
2. The session is now **rolling**: a *successful* `GET /api/host/session` re-sets the cookie it just verified with a fresh 30-day window. Both the admin dashboard (`AdminRoom.checkSession()`) and the landing page's "Suas salas" probe hit that endpoint, so a host who keeps using their room never falls out of the window.
3. Every cookie hardening attribute is unchanged: `httpOnly`, `path=/api/host`, `sameSite=lax`, `secure` in production. The path was not widened and `sameSite` was not relaxed.
4. Logout (`POST /api/host/session`) is unchanged and verified to still clear the cookie on the matching path.

### Why raising the lifetime is cheap in security terms

The session value is a deterministic HMAC of the room secret (`sessionValue`). It never changes and cannot be revoked server-side. An attacker who has **already** exfiltrated the cookie value can replay it indefinitely by setting their own expiry — `maxAge` bounds nothing for them. `maxAge` bounds only how long the *legitimate* browser keeps the cookie on disk. So the 12h → 30d change does not widen the cookie-theft attack at all.

### The real cost: shared venue devices

The accepted cost is **device sharing, not theft**. On a bar's shared laptop or tablet, the next person to pick it up is host — and stating that as "for up to 30 days" understates it. Because the roll is driven partly by the **public landing page**'s saved-rooms probe, any visit to boraoke.com from that device silently re-arms the full 30 days. The honest statement is therefore: **indefinitely, for as long as the device keeps visiting the site.** That is a real regression against the 12h window, and it is accepted deliberately: the alternative (retyping an unrecoverable, shown-once code) pushes hosts toward writing the code down or screenshotting it, which is strictly worse. Logout is the mitigation and must stay reachable.

### Why the probe bound was NOT raised

`MAX_HOST_PROBES` stays at 3. An **unprobed** saved room already lands correctly: its link is the plain `/<room>/admin` page, and `AdminRoom`'s own `checkSession()` routes a live session straight to the dashboard. Raising the bound would buy only an earlier "expired" hint on rooms 4..50, at the cost of up to 50 parallel fetches per landing load — exactly the fan-out the PR #22 BLOCKING-1 review capped. Not worth it. (`MAX_HOST_PROBES` also lives in `lib/room-memory.ts`, outside this ticket's file boundary; `roomsToProbe` takes an explicit `limit` if a future ticket wants to tune it from the component.)

## Follow-ups (deliberately out of scope)

- ~~**A visible logout control.**~~ **RESOLVED.** When this ticket was written, `POST /api/host/session` had zero callers and no logout UI existed — the only mitigation for the cost accepted here was unreachable. TICKET-77 has since merged a confirm-gated "Sair" control into the admin header on `main`. `main` was merged into this branch and the composed behaviour re-proven in a real browser against the **rolling 30-day** session (not just the 12h one it was originally verified against): logout clears the cookie, and a post-logout visit to the public landing page does **not** re-arm it. See the dev report's "Composed behaviour" table.
- **Stale comment.** `lib/room-memory.ts` still says "a live ~12h host-session cookie" in its header. Comment-only, in a file outside this ticket's boundary.
- **Server-side session revocation.** The deterministic, non-rotatable session value means logout is local-only: it clears the cookie in *that* browser but cannot invalidate a value already copied elsewhere. Fixing that needs a per-session nonce stored server-side, which is a real design change, not a lifetime tweak.
