"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import SavedRooms from "@/components/SavedRooms";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import styles from "./page.module.css";

/**
 * Landing — Direction 2 "Demo vivo" (TICKET-69).
 *
 * The hero IS the product: a STATIC mock of the /tv screen (now-playing hero +
 * up-next rail with nicknames and tables + the rotation-mode tag) with a QR
 * phone card hanging off it, so a visitor sees QR-join, the queue, tables and
 * fairness before reading a word. Approved reference:
 * work/design/landing-rethink/mockup-2-demo-vivo.html (Direction 2 of
 * work/design/landing-rethink/PROPOSAL.md).
 *
 * The mock is PRESENTATIONAL ONLY — no YouTube iframe, no API call, no queue
 * polling. The landing must stay instant and must not depend on any service.
 * It is exposed to assistive tech as a single labelled image (role="img" +
 * aria-label) rather than as a wall of fake queue rows.
 *
 * Everything the copy claims is shipped today (QR join + tables, YouTube search
 * and URL paste, /tv auto-advance, the three rotation modes, sing/listen,
 * pt-BR/en/es). Accounts, theming presets, per-venue presets and payments do
 * NOT exist and are deliberately not advertised — the venue chips widen the
 * framing without promising per-venue behaviour.
 *
 * Carried over unchanged from the previous landing: the join-by-code input, the
 * SavedRooms device-recovery card (TICKET-43) and the LanguageSwitcher.
 * All copy comes from the `Landing` catalog (TICKET-30) — no hardcoded strings.
 */
export default function Landing() {
  const t = useTranslations("Landing");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [lastRoom, setLastRoom] = useState("");

  useEffect(() => {
    try {
      // NOTE: storage key intentionally kept as `cantai_last_room` — it is live
      // state on users' devices (see TICKET-33 storage-key decision). Renaming
      // it would drop every returning patron's last-room quick-entry.
      const last = window.localStorage.getItem("cantai_last_room");
      if (last) setLastRoom(last);
    } catch { /* sandboxed */ }
  }, []);

  function normalize(v: string): string {
    // Accept a raw code, or a pasted join URL — take the last path segment.
    const trimmed = v.trim();
    const fromUrl = trimmed.replace(/^https?:\/\/[^/]+\//i, "").split(/[/?#]/)[0];
    return (fromUrl || trimmed).toLowerCase();
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    const room = normalize(code);
    if (!room) return;
    router.push(`/${encodeURIComponent(room)}`);
  }

  const upNext = [
    { title: t("demoNext1Title"), who: t("demoNext1Who") },
    { title: t("demoNext2Title"), who: t("demoNext2Who") },
    { title: t("demoNext3Title"), who: t("demoNext3Who") },
    { title: t("demoNext4Title"), who: t("demoNext4Who") },
  ];

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.brand}>🎤 {tCommon("brand")}</div>
        <div className={styles.headerRight}>
          <span className={styles.pill}>{t("earlyAccess")}</span>
          <LanguageSwitcher />
        </div>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="landing-hero-title">
          <div>
            <ul className={styles.chips} aria-label={t("venuesLabel")}>
              <li className={styles.chipOn}>{t("chipBar")}</li>
              <li>{t("chipParty")}</li>
              <li>{t("chipCondo")}</li>
              <li>{t("chipCompany")}</li>
            </ul>

            <h1 id="landing-hero-title">
              {t.rich("heroTitle", { em: (chunks) => <em>{chunks}</em> })}
            </h1>
            <p className={styles.heroSub}>{t("heroSub")}</p>

            <Link className={`btn-primary ${styles.cta}`} href="/new">
              {t("createCta")}
            </Link>
            <p className={styles.fine}>{t("createFine")}</p>
          </div>

          {/* Static product mock — one labelled image for assistive tech. */}
          <div className={styles.stage} role="img" aria-label={t("demoAlt")}>
            <span className={styles.rotationTag}>{t("demoRotationTag")}</span>
            <div className={styles.tv}>
              <div className={styles.screen}>
                <div className={styles.now}>
                  <div className={styles.thumb} aria-hidden>▶️</div>
                  <div>
                    <span className={styles.nowLabel}>{t("demoNowLabel")}</span>
                    <p className={styles.nowTitle}>{t("demoNowTitle")}</p>
                    <p className={styles.nowMeta}>{t("demoNowMeta")}</p>
                  </div>
                </div>
                <div className={styles.rail}>
                  <span className={styles.railLabel}>{t("demoNextLabel")}</span>
                  <ol>
                    {upNext.map((row) => (
                      <li key={row.title}>
                        <span>{row.title}</span>
                        <span className={styles.who}>{row.who}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
            <div className={styles.phone}>
              <div className={styles.qr}>
                <svg viewBox="0 0 21 21" aria-hidden="true">
                  <path
                    fill="#0d0d0d"
                    d="M0 0h7v7H0zM2 2h3v3H2zM14 0h7v7h-7zM16 2h3v3h-3zM0 14h7v7H0zM2 16h3v3H2zM9 0h1v2H9zM11 0h2v1h-2zM12 2h1v3h-1zM9 3h2v1H9zM9 5h1v2H9zM11 6h2v1h-2zM0 9h1v2H0zM2 9h2v1H2zM5 9h2v2H5zM3 11h1v2H3zM0 12h2v1H0zM5 12h1v2H5zM8 8h2v2H8zM11 8h1v2h-1zM13 9h2v1h-2zM16 8h1v2h-1zM18 9h3v1h-3zM8 11h1v3H8zM10 11h3v2h-3zM14 11h1v2h-1zM16 11h2v1h-2zM19 11h2v2h-2zM9 14h2v2H9zM12 14h1v1h-1zM14 14h3v3h-3zM18 14h1v2h-1zM20 14h1v3h-1zM9 17h1v2H9zM11 17h2v1h-2zM12 19h3v2h-3zM16 18h2v2h-2zM19 18h1v1h-1zM20 19h1v2h-1zM9 20h2v1H9z"
                  />
                </svg>
              </div>
              <p>
                <strong>{t("demoPhoneTitle")}</strong>
                {t("demoPhoneBody")}
              </p>
            </div>
          </div>
        </section>

        <section className={styles.bullets} aria-label={t("featuresLabel")}>
          <div className={styles.bullet}>
            <h2>{t("feature1Title")}</h2>
            <p>{t("feature1Body")}</p>
          </div>
          <div className={styles.bullet}>
            <h2>{t("feature2Title")}</h2>
            <p>{t("feature2Body")}</p>
          </div>
          <div className={styles.bullet}>
            <h2>{t("feature3Title")}</h2>
            <p>{t("feature3Body")}</p>
          </div>
        </section>

        {/* TICKET-43: device-level remembered rooms (renders nothing when empty). */}
        <SavedRooms />

        <section className={styles.joinStrip}>
          <h2>{t("haveCode")}</h2>
          <form onSubmit={join} className={styles.joinForm}>
            <input
              aria-label={t("codeLabel")}
              placeholder={t("codePlaceholder")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={styles.joinInput}
            />
            <button className={`btn-primary ${styles.joinBtn}`} type="submit" disabled={!code.trim()}>
              {t("enter")}
            </button>
          </form>
          <p className={styles.joinHint}>{t("haveCodeHint")}</p>
          {lastRoom && (
            <p className={styles.lastRoom}>
              {t("lastRoom")}{" "}
              <Link href={`/${lastRoom}`} data-testid="last-room-link">
                {lastRoom}
              </Link>
            </p>
          )}
        </section>
      </main>

      <footer className={styles.footer}>
        <span className={styles.freePromise}>{t("freePromise")}</span>{" "}
        <span>{t("footer")}</span>
      </footer>
    </div>
  );
}
