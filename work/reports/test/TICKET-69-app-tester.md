# TICKET-69 — App Tester Report — Landing "Demo vivo" rebuild

**Verdict: PASS**

Tested on `PORT=3181`, branch `ticket/69-landing-demo-vivo`, worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69`. No `.env` present (in-memory store, YouTube search degraded) — expected, not a defect.

## Note on evidence-capture hygiene

The Playwright MCP browser instance is shared across the parallel sibling worktree agents (ports 3180/3182/3183). Twice during this run a screenshot/evaluate call landed on a **sibling agent's `/tv` page** (`localhost:3182/bar-boraoke-tour-especial/tv`, a Rick Astley video) instead of this ticket's page, because the shared tab had been navigated elsewhere between calls. Both contaminated screenshots (`landing-desktop-1440x900.png` first capture, `desktop-cta-above-fold.png` first capture) were detected by re-reading the image, discarded, and **retaken** with an explicit `location.href`/Page-URL check immediately before/after each capture. All screenshots committed below were verified to be on `http://localhost:3181/...` at capture time.

## Evidence captured (all under `work/evidence/TICKET-69/`, absolute paths)

1. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/landing-desktop-1440x900.png` — `/` at 1440x900, full page.
2. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/landing-mobile-390x844.png` — `/` at 390x844, full page.
3. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/landing-desktop-en.png` — `/` after switching to EN.
4. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/landing-desktop-es.png` — `/` after switching to ES.
5. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/cta-clickthrough-new.png` — result of clicking the primary CTA; final URL `http://localhost:3181/new`.
6. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/join-by-code.png` — join-by-code input filled with `ticket-69-test-bar` before submit; submit navigated to `http://localhost:3181/ticket-69-test-bar`.
7. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/saved-rooms-card.png` — `/` showing the "Suas salas" card (`[data-testid=saved-rooms]`) with the just-created "TICKET-69 Test Bar" room and its Entrar/Admin/TV links.
8. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/mobile-cta-above-fold.png` — 390x844 viewport-only screenshot, CTA visible.
9. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/desktop-cta-above-fold.png` — 1440x900 viewport-only screenshot, CTA visible.
10. `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69/work/evidence/TICKET-69/cta-focus.png` — Tab-focused state of the CTA link, visible blue focus ring.

## Measured numbers

### No horizontal overflow
| Viewport | scrollWidth | innerWidth | Overflow? |
|---|---|---|---|
| 390x844 | 390 | 390 | No |
| 1440x900 | 1440 | 1440 | No |
| 320px width | 320 | 320 | No |

### CTA above the fold
| Viewport | CTA `getBoundingClientRect().bottom` | viewport height | Above fold? |
|---|---|---|---|
| 390x844 | 455.67 | 844 | Yes |
| 1440x900 | 436.64 | 900 | Yes |

### CTA target
`document.querySelector('a[href="/new"]')` resolves — CTA `href` is exactly `/new`. Link text: "Começar agora — é grátis".

### No YouTube network/iframe on landing
- `document.querySelectorAll('iframe').length` on `/` at 1440x900 (freshly navigated, verified via `location.href`): **0**.
- Fresh network-request log for `/` (post-navigation) lists only same-origin Next.js assets (`/`, `/_next/static/...css`, `/_next/static/chunks/...js`, `/manifest.json`, `/icons/icon-192.png`) — **no requests to `youtube.com` or `googleapis.com`**.
- Note: an earlier network-requests query returned one stale `youtube.com/youtubei/v1/log_event` POST, but a re-verified fresh navigation+query confirmed that was leaked from the shared-browser cross-contamination described above, not a request made by this landing page.

### Keyboard / focus
- From a blank body focus, Tab #1 lands on the language-switcher trigger (`🌐 PT`).
- Tab #2 lands on the create CTA (`<a href="/new">`), confirmed via `document.activeElement`.
- Computed style on focus: `outline: rgb(0, 95, 204) auto 1px`, `outline-offset: 1px` — a clearly visible blue ring, confirmed visually in `cta-focus.png`.

### Console errors on `/`
- On a clean load of `/` (no saved room in localStorage yet): **0 console errors**.
- After a room is created and saved to this browser (`SavedRooms` localStorage entry), reloading `/` produces **1 console error**: `Failed to load resource: the server responded with a status of 401 (Unauthorized) @ /api/host/session?room=ticket-69-test-bar`. This comes from `components/SavedRooms.tsx`'s existing background host-session probe (pre-existing code, not touched by this ticket's `app/page.tsx`/`app/page.module.css` changes) — it fires whenever a saved room's host cookie isn't valid in the current browser session, which is expected in this test flow (room created via `/new`, no host cookie persisted for the probe to validate against admin state). Not a regression introduced by this ticket; flagging as a low-severity pre-existing wart for `SavedRooms.tsx`, out of scope here.

## Comparison against approved mockup (`direction-2-demo-vivo-desktop.png` / `-mobile.png`)

Structure matches concretely, element by element:
- **Header + pill**: "🎤 Boraoke" logo left, "GRÁTIS · ACESSO ANTECIPADO" pill right — present, matches. (Implementation adds a functional language-switcher button next to the pill, not present as a control in the static mockup — the mockup only shows "pt-BR / EN / ES" as plain footer text. This is an enhancement beyond the mockup, not a deviation from it, and does not disturb the mockup's layout.)
- **Venue chips**: "No bar / Na festa / No condomínio / Na empresa" row, first chip active (red outline) — matches.
- **Split hero**: headline "A fila do karaokê na TV. O controle, na mão de todo mundo." with red-highlighted phrase, sub-copy, CTA button, "Sua sala fica pronta em 30 segundos..." caption on the left; TV mock on the right — matches text and layout.
- **TV mock with rotation tag + QR phone card**: "rodízio: uma por pessoa" pill top-right of the TV mock, "TOCANDO AGORA" now-playing block, "PRÓXIMAS" queue list, QR phone card overlapping bottom-left of the TV mock with "Escaneou, entrou." caption — matches.
- **3 bullets**: "Entra com QR, sem app" / "Qualquer música do YouTube" / "Rodízio justo, automático", each with a red top divider — matches.
- **Join strip**: "Já tem um código?" label, text input (placeholder `ex.: bar-do-ze`), red "Entrar" button — matches.
- **Free-promise footer**: "Tudo o que existe hoje é grátis — e continua grátis." plus "Boraoke early access · pt-BR / EN / ES" — matches.

One legitimate, expected deviation: the live page also renders a **"Suas salas"** (saved rooms) card between the bullets and the join strip once a room has been created/joined in this browser — the static mockup has no such state since it depicts a fresh/no-history session. This is correct dynamic behavior of a pre-existing feature, not a defect.

Mobile screenshot (`landing-mobile-390x844.png`) matches `direction-2-demo-vivo-mobile.png`'s stacked layout equally closely: header, pills wrapping to two rows, headline, CTA, TV mock stacked below hero text, 3 bullets with dividers, join strip, footer.

## Defects found

None blocking. One low-severity, pre-existing, out-of-scope observation:

- **[Low, pre-existing, out of scope]** `components/SavedRooms.tsx`'s background `/api/host/session` probe logs a console 401 whenever a saved room's host cookie isn't currently valid (e.g., right after creating a room and returning to `/` in the same tab). Not introduced by this ticket's `app/page.tsx` / `app/page.module.css` / i18n changes.

## Summary

Landing rebuild (Direction 2 "Demo vivo") is structurally and textually faithful to the approved mockup at both desktop and mobile breakpoints, in all three locales (pt-BR, EN, ES) with no leaked keys or untranslated pt-BR strings observed in EN/ES. No horizontal overflow at 320/390/1440px. CTA is above the fold at both tested viewports, targets `/new`, is keyboard-reachable in 2 tabs with a visible focus ring, and the landing page itself makes no YouTube network calls and renders no iframe. Saved-rooms round trip (create room → back to `/` → see it listed) and join-by-code flow both work as expected.
