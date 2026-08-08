# TICKET-75 — Independent review

Reviewer: clean-context Reviewer agent (no builder context).
Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-75`, branch `ticket/75-room-language-seed`, 2 commits ahead of `origin/main` (`99da9bd` + the auto event-log commit `4eb603b`).

## Independently derived root cause

I re-derived the diagnosis from the code before reading the builder's account, and it holds in full.

**Defect 1 — the room language was never populated.** `lib/rooms.ts` declares `RoomSettings.language?: Locale` as an additive, optional field (line 47) and `getRoomLanguage` reads it as `normalizeLocale(room?.settings?.language)` (line 426), which maps `undefined` → `DEFAULT_LOCALE` = `"pt-BR"`. On `main` the only writer of `settings.language` anywhere in the app is `setRoomLanguage` (line 435), whose sole caller is the host-authed `app/api/host/language/route.ts:40`. `createRoom` wrote `settings: { mode: DEFAULT_ROOM_MODE }` with no `language` key on any path. So every room ever created read back `pt-BR` until a host manually opened `/[room]/admin` and changed it. `app/(patron)/[room]/tv/page.tsx` resolving `const locale = await getRoomLanguage(room)` is correct and intentional (documented at `i18n/request.ts:8-13`: the venue screen follows the room, never a patron cookie) — the route was faithfully obeying a field that was permanently unset. Diagnosis confirmed: **the bug was the missing write, not the TV's resolution policy.**

**Defect 2 — `<html lang>` vs. rendered copy.** `app/layout.tsx` sets `<html lang={locale}>` from `getLocale()`, i.e. the REQUEST locale resolved by `i18n/request.ts` from `NEXT_LOCALE` / `Accept-Language`. The TV subtree mounts its own `NextIntlClientProvider` with the ROOM locale. The two are resolved from different inputs and nothing reconciled them, so `lang="es"` over 100% pt-BR copy is exactly what the code produces. Confirmed independently.

I also confirmed a fact the builder relied on but did not state as load-bearing: **`NEXT_LOCALE` is written in exactly one place** — the `setLocale` server action (`i18n/set-locale.ts`), called only from `components/LanguageSwitcher.tsx:56`. Nothing auto-writes the cookie from `Accept-Language`. This matters for the seed's semantics (see finding N-1) and it makes the seed an *explicit* host choice rather than a browser hint.

## Per-item verdicts

### 1. Root-cause diagnosis — PASS

Re-derived above from `lib/rooms.ts`, `app/api/rooms/route.ts`, `app/(patron)/[room]/tv/page.tsx`, `i18n/locales.ts`, `i18n/request.ts`. Both claims hold. The TV-follows-room policy is correctly left alone.

### 2. Tests + type-check — PASS

`npm test` (run by me, in this worktree):

```
Test Suites: 44 passed, 44 total
Tests:       712 passed, 712 total
Snapshots:   0 total
Time:        3.298 s
```

`npx tsc --noEmit` after `rm -f tsconfig.tsbuildinfo`: exit 2, **2292 error lines** (matching the builder's branch-side number; the stated `main` baseline is 2230, the known missing-`@types/jest` artifact).

Rather than mutate the tree to re-derive the `main` baseline, I established the delta more directly and more strongly — I filtered the branch-side output for the directories that must stay clean:

```
$ grep -E "^(app|lib|i18n|components)/" tsc-75.txt | sort | uniq -c
(no output)
$ grep -E "^(lib/rooms\.ts|app/api/rooms/route\.ts|app/\(patron\)|i18n/locales\.ts)" tsc-75.txt
(no output)
```

There are **zero** tsc errors under `app/`, `lib/`, `i18n/`, `components/` on the branch — so the delta in those trees is zero by construction, regardless of what the `main` baseline contains there. All 2292 lines are in `__tests__/`. Stronger than the builder's diff-based claim and independently reproducible. (This method also avoided a `git stash` in a worktree that turned out to have a concurrent writer — see finding N-3.)

### 3. Backward compatibility for live data — PASS

`createRoom` writes `settings: { mode: DEFAULT_ROOM_MODE, ...(isLocale(language) ? { language } : {}) }`. With `language` absent or invalid, the spread contributes nothing — the object literal is `{ mode }`, same keys, same order, byte-identical serialization to `main`. No `language: undefined` key is emitted (which would have been a real shape change in a JSON store). A pre-existing room record is never read-migrated and never rewritten: `getRoomLanguage` normalizes an absent field to `pt-BR` at read time only. No migration, no backfill, no crash path.

Verified by test, not just by reading: `__tests__/room-language.test.ts` asserts `expect("language" in (pub?.settings ?? {})).toBe(false)` for the omitted-arg case (a stricter assertion than `toBeUndefined()`, which is the right one here), and `__tests__/api-rooms.test.ts` asserts the same through the real `POST /api/rooms` with no cookie. `__tests__/tv-html-lang.test.ts` covers the legacy-room-renders-pt-BR case and the unknown-room-id case (resolves `pt-BR` without throwing). The pre-existing `room-language.test.ts` assertion that creation does not write the field still passes unchanged.

### 4. Host's manual admin override still wins — PASS

Code path: the seed is written once inside `createRoom`; `setRoomLanguage` (`lib/rooms.ts:435`) does `settings: { ...room.settings, language }` and persists via the backend `update`, so it overwrites the seeded value by definition and can only ever run *after* creation (its only caller, `app/api/host/language/route.ts:40`, is host-authed and needs an existing room). There is no path by which a seed can re-apply over an override — `createRoom` runs once per room id.

By test: `room-language.test.ts` ("lets the host's manual override WIN over the seeded language", including overriding back to `pt-BR`, which is the case a naive implementation would break by treating `pt-BR` as "unset"), `api-rooms.test.ts` ("keeps the host's manual override winning over the seeded language"), and `tv-html-lang.test.ts` ("follows the host's manual override, not the seeded value"). Note the store-level tests call `setRoomLanguage` directly rather than the host route; that is the correct seam for this assertion and the host route is a thin authed wrapper over it.

### 5. Untrusted input — PASS (I tried to break it; I could not)

Two independent barriers, and the second one alone is sufficient:

- **API boundary** (`app/api/rooms/route.ts:125-126`): `isLocale(cookieLocale) ? cookieLocale : undefined`.
- **Storage boundary** (`lib/rooms.ts:384`): `...(isLocale(language) ? { language } : {})` — re-validated even for a typed caller, so an untyped JS caller or a future route that forgets to validate still cannot poison stored state. This is the right place for the defense and I specifically checked it is not merely a TypeScript-level guarantee.

`isLocale` is `typeof value === "string" && LOCALES.includes(value)` against a frozen 3-member `as const` tuple — no prefix matching, no normalization, no case-folding, so `en-US`, `pt`, `de`, `""`, `"%%%"`, `__proto__`, `"../etc/passwd"`, numbers and `null` are all rejected. Both are covered by table-driven tests.

For the emitted script: `documentLangScript` is `document.documentElement.lang=${JSON.stringify(normalizeLocale(locale))};`. `normalizeLocale` collapses *anything* not in `LOCALES` to `"pt-BR"`, so the only three strings that can ever reach `JSON.stringify` are `pt-BR`, `en`, `es` — none contain a quote, backslash, `<`, or newline. The JSON encoding is belt-and-braces on top of an already-closed enum. I attempted the standard breakout `'";</script><script>alert(1)//'` and it returns `document.documentElement.lang="pt-BR";` (the test file pins exactly this). There is no interpolation of anything user-controlled into the script text. **No injection vector found.**

Worth stating explicitly because `dangerouslySetInnerHTML` correctly attracts scrutiny: the danger with that API is interpolating attacker data, and here the value is provably drawn from a 3-element compile-time constant.

### 6. Sibling-owned files untouched — PASS

```
$ git diff --name-only origin/main...HEAD | grep -E "app/layout\.tsx|app/metadata\.ts|app/generate-metadata\.ts|^messages/|components/FeedbackWidget\.tsx|admin/AdminRoom\.tsx|lib/host-auth\.ts|app/page\.tsx|app/globals\.css"
(no output)
```

Full changed-file list (10 files):

```
__tests__/api-rooms.test.ts
__tests__/room-language.test.ts
__tests__/tv-html-lang.test.ts
app/(patron)/[room]/tv/page.tsx
app/api/rooms/route.ts
i18n/locales.ts
lib/rooms.ts
work/events/by-branch/ticket-75-room-language-seed.jsonl
work/reports/dev/TICKET-75-dev-report.md
work/tickets/TICKET-75-room-language-seed.md
```

`app/layout.tsx` is confirmed untouched. Nothing outside the ticket's boundary is modified — including `app/(patron)/[room]/page.tsx`, which the builder correctly flagged-but-did-not-touch.

### 7. No new user-facing copy — PASS

No `messages/*.json` in the diff (see the list above), and no new translatable string is introduced: the change adds one JS statement (not rendered text), one optional function parameter, and one cookie read. The existing `i18n-completeness.test.ts` suite passes.

### 8. The `<html lang>` fix on its merits — PASS, with honest limitations recorded

**Sound.** The strongest property of the implementation is that the script is derived from *the same* `locale` binding that feeds `NextIntlClientProvider`, one line below it — the attribute and the copy cannot drift by construction, which is a better invariant than "two places compute the same thing correctly". Extracting `documentLangScript` into `i18n/locales.ts` rather than inlining is the right call: it puts the normalization/encoding in one testable place and makes the helper reusable by the next surface with the same problem (`app/(patron)/[room]/page.tsx`).

**Safe.** Covered in item 5 — the value space is a 3-element constant. The inline script has no `src`, no network, no external dependency; it is a single attribute assignment executed during HTML parse, before first paint, and long before an assistive-tech tree or an auto-translate heuristic settles. It cannot fail in a way that affects rendering.

**Limitations, stated honestly:**

- **JS disabled → the served `lang` stays wrong.** The SSR HTML still carries the root layout's request-locale value; only the live DOM is corrected. This is inherent to fixing the attribute from outside the element that owns it. Weighed against the hard constraint that `app/layout.tsx` could not be touched, this is the correct trade: it fixes the real-world case (every browser, every screen reader, every auto-translate path, and JS-executing crawlers) and leaves only the no-JS raw-HTML case wrong. The TV surface is a JS-driven kiosk that renders nothing useful without JS anyway, so the no-JS case is not a real user. Non-blocking.
- **Non-JS crawlers reading raw HTML** see the old value. Effectively irrelevant for `/[room]/tv`, which is a per-room venue screen, not an indexable marketing page.
- The genuinely correct long-term fix is for the root layout to accept a per-route override; that is a `app/layout.tsx` change and correctly out of scope here.

I checked the placement is valid: the `<script>` is a child of the page's returned tree (inside `<body>` via the layout), an inline script with no `src`, so React renders it in place in the SSR stream and does not re-execute it on hydration. No hydration mismatch is possible — the server and client render the identical literal string from the same server-resolved value.

## Findings

**BLOCKING: none.**

**N-1 (non-blocking, product judgment — worth surfacing to the TM/TL, not worth holding the merge).** Seeding `settings.language` activates a previously-dead code path on the *patron* route. `app/(patron)/[room]/page.tsx:55` already scoped its subtree to the room language when the visitor has no `NEXT_LOCALE` cookie — dead in practice, because the field was never written. After this change, a cookie-less patron joining a room whose host had explicitly picked English now sees English instead of falling through to their own `Accept-Language`. Three things make this acceptable rather than a defect: it is exactly the precedence the design specifies (`i18n/locales.ts` `resolveLocale`: explicit cookie → room default → `Accept-Language` → pt-BR); an explicit patron cookie still wins; and the seed only exists when the host *explicitly* used the language switcher (I verified `NEXT_LOCALE` has exactly one writer, the `setLocale` server action — nothing auto-writes it from `Accept-Language`), so it reflects a deliberate human choice, not a browser default. It affects new rooms only. The builder documented this side effect in the ticket rather than hiding it, which is the right behavior. Flagging it so the TL is not surprised by a report of "my patrons see English now".

**N-2 (nit).** After a client-side navigation *away* from `/[room]/tv` to a route that does not re-assert it, `document.documentElement.lang` retains the room locale (the assignment is one-way, with no cleanup on unmount). In practice the TV is a terminal kiosk route with no in-app navigation away from it, so this is theoretical. Not worth code for.

**N-3 (nit, process observation — not a defect in the change).** While I was reviewing, `work/tickets/TICKET-75-room-language-seed.md` acquired 8 uncommitted lines in the worktree (the "side effect worth knowing about" and "adjacent issue NOT fixed here" sections). Something still had the worktree open. The content is accurate and improves the ticket, but it is **uncommitted** — the ticket manager should make sure it lands rather than being lost or clobbered. It is docs-only and touches no source. I did not commit or modify it.

**N-4 (nit, follow-up ticket).** The same `<html lang>` mismatch class exists on `app/(patron)/[room]/page.tsx` for the cookie-less-visitor branch. The builder correctly flagged it and did not touch it (it is another agent's scope). The fix is one line reusing `documentLangScript(locale)`. Worth a follow-up card.

## Quality notes (not findings)

- Defense-in-depth at the storage boundary rather than trusting the caller's type is the right instinct and is the single best thing in this diff.
- The test for overriding *back to* `pt-BR` is a real thought — it is the case a "treat default as unset" implementation would silently break.
- Comments explain *why* (the venue-screen-cannot-follow-40-phones rationale, the no-migration contract) rather than restating the code. Slightly verbose in the TV page, but the reasoning is non-obvious enough to earn it.

## Verdict

Diagnosis independently confirmed. Change is minimal, additive, correctly scoped, defended at the storage boundary, injection-proof by construction, backward-compatible with live data without a migration, and does not touch a single sibling-owned file. Tests re-run by me: 712/712 pass. Zero new type errors under `app/`, `lib/`, `i18n/`, `components/`. The one real limitation (no-JS raw HTML) is inherent to the imposed constraint, correctly traded, and honestly documented.

VERDICT: APPROVE
