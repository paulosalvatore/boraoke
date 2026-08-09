# TICKET-79 — `<html lang>` still wrong in the served HTML on two routes (TICKET-75 follow-up)

**Filed:** 2026-08-08, interactive TM session (TL present)
**Priority:** MED
**Size:** S
**Type:** Correctness gap left open by TICKET-75's file-boundary constraint.

## Why this exists

TICKET-75 (PR #54, merged) fixed the TV route's `<html lang>` mismatch, but `app/layout.tsx` —
the actual place `<html lang={locale}>` is set (`app/layout.tsx:23`) — was off-limits for that
ticket's scope, so the TV fix was implemented as an inline client-side script that patches the
attribute after hydration instead of at the server-rendered root layout.

**Consequence:** with JavaScript disabled (or before the patch script runs), the **served** HTML on
the TV route still carries whatever `lang` value `app/layout.tsx` set at render time, not the
room's actual language — the mismatch TICKET-75 was filed to close is not fixed at the HTML-source
level, only patched post-hydration.

The same underlying issue — `<html lang>` coming from `app/layout.tsx`'s locale rather than the
room's `settings.language` (the field TICKET-75 fixed `createRoom` to actually populate) — also
still applies unfixed on `app/(patron)/[room]/page.tsx`, the patron room route, which TICKET-75
did not touch at all.

## The fix

Do the `<html lang>` correction properly in `app/layout.tsx` (or via Next's per-route metadata/
generateMetadata mechanism, whichever this codebase's App Router layout structure supports for a
segment-specific `lang`), so the room's language is reflected in the **server-rendered** HTML on
both the TV route and the patron room route, with no reliance on a post-hydration script.

## Acceptance criteria

- TV route: `<html lang>` in the raw server-rendered HTML (curl / view-source, JS disabled) matches
  the room's `settings.language`, not just the post-hydration DOM.
- Patron room route (`app/(patron)/[room]/page.tsx`): same correction applied.
- The inline client-side patch script added by TICKET-75 can be removed once the root-layout fix
  supersedes it (confirm no other consumer depends on it first).
- No regression to the existing `settings.language` seeding behavior from TICKET-75.

## Not in scope

Re-litigating TICKET-75's cookie-vs-room-language precedence rules (an explicit patron cookie still
wins) — this ticket is only about where and how `<html lang>` gets set.
