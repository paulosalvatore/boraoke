"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { FeedbackSheet } from "./feedback/FeedbackSheet";
import styles from "./feedback/FeedbackWidget.module.css";

/**
 * TICKET-71: elements the pill must never visually cover. The reserved-space
 * spacer (below) handles the page's TRAILING edge — it guarantees a
 * scrolled-to-the-very-bottom page always has clearance after the true last
 * row. It does NOT, by itself, help a short queue that fits almost entirely
 * on one screen: on first paint (scrollTop 0, no user interaction yet) a
 * queue row can coincidentally render right where the fixed pill sits — that
 * row is "before" it in the document, so no amount of trailing padding moves
 * it. That was exactly the ticket's evidence screenshot (a 5-song queue,
 * covered on load, no scrolling involved). Fixing THAT requires reacting to
 * the real, current on-screen geometry, so this selector drives a live
 * collision check (see {@link useCollisionLift}) that nudges the pill up —
 * "floating clear of it", the ticket's own words — only when something it
 * must not cover is actually under it right now.
 */
const AVOID_SELECTOR = '[data-testid="queue-row-title"], [data-testid="queue-row-badge"]';
const LIFT_GAP = 12;
const MAX_LIFT_RATIO = 0.5; // never push the pill past the vertical middle of the screen
const MAX_LIFT_ITERATIONS = 6; // generous headroom for stacked rows; converges in practice in 1-2

/**
 * Keep the fab clear of any {@link AVOID_SELECTOR} element it currently
 * overlaps, by lifting it (translateY) just enough to clear the nearest
 * offender. Recomputed on mount, on resize, on every scroll (throttled to one
 * check per animation frame), and whenever the page's own layout changes
 * (queue polling adds/removes rows) via a ResizeObserver on `<body>`.
 *
 * Derives the fab's UNLIFTED base rect from LAYOUT properties — computed
 * `bottom` + `offsetHeight` — never from `getBoundingClientRect()`. Two
 * DOM-measurement approaches were tried and both broke on the same root
 * cause: `.fab` carries `transition: transform 0.12s ease`, so
 * `getBoundingClientRect()` reflects whatever the compositor has painted at
 * that instant — including mid-transition — not the settled target state.
 * (1) Temporarily zeroing `style.transform`, reading, then restoring: reads
 * the rect BEFORE the reset takes visual effect, i.e. still the previous
 * lift. (2) Tracking applied lift in a ref and subtracting it back out of
 * the current rect: still wrong whenever recompute fires mid-transition,
 * and confirmed (via instrumented logging) to produce a runaway feedback
 * loop — each wrong "base" feeding an overcorrected lift into the next
 * frame, oscillating by hundreds of pixels instead of converging.
 * `bottom` (computed style) and `offsetHeight` are plain layout properties
 * the `transform` transition never touches, so they're correct on every
 * call regardless of animation state — no DOM mutation, no timing
 * dependency, no feedback loop.
 *
 * ITERATES rather than computing a single pass (App Tester finding on this
 * ticket): with several rows stacked near the pill, lifting just enough to
 * clear the row it currently sits on can land it squarely on the row above,
 * which a single measurement never accounts for. Each iteration re-checks the
 * (virtual, not-yet-committed) lifted position against every avoided element
 * and adds any further lift still needed, until nothing intersects or the
 * iteration/height cap is hit — pure arithmetic on already-fetched rects, no
 * extra DOM reads per iteration.
 */
function useCollisionLift(fabRef: RefObject<HTMLButtonElement | null>, active: boolean) {
  const [lift, setLift] = useState(0);

  useEffect(() => {
    if (!active) {
      setLift(0);
      return;
    }
    let rafId = 0;
    let scheduled = false;

    function recompute() {
      scheduled = false;
      const fab = fabRef.current;
      if (!fab) return;

      // Derive the fab's UNLIFTED base rect from LAYOUT properties —
      // computed `bottom` and `offsetHeight` — never from
      // `getBoundingClientRect()`. That matters because `.fab` carries
      // `transition: transform 0.12s ease`: while a transition is
      // in-flight, `getBoundingClientRect()` reflects whatever the
      // compositor has painted at that instant, not the final state — so
      // reading it (even via "current minus already-applied lift") during
      // a still-animating frame fed back a WRONG base into the next
      // iteration, which produced a runaway oscillation (confirmed via
      // instrumented logging: successive recomputes swinging by hundreds of
      // pixels instead of converging). `bottom`/`offsetHeight` are plain
      // layout properties the `transform` transition never touches, so they
      // are correct on every call regardless of animation state — no DOM
      // mutation, no timing dependency.
      const computedBottom = parseFloat(getComputedStyle(fab).bottom) || 0;
      const height = fab.offsetHeight;
      const baseBottom = window.innerHeight - computedBottom;
      const baseTop = baseBottom - height;
      // Horizontal extent is unaffected by the (vertical-only) lift
      // transform at any point in its transition, so reading it live is safe.
      const { left: baseLeft, right: baseRight } = fab.getBoundingClientRect();

      const targets = Array.from(document.querySelectorAll<HTMLElement>(AVOID_SELECTOR)).map((el) =>
        el.getBoundingClientRect(),
      );
      const cap = window.innerHeight * MAX_LIFT_RATIO;

      let newLift = 0;
      for (let i = 0; i < MAX_LIFT_ITERATIONS && newLift < cap; i++) {
        const top = baseTop - newLift;
        const bottom = baseBottom - newLift;
        let needed = 0;
        for (const r of targets) {
          const intersects = baseLeft < r.right && baseRight > r.left && top < r.bottom && bottom > r.top;
          if (intersects) {
            // To clear this target (pill fully ABOVE it, i.e. smaller screen
            // Y), the pill's (virtual) bottom edge must end up at or above
            // r.top minus the gap: `bottom - additionalLift <= r.top - GAP`.
            // Solving for the additional lift needed: `bottom - r.top + GAP`.
            needed = Math.max(needed, bottom - r.top + LIFT_GAP);
          }
        }
        if (needed <= 0) break;
        newLift += needed;
      }
      newLift = Math.min(newLift, cap);
      setLift(newLift);
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      rafId = requestAnimationFrame(recompute);
    }

    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
    };
  }, [active, fabRef]);

  return lift;
}

/**
 * Global feedback widget (TICKET-11). Mounted once in app/layout.tsx so it rides
 * every patron page and the host view — but NEVER on /tv (a passive venue screen;
 * TV problems get reported from phones, spec AC7).
 *
 * A small floating pill opens a bottom sheet where a single sentiment tap sends
 * feedback (2 taps total). Unobtrusive by design.
 */
export function FeedbackWidget() {
  const pathname = usePathname();
  const t = useTranslations("Feedback");
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const lift = useCollisionLift(fabRef, !open);

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
       * TICKET-71: reserved-space spacer. The widget mounts once in
       * app/layout.tsx after `{children}`, so this normal-flow block becomes
       * trailing space at the end of every page's scrollable content —
       * pushing the last row/button on a scrolled-to-bottom page clear of the
       * fixed pill, on every page that renders this widget, without each
       * page having to reserve the space itself. See the CSS module for the
       * sizing rationale. Kept unconditional (not tied to `open`) so opening
       * the sheet never shifts page layout.
       */}
      <div className={styles.spacer} data-testid="feedback-pill-spacer" aria-hidden="true" />
      {!open && (
        <button
          ref={fabRef}
          type="button"
          className={styles.fab}
          aria-label={t("trigger")}
          onClick={() => setOpen(true)}
          style={lift > 0 ? { transform: `translateY(-${lift}px)` } : undefined}
        >
          <span className={styles.fabIcon} aria-hidden>
            💬
          </span>
          {t("trigger")}
        </button>
      )}

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
