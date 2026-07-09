"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  LOCALES,
  LOCALE_NATIVE_NAMES,
  LOCALE_SHORT_LABEL,
  type Locale,
} from "@/i18n/locales";
import { setLocale } from "@/i18n/set-locale";
import styles from "./LanguageSwitcher.module.css";

/**
 * Language switcher (TICKET-30, design §3 + switchers.html mockup): a globe pill
 * (`🌐 PT`) that opens a popover (desktop) / bottom sheet (mobile — CSS-driven)
 * listing locales as NATIVE names ("Português (Brasil)", "English", "Español"),
 * a check on the active one. NEVER flags (a flag is a country, not a language).
 *
 * Picking a locale calls the `setLocale` server action (writes NEXT_LOCALE) and
 * refreshes the route — no URL change (rooms stay /<room>). Landing + patron
 * carry it (persistent). TV has NONE by design (it follows the room language).
 */
export default function LanguageSwitcher() {
  const active = useLocale() as Locale;
  const t = useTranslations("Lang");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(locale: Locale) {
    setOpen(false);
    if (locale === active) return;
    startTransition(async () => {
      await setLocale(locale);
      // Re-render the current route with the new cookie-driven locale. No push:
      // the URL does not change.
      router.refresh();
    });
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.pill}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("trigger")}
        data-testid="lang-switcher-trigger"
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>🌐</span>
        <span>{LOCALE_SHORT_LABEL[active]}</span>
      </button>

      {open && (
        <div
          className={styles.sheet}
          role="menu"
          aria-label={t("sheetTitle")}
          data-testid="lang-switcher-menu"
        >
          <div className={styles.sheetHeader}>{t("sheetTitle")}</div>
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              role="menuitemradio"
              aria-checked={locale === active}
              className={styles.item}
              data-testid={`lang-option-${locale}`}
              onClick={() => choose(locale)}
            >
              <span>{LOCALE_NATIVE_NAMES[locale]}</span>
              {locale === active && (
                <span className={styles.check} aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ))}
          <div className={styles.hint}>{t("hint")}</div>
        </div>
      )}
    </div>
  );
}
