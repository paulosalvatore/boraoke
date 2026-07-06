"use client";

import { MODE_META, type RoomMode } from "@/lib/rotation-modes";
import styles from "./ModeSwitcher.module.css";

/**
 * Venue rotation-mode switcher (TICKET-10) — three cards from the design mockup
 * (§5), copy verbatim (it doubles as the bar owner's rotation-rule docs). The
 * active mode carries the `ATIVO` chip; switching applies immediately with no
 * confirm (mode changes are reversible). Renders as a `radiogroup`.
 */
export default function ModeSwitcher({
  active,
  onChange,
  disabled = false,
}: {
  active: RoomMode;
  onChange: (mode: RoomMode) => void;
  disabled?: boolean;
}) {
  return (
    <section aria-label="Modo da noite">
      <span className="label" style={{ display: "block", marginBottom: "0.5rem" }}>
        Modo da noite
      </span>
      <div className={styles.modes} role="radiogroup" aria-label="Modo de rodízio">
        {MODE_META.map((m) => {
          const isActive = m.mode === active;
          return (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-label={m.name}
              data-mode={m.mode}
              data-testid={`mode-option-${m.mode}`}
              className={`${styles.option} ${isActive ? styles.active : ""}`}
              disabled={disabled || isActive}
              onClick={() => onChange(m.mode)}
            >
              <div className={styles.name}>{m.name}</div>
              <div className={styles.rule}>{m.rule}</div>
              {isActive && <span className={styles.chip}>ATIVO</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
