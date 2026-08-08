"use client";

import { useEffect, useState } from "react";
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
 */
export function FeedbackWidget() {
  const pathname = usePathname();
  const t = useTranslations("Feedback");
  const [open, setOpen] = useState(false);

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
