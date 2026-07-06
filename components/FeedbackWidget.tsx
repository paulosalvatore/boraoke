"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FeedbackSheet } from "./feedback/FeedbackSheet";
import styles from "./feedback/FeedbackWidget.module.css";

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
          aria-label="Enviar feedback"
          onClick={() => setOpen(true)}
        >
          <span className={styles.fabIcon} aria-hidden>
            💬
          </span>
          Feedback
        </button>
      )}

      {open && (
        <div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label="Enviar feedback"
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
