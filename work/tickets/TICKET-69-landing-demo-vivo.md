# TICKET-69 — Rebuild the landing page: Direction 2 "Demo vivo"

**Status:** in progress · **Branch:** `ticket/69-landing-demo-vivo` · **Decision:** Tech Lead chose Direction 2 from `work/design/landing-rethink/PROPOSAL.md`.

## Goal

Replace the current thin landing (`app/page.tsx`) with the approved "Demo vivo" direction: the hero **is** the product — a static mocked `/tv` screen (now-playing hero + up-next rail with names/tables + rotation-mode tag) with a QR phone card hanging off it, so a visitor sees QR-join, the queue, tables and fairness before reading a word.

Reference: `work/design/landing-rethink/mockup-2-demo-vivo.html` + `screenshots/direction-2-demo-vivo-{desktop,mobile}.png`.

## Structure (per the approved mockup)

header (brand + free pill + LanguageSwitcher) → venue chips → split hero (copy + CTA left · TV+QR mock right) → three terse bullets → SavedRooms → compact join strip → free-promise footer.

Primary CTA: "Começar agora — é grátis" / "Start now — it's free" / "Empezar ahora — es gratis", `→ /new`, above the fold at both widths, with the "pronta em 30 segundos" microcopy.

## Acceptance criteria

1. No regression: join-by-code input, `SavedRooms` recovery card and `LanguageSwitcher` all survive.
2. One click to create; the CTA never falls below the first viewport at 1440px or 390px.
3. Fully trilingual through `next-intl` `Landing` catalog — zero hardcoded copy in the component; identical key sets in all three `messages/*.json` (enforced by `__tests__/i18n-completeness.test.ts`).
4. Honest marketing only — QR join + tables, YouTube search/paste, `/tv` auto-advance, 3 rotation modes, host moderation, sing/listen, 3 languages. No accounts, theming, venue presets or payments.
5. Responsive at 1440px and 390px, no horizontal body scroll.
6. TV mock is purely presentational — no iframe, no fetch, no polling.
7. Accessible: semantic landmarks, ordered headings, alt text on the mock, keyboard-reachable CTA, visible focus; no new AA failure in `e2e/contrast.spec.ts`.

## Constraints (hard)

- Do **not** touch `app/globals.css` (TICKET-66 sibling owns it), `components/tv/**`, `components/FeedbackWidget.tsx`, `components/feedback/**`.
- Use existing global classes (`.btn-primary`) and existing CSS custom properties only — no new tokens.

## Notes / decisions taken during implementation

- The mockup styles the rotation tag as `--accent` text on `--surface` (4.18:1 — below AA). Implemented on `--bg` instead (4.64:1) since `--accent-text` does not exist yet on this branch. Once TICKET-66 lands `--accent-text`, the tag can move back to a surface fill — recorded as a follow-up, not done here.
- The mock's flat backgrounds replace the mockup's gradient so the computed-contrast suite can resolve a real painted background for every text node.
- Two existing specs asserted the OLD CTA copy (`/criar a sala do seu bar/i`): `e2e/render-and-links.spec.ts` and the skipped `test.fixme` in `e2e/contrast.spec.ts`. Both are landing-content assertions, updated to the new CTA name. No TV/host-control spec touched.
