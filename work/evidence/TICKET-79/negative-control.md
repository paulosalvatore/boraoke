# Negative control — proof the new tests have teeth

A test that only ever passes proves nothing. Both layers of the TICKET-79 test suite were run against a deliberately broken tree and confirmed to go **red on the specific behaviour**, then restored.

## Layer 1 — unit tests, with the route classifier neutralized

`i18n/route-locale.ts`'s `classifyLocaleRoute` was made to return `{ kind: "app" }` unconditionally, i.e. exactly the pre-TICKET-79 world where every route resolved through the one app-wide chain.

```
Test Suites: 2 failed, 2 total
Tests:       9 failed, 25 passed, 34 total
```

The nine failures are precisely the behaviours this ticket adds — nothing incidental:

```
● the TV's served lang follows the ROOM locale › a room seeded with en serves that lang
● the TV's served lang follows the ROOM locale › a room seeded with es serves that lang
● the TV's served lang follows the ROOM locale › follows the host's manual override, not the seeded value
● the TV's served lang follows the ROOM locale › NEVER follows a patron cookie — the whole point of the route
● the TV's served lang follows the ROOM locale › NEVER follows Accept-Language either
● the TV's served lang follows the ROOM locale › the legacy /default room's screen stays pt-BR under any patron context
● patron room: cookie → room default → Accept-Language → pt-BR › uses the room default when the visitor has no cookie
● patron room: cookie → room default → Accept-Language → pt-BR › room default outranks Accept-Language
● the three chains stay distinct › same room, same visitor, different route → different lang
```

That 25 tests still pass is itself the point: the app-wide chain is genuinely untouched by this ticket, so its assertions stay green even with the fix ripped out.

## Layer 2 — the e2e spec, against a full revert to `origin/main`

The three production files were checked out from `origin/main` (restoring the TICKET-75 inline script and the `documentLangScript` helper) and the three new files were removed, leaving only `e2e/served-lang.spec.ts` in place. The dev server was restarted on the reverted code.

```
✓ 1 › app-wide routes follow the visitor: cookie, then Accept-Language, then pt-BR
✘ 2 › the venue TV serves the ROOM's language, never the visitor's
✘ 3 › the legacy /default screen stays pt-BR for any visitor
✘ 4 › the TICKET-75 client-side lang patch is gone from the served HTML
✘ 5 › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR
✓ 6 › the host console follows the host's cookie, not the room
✓ 7 › metadata still renders alongside the lang fix (TICKET-74 guard)
```

The failure messages are the original bug, reproduced exactly:

```
› the venue TV serves the ROOM's language, never the visitor's
    Expected: "en"
    Received: "es"
    > 110 | expect(await servedLang(`/${room}/tv`, { cookieLocale: "es" })).toBe("en");

› the legacy /default screen stays pt-BR for any visitor
    Expected: "pt-BR"
    Received: "es"

› the TICKET-75 client-side lang patch is gone from the served HTML
    Expected substring: not "document.documentElement.lang"
```

Cases 1, 6 and 7 staying green on the reverted tree is deliberate corroboration: those routes were never broken, the spec does not blanket-fail, and the TICKET-74 metadata guard is independent of this fix.

Full filtered transcript: `negative-control-e2e-reverted.txt`.

## Restore

Both experiments were reverted (`git checkout HEAD -- …` plus restoring the moved-aside files) and `git status` confirmed a clean tree before the gates were run for real.
