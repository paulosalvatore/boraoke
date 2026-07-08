"use client";

import { useState, useEffect, useCallback } from "react";
import type { QueueEntry } from "@/lib/store";
import { computeStats } from "@/components/host/stats";
import ModeSwitcher from "@/components/host/ModeSwitcher";
import { DEFAULT_ROOM_MODE, modeLabel, type RoomMode } from "@/lib/rotation-modes";
import QrCode from "@/components/QrCode";
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
}: {
  roomId: string;
  venueName?: string;
}) {
  const [auth, setAuth] = useState<Auth>("checking");
  const [configured, setConfigured] = useState(true);

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
    if (typeof window !== "undefined") setJoinUrl(`${window.location.origin}/${roomId}`);
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
        setLoginError("Controles do host ainda não configurados para este bar.");
      } else {
        setLoginError("Token inválido — tente de novo.");
      }
    } catch {
      setLoginError("Erro de rede — tente de novo.");
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
        setModeMsg(`Modo alterado para ${modeLabel(next)} — fila reordenada.`);
        window.setTimeout(() => setModeMsg(""), 4000);
      }
      await fetchQueue();
    } catch {
      await fetchQueue(); // revert to server truth
    } finally {
      setBusy(false);
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
        <p style={{ color: "var(--text-muted)" }}>Carregando…</p>
      </main>
    );
  }

  if (auth === "gate") {
    return (
      <main className={styles.gate}>
        <h1>🎤 Boraoke · admin</h1>
        <p style={{ marginBottom: "0.25rem" }}>{venueName ?? roomId}</p>
        <p>
          {configured
            ? "Entre com o código do host para controlar a fila."
            : "Controles do host ainda não configurados para este bar."}
        </p>
        {configured && (
          <form className={styles.gateForm} onSubmit={handleLogin}>
            <label htmlFor="host-token" className={styles.label}>
              Código do host
            </label>
            <input
              id="host-token"
              aria-label="Código do host"
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••"
            />
            {loginError && <p className={styles.error}>{loginError}</p>}
            <button className="btn-primary" type="submit" disabled={loggingIn || !token}>
              {loggingIn ? "Entrando…" : "Entrar"}
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
        <span className={styles.wordmark}>Boraoke</span>
        <span className={styles.chip}>{venueName ?? roomId}</span>
        {paused ? (
          <span className={styles.chipPaused}>⏸ Pausado</span>
        ) : (
          <span className={styles.chipLive}>AO VIVO</span>
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
          Sala do público ↗
        </a>
        <a
          className={styles.tvLink}
          data-testid="admin-tv-link"
          href={`/${roomId}/tv`}
          target="_blank"
          rel="noreferrer"
        >
          Abrir /tv ↗
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
        <section aria-label="Fila">
          <span className={styles.label}>Fila</span>
          {queue.length === 0 ? (
            <p className={styles.emptyQueue}>Fila vazia — manda a primeira! 🎤</p>
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
                        {entry.table ? <span className={styles.meta}> · Mesa {entry.table}</span> : null}
                        {entry.mode === "listen-dance" ? (
                          <span className={styles.meta}> · 🎶 só curtir</span>
                        ) : null}
                      </div>
                      <div className={styles.song}>
                        {entry.title ?? `youtu.be/${entry.videoId}`}
                      </div>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        className={styles.moveBtn}
                        aria-label={`Subir ${entry.nickname}`}
                        disabled={busy || idx === 0}
                        onClick={() => move(entry.id, idx - 1)}
                      >
                        ▲
                      </button>
                      <button
                        className={styles.moveBtn}
                        aria-label={`Descer ${entry.nickname}`}
                        disabled={busy || idx === queue.length - 1}
                        onClick={() => move(entry.id, idx + 1)}
                      >
                        ▼
                      </button>
                      {confirmingId === entry.id ? (
                        <span className={styles.confirm}>
                          <button className={styles.confirmYes} onClick={() => remove(entry.id)}>
                            Confirmar
                          </button>
                          <button className={styles.confirmNo} onClick={() => setConfirmingId(null)}>
                            Cancelar
                          </button>
                        </span>
                      ) : (
                        <button
                          className={styles.removeBtn}
                          aria-label={`Remover ${entry.nickname}`}
                          disabled={busy}
                          onClick={() => setConfirmingId(entry.id)}
                        >
                          remover
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
              {paused ? "▶ Retomar" : "⏸ Pausar"}
            </button>
            <button
              className={styles.ctrlBtn}
              onClick={skip}
              disabled={busy || queue.length === 0}
            >
              ⏭ Pular música
            </button>
            <button
              className={styles.ctrlBtn}
              onClick={skipNoShow}
              disabled={busy || queue.length === 0 || queue[0]?.mode === "listen-dance"}
              title="Cantor não veio: pula e devolve com 1 chance no próximo rodízio"
            >
              🙅 Não veio
            </button>
          </div>
        </section>

        {/* Right: stats + join link */}
        <section aria-label="A noite em números">
          <span className={styles.label}>A noite em números</span>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statN}>{stats.total}</div>
              <div className={styles.statL}>na fila hoje</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statN}>{stats.singers}</div>
              <div className={styles.statL}>cantores</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statN}>{stats.tables}</div>
              <div className={styles.statL}>mesas ativas</div>
            </div>
          </div>
          <div className={styles.joinCard}>
            <span className={styles.label}>Entrada do público</span>
            <p style={{ fontSize: "0.9rem" }}>QR na tela /tv ou link direto:</p>
            <p className={styles.joinUrl} data-testid="admin-join-url">{joinUrl || "…"}</p>
            {joinUrl ? (
              <div style={{ marginTop: "0.75rem" }}>
                <QrCode value={joinUrl} size={140} title="QR da sala" />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
