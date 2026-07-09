"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { QueueEntry } from "@/lib/store";
import { computeStats } from "@/components/host/stats";
import ModeSwitcher from "@/components/host/ModeSwitcher";
import { DEFAULT_ROOM_MODE, MODE_MESSAGE_KEY, type RoomMode } from "@/lib/rotation-modes";
import QrCode from "@/components/QrCode";
import {
  LOCALES,
  LOCALE_NATIVE_NAMES,
  DEFAULT_LOCALE,
  type Locale,
} from "@/i18n/locales";
import styles from "./admin.module.css";

const POLL_INTERVAL = 3000;

type Auth = "checking" | "gate" | "authed";

/**
 * Host controls for one room (TICKET-9). Every host/queue call carries
 * `?room=<id>` so the session cookie, queue, and actions all target THIS room —
 * two venues' admins never cross wires.
 */
export default function AdminRoom({
  roomId,
  venueName,
  initialLanguage,
}: {
  roomId: string;
  venueName?: string;
  /** Room default language resolved by the server page (TICKET-30). */
  initialLanguage?: Locale;
}) {
  // i18n (TICKET-30): all copy from the `Admin`/`Modes` catalogs. The dashboard
  // itself follows the HOST's locale (cookie flow); the room-language selector
  // below sets what the TV + patron first-visit default follow.
  const t = useTranslations("Admin");
  const tCommon = useTranslations("Common");
  const tModes = useTranslations("Modes");
  const [auth, setAuth] = useState<Auth>("checking");
  const [configured, setConfigured] = useState(true);
  // TICKET-43: landing "Suas salas" routes here with ?expired=1 when a remembered
  // created room's host cookie has lapsed — surface honest recovery copy on the
  // gate. Read from location to avoid the useSearchParams Suspense boundary.
  const [sessionExpired, setSessionExpired] = useState(false);

  // Login gate state
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  // Dashboard state
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<RoomMode>(DEFAULT_ROOM_MODE);
  const [modeMsg, setModeMsg] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinUrl, setJoinUrl] = useState("");
  // Room default language (TICKET-30) — optimistic select, POST /api/host/language.
  const [roomLanguage, setRoomLanguage] = useState<Locale>(
    initialLanguage ?? DEFAULT_LOCALE,
  );
  const [langBusy, setLangBusy] = useState(false);

  const roomQuery = `?room=${encodeURIComponent(roomId)}`;

  // Auth probe on load
  const checkSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/host/session${roomQuery}`);
      const data = await res.json().catch(() => ({}));
      setConfigured(data.configured !== false);
      setAuth(res.ok && data.authed ? "authed" : "gate");
    } catch {
      setAuth("gate");
    }
  }, [roomQuery]);

  useEffect(() => {
    checkSession();
    if (typeof window !== "undefined") {
      setJoinUrl(`${window.location.origin}/${roomId}`);
      try {
        setSessionExpired(new URLSearchParams(window.location.search).get("expired") === "1");
      } catch { /* no-op */ }
    }
  }, [checkSession, roomId]);

  // Poll queue + paused while authed (reuses the public queue endpoint)
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/queue${roomQuery}`);
      if (!res.ok) return;
      const data = await res.json();
      setQueue(data.items ?? []);
      setPaused(Boolean(data.paused));
      if (data.mode) setMode(data.mode as RoomMode);
    } catch {
      // network hiccup — next poll retries
    }
  }, [roomQuery]);

  useEffect(() => {
    if (auth !== "authed") return;
    fetchQueue();
    const interval = setInterval(fetchQueue, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [auth, fetchQueue]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    if (!token) return;
    setLoggingIn(true);
    try {
      const res = await fetch(`/api/host/login${roomQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setToken("");
        setAuth("authed");
      } else if (res.status === 503) {
        setLoginError(t("notConfigured"));
      } else {
        setLoginError(t("loginInvalid"));
      }
    } catch {
      setLoginError(tCommon("networkError"));
    } finally {
      setLoggingIn(false);
    }
  }

  async function hostAction(path: string, payload?: object) {
    setBusy(true);
    try {
      await fetch(`${path}${roomQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      await fetchQueue();
    } catch {
      // ignore — next poll reconciles
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(next: RoomMode) {
    if (next === mode || busy) return;
    setBusy(true);
    setMode(next); // optimistic — poll reconciles
    try {
      const res = await fetch(`/api/host/mode${roomQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (res.ok) {
        setModeMsg(
          t("modeChanged", { mode: tModes(`${MODE_MESSAGE_KEY[next]}Name`) }),
        );
        window.setTimeout(() => setModeMsg(""), 4000);
      }
      await fetchQueue();
    } catch {
      await fetchQueue(); // revert to server truth
    } finally {
      setBusy(false);
    }
  }

  async function changeLanguage(next: Locale) {
    if (next === roomLanguage || langBusy) return;
    setLangBusy(true);
    const prev = roomLanguage;
    setRoomLanguage(next); // optimistic
    try {
      const res = await fetch(`/api/host/language${roomQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) setRoomLanguage(prev);
    } catch {
      setRoomLanguage(prev);
    } finally {
      setLangBusy(false);
    }
  }

  const skip = () => hostAction("/api/host/skip");
  const skipNoShow = () => hostAction("/api/host/skip", { grace: true });
  const togglePause = () => hostAction("/api/host/pause", { paused: !paused });
  const remove = (id: string) => {
    setConfirmingId(null);
    hostAction("/api/host/remove", { entryId: id });
  };
  const move = (id: string, newIndex: number) =>
    hostAction("/api/host/reorder", { entryId: id, newIndex });

  // ── Login gate ────────────────────────────────────────────────────────────
  if (auth === "checking") {
    return (
      <main className={styles.gate}>
        <p style={{ color: "var(--text-muted)" }}>{tCommon("loading")}</p>
      </main>
    );
  }

  if (auth === "gate") {
    return (
      <main className={styles.gate}>
        <h1>🎤 {t("adminTitle")}</h1>
        <p style={{ marginBottom: "0.25rem" }}>{venueName ?? roomId}</p>
        {sessionExpired && configured && (
          <p data-testid="session-expired-notice" style={{ color: "#fbbf24", fontSize: "0.9rem", marginBottom: "0.25rem" }}>
            {t("sessionExpired")}
          </p>
        )}
        <p>
          {configured ? t("loginPrompt") : t("notConfigured")}
        </p>
        {configured && (
          <form className={styles.gateForm} onSubmit={handleLogin}>
            <label htmlFor="host-token" className={styles.label}>
              {t("hostCodeLabel")}
            </label>
            <input
              id="host-token"
              aria-label={t("hostCodeLabel")}
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••"
            />
            {loginError && <p className={styles.error}>{loginError}</p>}
            <button className="btn-primary" type="submit" disabled={loggingIn || !token}>
              {loggingIn ? t("loggingIn") : t("login")}
            </button>
          </form>
        )}
      </main>
    );
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────
  const stats = computeStats(queue);

  return (
    <main className={styles.wrap}>
      <header className={styles.top}>
        <span className={styles.wordmark}>{tCommon("brand")}</span>
        <span className={styles.chip}>{venueName ?? roomId}</span>
        {paused ? (
          <span className={styles.chipPaused}>{t("paused")}</span>
        ) : (
          <span className={styles.chipLive}>{t("live")}</span>
        )}
        <span className={styles.spacer} />
        {/* TICKET-20: quick jumps to the two customer-facing screens of THIS
            room, both in a new tab so the host keeps the admin open. */}
        <a
          className={styles.tvLink}
          data-testid="admin-patron-link"
          href={`/${roomId}`}
          target="_blank"
          rel="noreferrer"
        >
          {t("publicRoomLink")}
        </a>
        <a
          className={styles.tvLink}
          data-testid="admin-tv-link"
          href={`/${roomId}/tv`}
          target="_blank"
          rel="noreferrer"
        >
          {t("tvLink")}
        </a>
      </header>

      {/* Mode switcher — live (TICKET-10) */}
      <ModeSwitcher active={mode} onChange={changeMode} disabled={busy} />
      {modeMsg && (
        <p className={styles.soonNote} role="status" data-testid="mode-toast">
          {modeMsg}
        </p>
      )}

      <div className={styles.cols}>
        {/* Left: queue + controls */}
        <section aria-label={t("queue")}>
          <span className={styles.label}>{t("queue")}</span>
          {queue.length === 0 ? (
            <p className={styles.emptyQueue}>{t("emptyQueue")}</p>
          ) : (
            <ol className={styles.queue} style={{ listStyle: "none" }}>
              {queue.map((entry, idx) => {
                const isPlaying = idx === 0;
                return (
                  <li
                    key={entry.id}
                    className={`${styles.row} ${isPlaying ? styles.rowPlaying : ""}`}
                    data-testid="queue-row"
                  >
                    <span className={`${styles.pos} ${isPlaying ? styles.posPlaying : ""}`}>
                      {isPlaying ? "▶" : idx + 1}
                    </span>
                    <div className={styles.songInfo}>
                      <div className={styles.who}>
                        {entry.nickname}
                        {entry.table ? <span className={styles.meta}> · {tCommon("table")} {entry.table}</span> : null}
                        {entry.mode === "listen-dance" ? (
                          <span className={styles.meta}> · {t("listenOnly")}</span>
                        ) : null}
                      </div>
                      <div className={styles.song}>
                        {entry.title ?? `youtu.be/${entry.videoId}`}
                      </div>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        className={styles.moveBtn}
                        aria-label={t("moveUp", { nickname: entry.nickname })}
                        disabled={busy || idx === 0}
                        onClick={() => move(entry.id, idx - 1)}
                      >
                        ▲
                      </button>
                      <button
                        className={styles.moveBtn}
                        aria-label={t("moveDown", { nickname: entry.nickname })}
                        disabled={busy || idx === queue.length - 1}
                        onClick={() => move(entry.id, idx + 1)}
                      >
                        ▼
                      </button>
                      {confirmingId === entry.id ? (
                        <span className={styles.confirm}>
                          <button className={styles.confirmYes} onClick={() => remove(entry.id)}>
                            {t("confirm")}
                          </button>
                          <button className={styles.confirmNo} onClick={() => setConfirmingId(null)}>
                            {t("cancel")}
                          </button>
                        </span>
                      ) : (
                        <button
                          className={styles.removeBtn}
                          aria-label={t("removeAria", { nickname: entry.nickname })}
                          disabled={busy}
                          onClick={() => setConfirmingId(entry.id)}
                        >
                          {t("remove")}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className={styles.controls}>
            <button
              className={`${styles.ctrlBtn} ${paused ? styles.ctrlBtnActive : ""}`}
              onClick={togglePause}
              disabled={busy}
            >
              {paused ? t("resume") : t("pause")}
            </button>
            <button
              className={styles.ctrlBtn}
              onClick={skip}
              disabled={busy || queue.length === 0}
            >
              {t("skipSong")}
            </button>
            <button
              className={styles.ctrlBtn}
              onClick={skipNoShow}
              disabled={busy || queue.length === 0 || queue[0]?.mode === "listen-dance"}
              title={t("noShowTitle")}
            >
              {t("noShow")}
            </button>
          </div>
        </section>

        {/* Right: stats + join link */}
        <section aria-label={t("statsTitle")}>
          <span className={styles.label}>{t("statsTitle")}</span>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statN}>{stats.total}</div>
              <div className={styles.statL}>{t("statInQueue")}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statN}>{stats.singers}</div>
              <div className={styles.statL}>{t("statSingers")}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statN}>{stats.tables}</div>
              <div className={styles.statL}>{t("statTables")}</div>
            </div>
          </div>
          <div className={styles.joinCard} data-testid="room-language-card">
            <span className={styles.label}>
              <label htmlFor="room-language">{t("languageLabel")}</label>
            </span>
            <select
              id="room-language"
              data-testid="room-language-select"
              aria-label={t("languageLabel")}
              value={roomLanguage}
              disabled={langBusy}
              onChange={(e) => void changeLanguage(e.target.value as Locale)}
              style={{ marginTop: "0.5rem" }}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_NATIVE_NAMES[l]}
                </option>
              ))}
            </select>
            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
              {t("languageHint")}
            </p>
          </div>
          <div className={styles.joinCard}>
            <span className={styles.label}>{t("publicEntrance")}</span>
            <p style={{ fontSize: "0.9rem" }}>{t("joinHint")}</p>
            <p className={styles.joinUrl} data-testid="admin-join-url">{joinUrl || "…"}</p>
            {joinUrl ? (
              <div style={{ marginTop: "0.75rem" }}>
                <QrCode value={joinUrl} size={140} title={t("qrTitle")} />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
