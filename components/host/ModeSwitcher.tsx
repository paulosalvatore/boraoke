"use client";

import { useTranslations } from "next-intl";
import { MODE_META, MODE_MESSAGE_KEY, type RoomMode } from "@/lib/rotation-modes";
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
  // i18n (TICKET-30): card copy from the `Modes` catalog (pt-BR values verbatim
  // from MODE_META / the design mockup — still the rotation-rule docs).
  const t = useTranslations("Modes");
  return (
    <section aria-label={t("sectionLabel")}>
      <span className="label" style={{ display: "block", marginBottom: "0.5rem" }}>
        {t("sectionLabel")}
      </span>
      <div className={styles.modes} role="radiogroup" aria-label={t("groupAria")}>
        {MODE_META.map((m) => {
          const isActive = m.mode === active;
          const name = t(`${MODE_MESSAGE_KEY[m.mode]}Name`);
          return (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-label={name}
              data-mode={m.mode}
              data-testid={`mode-option-${m.mode}`}
              className={`${styles.option} ${isActive ? styles.active : ""}`}
              disabled={disabled || isActive}
              onClick={() => onChange(m.mode)}
            >
              <div className={styles.name}>{name}</div>
              <div className={styles.rule}>{t(`${MODE_MESSAGE_KEY[m.mode]}Rule`)}</div>
              {isActive && <span className={styles.chip}>{t("active")}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
