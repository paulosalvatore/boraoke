"use client";

import { useState } from "react";
import type { Category, Sentiment } from "@/lib/feedback-types";
import { useFeedbackContext } from "./useFeedbackContext";
import styles from "./FeedbackWidget.module.css";

/**
 * The feedback sheet. Zero-friction: tapping a sentiment IS the submit action,
 * so sentiment-only feedback lands in 2 taps total (open FAB + tap a face). Any
 * text/category the patron chose beforehand rides along. Everything but the
 * sentiment tap is optional.
 */

interface SentimentDef {
  key: Sentiment;
  emoji: string;
  label: string;
}
const SENTIMENT_DEFS: readonly SentimentDef[] = [
  { key: "love", emoji: "😍", label: "Amei" },
  { key: "happy", emoji: "🙂", label: "Curti" },
  { key: "meh", emoji: "😕", label: "Meh" },
  { key: "angry", emoji: "😡", label: "Odiei" },
];

interface CategoryDef {
  key: Category;
  label: string;
}
const CATEGORY_DEFS: readonly CategoryDef[] = [
  { key: "song-search", label: "Busca de música" },
  { key: "queue-fairness", label: "Fila / vez" },
  { key: "tv-player", label: "Player da TV" },
  { key: "other", label: "Outro" },
];

type Phase = "form" | "sending" | "done" | "error";

export function FeedbackSheet({ onClose }: { onClose: () => void }) {
  const { buildContext } = useFeedbackContext();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [errorMsg, setErrorMsg] = useState("");

  async function submit(sentiment: Sentiment) {
    if (phase === "sending") return;
    const context = buildContext();
    if (!context) {
      setErrorMsg("Não consegui te identificar. Recarrega a página e tenta de novo.");
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
      setErrorMsg(
        data?.error ?? "Deu ruim ao enviar. Tenta de novo em instantes.",
      );
      setPhase("error");
    } catch {
      setErrorMsg("Sem conexão? Tenta de novo em instantes.");
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <div className={styles.confirm}>
        <div className={styles.confirmEmoji}>🎤</div>
        <p className={styles.confirmTitle}>Valeu!</p>
        <p className={styles.confirmBody}>
          Um robô supervisionado por humanos lê cada um desses. Fica de olho no
          changelog. 🚀
        </p>
        <button
          type="button"
          className={styles.confirmBtn}
          onClick={onClose}
          autoFocus
        >
          Fechar
        </button>
      </div>
    );
  }

  const sending = phase === "sending";

  return (
    <>
      <div className={styles.header}>
        <p className={styles.title}>Como tá sendo? 🎶</p>
        <button
          type="button"
          className={styles.close}
          aria-label="Fechar"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className={styles.subtitle}>
        Toca numa carinha pra mandar — rapidão, sem login.
      </p>

      <div className={styles.sentiments} role="group" aria-label="Sentimento">
        {SENTIMENT_DEFS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={styles.sentiment}
            disabled={sending}
            aria-label={s.label}
            onClick={() => submit(s.key)}
          >
            <span className={styles.sentimentEmoji} aria-hidden>
              {s.emoji}
            </span>
            <span className={styles.sentimentLabel}>{s.label}</span>
          </button>
        ))}
      </div>

      <textarea
        className={styles.textarea}
        placeholder="Quer contar mais? (opcional)"
        maxLength={1000}
        value={text}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
      />

      <p className={styles.chipsLabel}>Sobre o quê? (opcional)</p>
      <div className={styles.chips} role="group" aria-label="Categoria">
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
            {c.label}
          </button>
        ))}
      </div>

      {sending ? (
        <p className={styles.hint}>
          <span className={styles.spinner} aria-hidden /> Enviando…
        </p>
      ) : (
        <p className={styles.hint}>É só tocar numa carinha pra enviar.</p>
      )}

      {phase === "error" && <p className={styles.error}>{errorMsg}</p>}
    </>
  );
}
