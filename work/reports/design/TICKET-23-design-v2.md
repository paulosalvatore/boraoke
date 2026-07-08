# TICKET-23 — Designer report: design v2 (professional + personality)

- **Date:** 2026-07-07 · **Role:** Designer · **Branch:** `ticket/23-design-v2` · **Worktree:** `.worktrees/ticket-23`
- **Status:** COMPLETE — all five deliverables committed; awaiting W-design TL gate.

## Deliverables

1. **UX audit of the live v1** — `work/design/ux-audit-v1.md`. Audited the LIVE product (landing, /new, room-created, patron, /tv, /admin — created real rooms), plus a local serve for patron-flow states and the ticket-8/10/11/18 evidence archives. 40 findings, screen-by-screen, P0→P3, with a ranked top-10.
2. **Design system v2** — `work/design/design-system-v2.md`. Two-axis theming (`data-theme` dark/light × `data-vibe` bar/party/festa/corporate + `--venue-accent`), swappable wordmark (rename-proof), room-customization surface, i18n design rules (pt-BR/en/es launch; expansion budget, ICU ordinals, RTL logical-properties pre-work), admin-v2 architecture with the auth progression (logged-out = tonight + hook; logged-in = full history).
3. **Static mockups** — `work/design/mockups-v2/` (9 files, `index.html` is the directory): landing refresh, patron 3-screen flow with position hero, admin Ao-vivo (add-song, drag reorder, account hook), admin Histórico (sessions/analytics), TV in three vibes (bar dark, party dark, corporate light), language/theme/vibe switchers. `cantai-v2.css` is the token source of truth.
4. **Own screenshots** — `work/evidence/ticket-23/`: `live-audit/` (9 shots of the live product, capture script committed) + `mockups-v2/` (10 shots, capture script committed). Plain-Playwright capture per capture-screenshots conventions (background-serve → absolute EVIDENCE_DIR).
5. **Design handoff v2** — `work/design/design-handoff-v2.md`. 8-wave build order (tokens → i18n → venue identity → patron flow → admin live → history+auth-hook → customization/vibes → landing+light), 10 acceptance criteria, component→mockup map, 6 TL gate questions.

## Notes for the TM

- Live observation confirmed the TICKET-20/Upstash urgency first-hand: a freshly created room's patron page intermittently 404s while its admin/TV work (per-instance store). Evidence in `live-audit/`. Not designed around — assumed fixed.
- v1 design system survives as the bar-vibe dark-theme layer; v2 is architecture around it, not a replacement.
- Rename-proofing: the wordmark is one component + `--brand-name`; the naming-research ticket plugs in with zero design rework.
