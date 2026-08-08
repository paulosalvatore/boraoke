"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { FeedbackSheet } from "./feedback/FeedbackSheet";
import styles from "./feedback/FeedbackWidget.module.css";

/**
 * Global feedback widget (TICKET-11). Mounted once in app/layout.tsx so it rides
 * every patron page and the host view — but NEVER on /tv (a passive venue screen;
 * TV problems get reported from phones, spec AC7).
 *
 * A small floating pill opens a bottom sheet where a single sentiment tap sends
 * feedback (2 taps total). Unobtrusive by design.
 *
 * TICKET-71 mobile positioning (see the CSS module for the actual rules):
 * on mobile, this pill is `position: static` — a normal-flow element rendered
 * once, at the very end of the page (the widget mounts after `{children}` in
 * app/layout.tsx) — NOT `position: fixed`. That is a DELIBERATE reversal of
 * an earlier attempt at this ticket.
 *
 * The first attempt kept the pill fixed and added a live JS "collision
 * avoidance" nudge (`useCollisionLift`, since removed) that measured the
 * pill against on-screen queue rows and translateY'd it clear of whichever
 * row it currently overlapped. That fixed the ticket's own short-queue
 * evidence screenshot, but an independent verifier swept a 25-song queue
 * across scroll fractions 0.0–1.0 and found it net-negative: from roughly
 * frac 0.2 to 0.9 the required lift saturated a sane cap and the pill still
 * overlapped 1–2 rows — with the SAME overlap count whether the JS lift was
 * on or off. It never removed an overlap at mid-scroll; it only relocated
 * the same overlap from the bottom-right corner into the screen's vertical
 * center, where it kept moving as the guest scrolled. Worse than the
 * original bug, not better.
 *
 * The reason is structural, not a tuning bug: a `position: fixed` overlay
 * sitting over a scrollable list of unknown length WILL coincide with some
 * row at some scroll offset — that is true for any list taller than
 * "viewport minus the overlay's footprint minus one row", which a real
 * venue's queue routinely is. No amount of padding (reserved space only
 * helps at the true scrolled-to-bottom rest state — see the CSS module) or
 * per-frame nudging (which only moves WHERE the unavoidable overlap lands)
 * can fix that while the pill stays fixed. The only fix with an actual
 * geometric guarantee is to stop floating it over content that can be
 * arbitrarily tall: on mobile it now renders in-flow, so it never spatially
 * coincides with a queue row at any scroll position — there is nothing left
 * to overlap, by construction. Desktop is unaffected (unaffected page
 * widths never showed this bug) and keeps the original fixed bottom-right
 * pill.
 *
 * TICKET-72 mobile DISCOVERABILITY (the cost TICKET-71 knowingly paid):
 * an in-flow pill at the true end of the page means a guest on a long queue
 * has to scroll ~2400px to reach it. The feedback loop is a founding product
 * pillar, so "reachable only at the page's end" is not good enough.
 *
 * Every viewport-anchored (`position: fixed`) affordance was REJECTED ON
 * MEASUREMENT, not on principle. A probe swept 21 scroll positions on a
 * 35-row room and on the landing page at 390px/320px and counted how often
 * each candidate footprint would intersect interactive content:
 *
 *   footprint (bottom-right, fixed)   room(35 rows)   landing 390   landing 320
 *   178x48 pill                            39              12             9
 *   48px circle                            19               8             5
 *   40px circle                            16               7             5
 *
 * "Just make it smaller" does not work: queue rows and the landing page's
 * CTAs both span the full content column (a row measures x=16..374 in a
 * 390px viewport), so there is no horizontal gutter for a fixed target to
 * live in. Auto-hide-on-scroll fails for the same reason — the at-rest
 * positions ARE among those sampled offsets — and it would reintroduce the
 * per-frame scroll math that got v1 refuted.
 *
 * So the second entry point is also in normal document flow, just at the
 * OTHER end of the page: a compact icon-only trigger rendered into the
 * page's own `<header>` via a portal. In-flow means the same geometric
 * guarantee as the pill (nothing to overlap, by construction); the header
 * means it is on screen at first paint with zero scrolling, on every page
 * that has a header — the patron room and the landing page included —
 * without editing those pages. The portal target is resolved by a plain
 * `document.querySelector("header")`, re-armed on route change and via a
 * cheap presence-guarded MutationObserver (the patron room only renders its
 * header AFTER the nickname gate). That is DOM-presence detection, not
 * geometry: nothing here reads a scroll offset or a bounding box.
 *
 * Desktop is untouched again — the header trigger is `display: none` above
 * 700px, where the fixed pill has always floated clear in the page margin.
 */
export function FeedbackWidget() {
  const pathname = usePathname();
  const t = useTranslations("Feedback");
  const [open, setOpen] = useState(false);
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);

  // TICKET-72: resolve the portal target for the header entry point. Runs
  // client-side only (so SSR output is unchanged), re-arms whenever the route
  // changes, and keeps a MutationObserver alive because the patron room only
  // renders its <header> AFTER the nickname gate is satisfied — and tears it
  // down again if the guest re-opens that gate. The observer callback is a
  // `document.contains` guard plus one querySelector; it reads no geometry
  // and no scroll offset.
  useEffect(() => {
    let current: HTMLElement | null = null;
    const sync = () => {
      if (current && document.contains(current)) return;
      current = document.querySelector("header");
      setHeaderEl(current);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);

  // Close on Escape for keyboard/desktop users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // AC7: no widget on any TV screen. TICKET-9 moved the TV to the room-scoped
  // route `/[room]/tv` (and kept legacy `/tv`), so exclude every path whose
  // final segment is `tv` — `/tv`, `/tv/*`, and `/<room>/tv`.
  const path = pathname ?? "";
  if (path === "/tv" || path.startsWith("/tv/") || path.endsWith("/tv")) return null;

  return (
    <div className={styles.root}>
      {/*
       * TICKET-72: the header entry point. Portalled into the page's own
       * <header> so it renders in NORMAL DOCUMENT FLOW at the top of the
       * page — same geometric no-overlap guarantee as the in-flow pill
       * below, but reachable at first paint without any scrolling. Mobile
       * only (`display: none` above 700px — desktop keeps the fixed pill it
       * always had). Its accessible name is deliberately DIFFERENT from the
       * pill's ("Enviar feedback") so that a locator for one never
       * ambiguously resolves to both; the regression sweep in
       * e2e/feedback-widget-safe-area.spec.ts depends on that.
       */}
      {!open &&
        headerEl &&
        createPortal(
          <button
            type="button"
            className={styles.headerTrigger}
            data-testid="feedback-header-trigger"
            aria-label={t("title")}
            title={t("title")}
            onClick={() => setOpen(true)}
          >
            <span aria-hidden>💬</span>
          </button>,
          headerEl,
        )}

      {!open && (
        <button
          type="button"
          className={styles.fab}
          aria-label={t("trigger")}
          onClick={() => setOpen(true)}
        >
          <span className={styles.fabIcon} aria-hidden>
            💬
          </span>
          {t("trigger")}
        </button>
      )}

      {/*
       * TICKET-71: reserved-space spacer. Meaningful on DESKTOP, where the
       * fab stays `position: fixed` (see the CSS module) and this guarantees
       * clearance after the true last row once fully scrolled. On mobile the
       * fab itself is now in normal flow (no longer fixed), so this collapses
       * to a small safe-area-only gap AFTER the pill — rendered here, right
       * after the fab in the DOM (not before it), specifically so that gap
       * lands BELOW the in-flow pill, clearing the iPhone home-indicator the
       * way it's meant to, rather than as dead space above it. Kept
       * unconditional (not tied to `open`) so opening the sheet never shifts
       * page layout.
       */}
      <div className={styles.spacer} data-testid="feedback-pill-spacer" aria-hidden="true" />

      {open && (
        <div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label={t("trigger")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className={styles.sheet}>
            <FeedbackSheet onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
