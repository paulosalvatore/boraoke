"use client";

import { useState, useEffect, useCallback } from "react";
import type { AnalyticsSummary } from "@/lib/analytics";
import styles from "./analytics.module.css";

/**
 * /admin/analytics — READ-ONLY site-wide admin analytics (TICKET-31).
 *
 * Shows karaoke days-over-time, top played songs, and per-room activity,
 * computed live from the existing telemetry store. This is a fresh route —
 * `app/admin/page.tsx` stays the legacy `/default/admin` redirect, untouched.
 *
 * AUTH: reuses the SAME host-session gate as `/[room]/admin` (see
 * `/api/host/login`, `/api/host/session`), scoped to the `default` room — i.e.
 * the site's existing HOST_TOKEN. No new auth mechanism, no new secret.
 * Decision documented in work/tickets/TICKET-31-admin-analytics.md.
 *
 * No i18n: this is internal TL-facing tooling, not patron-facing UI — a
 * deliberate, documented scope call for this ticket (unlike /[room]/admin,
 * which patrons never see either but follows the app's existing i18n
 * convention since it shares a locale context with patron pages).
 */

type Auth = "checking" | "gate" | "authed";

const ROOM = "default";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function AdminAnalyticsPage() {
  const [auth, setAuth] = useState<Auth>("checking");
  const [configured, setConfigured] = useState(true);
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [from, setFrom] = useState(daysAgoISO(29));
  const [to, setTo] = useState(todayISO());
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/host/session?room=${ROOM}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      setConfigured(body.configured !== false);
      setAuth(res.ok ? "authed" : "gate");
    } catch {
      setAuth("gate");
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(
        `/api/admin/analytics?from=${from}&to=${to}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error || `Failed to load (${res.status})`);
        setData(null);
        return;
      }
      setData(await res.json());
    } catch {
      setLoadError("Network error loading analytics");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (auth === "authed") void loadData();
  }, [auth, loadData]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError("");
    try {
      const res = await fetch(`/api/host/login?room=${ROOM}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setToken("");
        setAuth("authed");
      } else {
        const body = await res.json().catch(() => ({}));
        setLoginError(body.error || "Login failed");
      }
    } catch {
      setLoginError("Network error");
    } finally {
      setLoggingIn(false);
    }
  }

  if (auth === "checking") {
    return (
      <div className={styles.wrap}>
        <p className={styles.empty}>Loading…</p>
      </div>
    );
  }

  if (auth === "gate") {
    return (
      <div className={styles.wrap}>
        <form className={styles.gate} onSubmit={handleLogin}>
          <div className={styles.wordmark}>Admin analytics</div>
          {!configured && (
            <p className={styles.error}>
              Host controls are not configured for this site (HOST_TOKEN unset).
            </p>
          )}
          <input
            className={styles.input}
            type="password"
            placeholder="Host token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          {loginError && <p className={styles.error}>{loginError}</p>}
          <button className={styles.button} type="submit" disabled={loggingIn || !token}>
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  const maxDayEvents = data ? Math.max(1, ...data.days.map((d) => d.events)) : 1;

  return (
    <div className={styles.wrap}>
      <div className={styles.top}>
        <div className={styles.wordmark}>Admin analytics</div>
        <span className={styles.tag}>read-only</span>
        <div className={styles.spacer} />
      </div>

      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="from">From</label>
          <input
            id="from"
            className={styles.input}
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="to">To</label>
          <input
            id="to"
            className={styles.input}
            type="date"
            value={to}
            min={from}
            max={todayISO()}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <button className={styles.button} onClick={() => void loadData()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {loadError && <p className={styles.error}>{loadError}</p>}

      {data && (
        <>
          <section className={styles.section}>
            <div className={styles.sectionTitle}>
              Karaoke days — {data.fromDay} → {data.toDay}
            </div>
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <span className={styles.statValue}>{data.totalActiveDays}</span>
                <span className={styles.statLabel}>Active days</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{data.totalSessions}</span>
                <span className={styles.statLabel}>Sessions</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{data.totalEvents}</span>
                <span className={styles.statLabel}>Events</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{data.rooms.length}</span>
                <span className={styles.statLabel}>Rooms active in range</span>
              </div>
            </div>
            {data.days.length > 0 ? (
              <div className={styles.dayBars} title="Events per day">
                {data.days.map((d) => (
                  <div
                    key={d.day}
                    className={`${styles.dayBar} ${d.events === 0 ? styles.dayBarEmpty : ""}`}
                    style={{ height: `${Math.max(2, (d.events / maxDayEvents) * 120)}px` }}
                    title={`${d.day}: ${d.events} events, ${d.activeRooms} active room(s), ${d.sessions} session(s), ${d.songsPlayed} played`}
                  />
                ))}
              </div>
            ) : (
              <p className={styles.empty}>No events in range.</p>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}>Top songs</div>
            {data.topSongs.length > 0 ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Video ID</th>
                    <th>Plays</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topSongs.map((s, i) => (
                    <tr key={s.videoId}>
                      <td>{i + 1}</td>
                      <td>{s.title || <em>(no title recorded)</em>}</td>
                      <td>{s.videoId}</td>
                      <td>{s.playCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className={styles.empty}>No songs played in range.</p>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}>Rooms</div>
            {data.rooms.length > 0 ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Active days</th>
                    <th>Sessions</th>
                    <th>Patrons</th>
                    <th>Queued</th>
                    <th>Played</th>
                    <th>Skipped</th>
                    <th>Events</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rooms.map((r) => (
                    <tr key={r.roomId}>
                      <td>{r.roomId}</td>
                      <td>{r.activeDays}</td>
                      <td>{r.sessions}</td>
                      <td>{r.uniquePatrons}</td>
                      <td>{r.songsQueued}</td>
                      <td>{r.songsPlayed}</td>
                      <td>{r.songsSkipped}</td>
                      <td>{r.events}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className={styles.empty}>No room activity in range.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
