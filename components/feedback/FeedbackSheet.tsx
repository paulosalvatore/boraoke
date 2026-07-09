"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Category, Sentiment } from "@/lib/feedback-types";
import { useFeedbackContext } from "./useFeedbackContext";
import styles from "./FeedbackWidget.module.css";

/**
 * The feedback sheet. Zero-friction: tapping a sentiment IS the submit action,
 * so sentiment-only feedback lands in 2 taps total (open FAB + tap a face). Any
 * text/category the patron chose beforehand rides along. Everything but the
 * sentiment tap is optional.
 */

// i18n (TICKET-30): labels moved to messages, keyed off the stable `key`. The
// emoji + key stay here (data, not copy); the label is looked up per locale.
const SENTIMENT_DEFS: readonly { key: Sentiment; emoji: string; labelKey: string }[] = [
  { key: "love", emoji: "😍", labelKey: "sentimentLove" },
  { key: "happy", emoji: "🙂", labelKey: "sentimentHappy" },
  { key: "meh", emoji: "😕", labelKey: "sentimentMeh" },
  { key: "angry", emoji: "😡", labelKey: "sentimentAngry" },
];

const CATEGORY_DEFS: readonly { key: Category; labelKey: string }[] = [
  { key: "song-search", labelKey: "catSongSearch" },
  { key: "queue-fairness", labelKey: "catQueueFairness" },
  { key: "tv-player", labelKey: "catTvPlayer" },
  { key: "other", labelKey: "catOther" },
];

type Phase = "form" | "sending" | "done" | "error";

export function FeedbackSheet({ onClose }: { onClose: () => void }) {
  const t = useTranslations("Feedback");
  const { buildContext } = useFeedbackContext();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [errorMsg, setErrorMsg] = useState("");

  async function submit(sentiment: Sentiment) {
    if (phase === "sending") return;
    const context = buildContext();
    if (!context) {
      setErrorMsg(t("errorNoIdentity"));
      setPhase("error");
      return;
    }
    setPhase("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sentiment,
          text: text.trim() || undefined,
          category: category ?? undefined,
          context,
        }),
      });
      if (res.ok) {
        setPhase("done");
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setErrorMsg(data?.error ?? t("errorSend"));
      setPhase("error");
    } catch {
      setErrorMsg(t("errorOffline"));
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <div className={styles.confirm}>
        <div className={styles.confirmEmoji}>🎤</div>
        <p className={styles.confirmTitle}>{t("thanks")}</p>
        <p className={styles.confirmBody}>{t("thanksBody")}</p>
        <button
          type="button"
          className={styles.confirmBtn}
          onClick={onClose}
          autoFocus
        >
          {t("close")}
        </button>
      </div>
    );
  }

  const sending = phase === "sending";

  return (
    <>
      <div className={styles.header}>
        <p className={styles.title}>{t("title")}</p>
        <button
          type="button"
          className={styles.close}
          aria-label={t("close")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className={styles.subtitle}>{t("subtitle")}</p>

      <div className={styles.sentiments} role="group" aria-label={t("sentimentAria")}>
        {SENTIMENT_DEFS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={styles.sentiment}
            disabled={sending}
            aria-label={t(s.labelKey)}
            onClick={() => submit(s.key)}
          >
            <span className={styles.sentimentEmoji} aria-hidden>
              {s.emoji}
            </span>
            <span className={styles.sentimentLabel}>{t(s.labelKey)}</span>
          </button>
        ))}
      </div>

      <textarea
        className={styles.textarea}
        placeholder={t("textPlaceholder")}
        maxLength={1000}
        value={text}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
      />

      <p className={styles.chipsLabel}>{t("categoryLabel")}</p>
      <div className={styles.chips} role="group" aria-label={t("categoryAria")}>
        {CATEGORY_DEFS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={
              category === c.key
                ? `${styles.chip} ${styles.chipActive}`
                : styles.chip
            }
            aria-pressed={category === c.key}
            disabled={sending}
            onClick={() => setCategory(category === c.key ? null : c.key)}
          >
            {t(c.labelKey)}
          </button>
        ))}
      </div>

      {sending ? (
        <p className={styles.hint}>
          <span className={styles.spinner} aria-hidden /> {t("sending")}
        </p>
      ) : (
        <p className={styles.hint}>{t("sendHint")}</p>
      )}

      {phase === "error" && <p className={styles.error}>{errorMsg}</p>}
    </>
  );
}
