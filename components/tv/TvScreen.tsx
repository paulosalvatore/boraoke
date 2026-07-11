"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { QueueEntry } from "@/lib/store";
import QrCode from "@/components/QrCode";
import styles from "./tv.module.css";
import {
  isFatalPlayerError,
  createStallState,
  stallTick,
  bootstrapRetryDelayMs,
  BOOTSTRAP_READY_TIMEOUT_MS,
  type StallState,
} from "./watchdog";
import {
  shouldProactivelyReload,
  shouldReactivelyReload,
} from "./self-heal";

declare global {
  interface Window {
    YT: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId?: string;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: { data: number }) => void;
            onError?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}

interface YTPlayer {
  loadVideoById(videoId: string): void;
  stopVideo(): void;
  destroy(): void;
  getCurrentTime?(): number;
  getPlayerState?(): number;
  seekTo?(seconds: number, allowSeekAhead: boolean): void;
  playVideo?(): void;
}

/** Minimal WakeLock typings — the lib.dom versions are still flaky across TS targets. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

const POLL_INTERVAL = 3000;
const CHROME_HIDE_MS = 4000;
/** Watchdog getCurrentTime() sampling cadence (TICKET-41). */
const WATCHDOG_POLL_MS = 3000;
/** How long the pt-BR "pulando vídeo indisponível" notice stays up. */
const SKIP_NOTICE_MS = 4000;

/** sessionStorage key: timestamp (ms) of the last reactive (401) self-heal reload. */
const SELF_HEAL_MARKER_KEY = "boraoke-tv-selfheal-reload";

export default function TvScreen({
  poweredByFooter,
  roomId,
  venueName,
  screenToken,
  screenTokenMintedAt,
}: {
  poweredByFooter: boolean;
  /** Room whose queue this screen plays. Omitted = legacy `default` room. */
  roomId?: string;
  /** Venue display name for the top bar (falls back to a generic label). */
  venueName?: string;
  /**
   * Advance-auth screen token (TICKET-45), minted by the /[room]/tv server page
   * from the room's server-only secret. Sent as `X-Boraoke-Screen` on advance so
   * the route can authorize the skip. `null`/absent for a no-key room (the TV
   * then sends no header and enforcement is off for that room).
   */
  screenToken?: string | null;
  /**
   * Mint time (ms epoch) of `screenToken`, captured server-side next to the mint
   * call (TICKET-46). NOT secret material — just a timestamp — so the client can
   * compute token age and proactively reload (when idle) before the token's ≤48h
   * expiry wedges the queue under `ADVANCE_AUTH=enforce`. Absent for a no-key
   * room (no token to age).
   */
  screenTokenMintedAt?: number;
}) {
  // i18n (TICKET-30): the TV follows the ROOM language, never a per-user
  // cookie — the server page wraps this component in a NextIntlClientProvider
  // scoped to the room locale, so these hooks resolve against it.
  const t = useTranslations("Tv");
  const tCommon = useTranslations("Common");
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [ytReady, setYtReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [joinHost, setJoinHost] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [reorderNotice, setReorderNotice] = useState("");
  const [micCallSecs, setMicCallSecs] = useState<number | null>(null);
  const [skipNotice, setSkipNotice] = useState(false);
  // Bumped by the watchdog's `recreate` rung so the player effect re-runs
  // deterministically and rebuilds the destroyed player (TICKET-41).
  const [playerEpoch, setPlayerEpoch] = useState(0);
  const playerRef = useRef<YTPlayer | null>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevModeRef = useRef<string | null>(null);
  const micCallEntryRef = useRef<string | null>(null);
  // ---- TICKET-41 watchdog refs (hygiene: one timer per concern, all cleared) ----
  const stallStateRef = useRef<StallState>(createStallState(Date.now()));
  const skipNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skippingRef = useRef(false);

  /** Length of the TV "get to the mic" no-show call window (spec §no-shows). */
  const MIC_CALL_SECONDS = 30;

  // Query suffix so every queue call targets this room (absent = default room).
  const roomQuery = roomId ? `?room=${encodeURIComponent(roomId)}` : "";

  // ---- join URL + QR target (client-only to avoid hydration mismatch) ----
  useEffect(() => {
    setJoinHost(window.location.host);
    // The QR (and printed URL) point at THIS room's patron join page.
    const path = roomId ? `/${roomId}` : "/";
    setJoinUrl(`${window.location.origin}${path}`);
  }, [roomId]);

  // Human-facing short URL (host + room path) for the printed line under the QR.
  const joinLabel = joinHost ? `${joinHost}${roomId ? `/${roomId}` : ""}` : "boraoke.com";

  // ---- Load YouTube IFrame API (TICKET-41: retry with backoff, never sit dead) ----
  useEffect(() => {
    if (typeof window === "undefined") return;

    if ((window as unknown as { YT?: { Player?: unknown } }).YT?.Player) {
      setYtReady(true);
      return;
    }

    // Timer hygiene (TICKET-18 patterns): at most ONE outstanding timer per
    // concern (ready-timeout, retry), both cleared on unmount.
    let disposed = false;
    let attempt = 0;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = () => {
      if (disposed || retryTimer) return;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      // Drop the failed script tag so the re-injection actually refetches.
      document
        .querySelectorAll('script[data-boraoke="yt-iframe-api"]')
        .forEach((el) => el.remove());
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        inject();
      }, bootstrapRetryDelayMs(attempt));
    };

    const inject = () => {
      if (disposed) return;
      if ((window as unknown as { YT?: { Player?: unknown } }).YT?.Player) {
        setYtReady(true);
        return;
      }
      window.onYouTubeIframeAPIReady = () => {
        if (disposed) return;
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        setYtReady(true);
      };

      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.boraoke = "yt-iframe-api";
      script.onerror = scheduleRetry; // network refused the script outright
      document.head.appendChild(script);

      // Script may load but the API may never call ready (half-dead wifi):
      // treat silence as failure and retry.
      readyTimer = setTimeout(scheduleRetry, BOOTSTRAP_READY_TIMEOUT_MS);
    };

    inject();

    return () => {
      disposed = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (retryTimer) clearTimeout(retryTimer);
      // Leave any loaded script tag; removing it causes issues if player re-mounts
    };
  }, []);

  // ---- Poll queue ----
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/queue${roomQuery}`);
      if (!res.ok) return;
      const data = await res.json();
      setQueue(data.items ?? []);
      const nextMode: string | null = data.mode ?? null;
      if (nextMode) {
        if (prevModeRef.current && prevModeRef.current !== nextMode) {
          setReorderNotice(t("reorderNotice"));
          window.setTimeout(() => setReorderNotice(""), 5000);
        }
        prevModeRef.current = nextMode;
      }
    } catch {
      // network hiccup — retry on next poll
    }
    // t is stable per locale (locale change re-renders the provider subtree).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomQuery]);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // ---- TICKET-46 Layer 2: reactive self-heal on a 401 from advance ----
  // Under `ADVANCE_AUTH=enforce`, an aged-out screen token makes advance return
  // 401 and the queue wedges silently. As a last-resort backstop, reload the
  // page (re-minting a fresh token via force-dynamic) — but debounced by a
  // sessionStorage one-shot marker so a genuinely bad config (every fresh token
  // still 401s) can never storm the page with reloads; after one attempt inside
  // the window it fails quietly (the pre-existing silent behavior). Dormant in
  // log mode, where advance never 401s.
  const reactiveSelfHeal = useCallback(() => {
    if (typeof window === "undefined") return;
    let lastReloadAt: number | null = null;
    try {
      const raw = window.sessionStorage.getItem(SELF_HEAL_MARKER_KEY);
      lastReloadAt = raw ? Number(raw) : null;
      if (lastReloadAt !== null && Number.isNaN(lastReloadAt)) lastReloadAt = null;
    } catch {
      // sessionStorage unavailable (private mode / disabled) — treat as no prior
      // reload so the one-shot heal can still run once.
      lastReloadAt = null;
    }
    if (!shouldReactivelyReload({ lastReloadAt, now: Date.now() })) return;
    try {
      window.sessionStorage.setItem(SELF_HEAL_MARKER_KEY, String(Date.now()));
    } catch {
      // best-effort marker; a reload still lands on a fresh token
    }
    window.location.reload();
  }, []);

  // ---- Advance queue on the server and tell player to load the next video ----
  // `reason` (TICKET-41): forwarded so the server can emit the existing
  // `song_skipped` event with a reason prop (watchdog skips stay observable).
  const advance = useCallback(async (reason?: "unplayable") => {
    try {
      const reasonQuery = reason
        ? `${roomQuery ? "&" : "?"}reason=${reason}`
        : "";
      // Advance-auth (TICKET-45): attach the room's screen token so the route
      // authorizes the skip. Omitted for a no-key room (server passed null) —
      // enforcement is off there, so no header is the correct signal. This ONE
      // fetch layer is the sole advance path, so the watchdog, ENDED
      // auto-advance, and the manual skip button all carry the credential.
      const headers: HeadersInit = screenToken
        ? { "X-Boraoke-Screen": screenToken }
        : {};
      const advanceRes = await fetch(`/api/queue/advance${roomQuery}${reasonQuery}`, {
        method: "POST",
        headers,
      });
      // TICKET-46 Layer 2: token rejected under enforce → self-heal by reloading
      // (debounced). Only 401 (auth) triggers it — other errors are transient.
      if (advanceRes.status === 401) {
        reactiveSelfHeal();
        return;
      }
      const res = await fetch(`/api/queue${roomQuery}`);
      if (!res.ok) return;
      const data = await res.json();
      const items: QueueEntry[] = data.items ?? [];
      setQueue(items);
      return items[0]?.videoId ?? null;
    } catch {
      return null;
    }
  }, [roomQuery, screenToken, reactiveSelfHeal]);

  // ---- TICKET-41: skip a video that will never play here (onError / ladder top) ----
  const skipUnplayable = useCallback(async () => {
    if (skippingRef.current) return; // one skip in flight, ever
    skippingRef.current = true;
    try {
      setSkipNotice(true);
      if (skipNoticeTimerRef.current) clearTimeout(skipNoticeTimerRef.current);
      skipNoticeTimerRef.current = setTimeout(
        () => setSkipNotice(false),
        SKIP_NOTICE_MS
      );
      const nextVideoId = await advance("unplayable");
      stallStateRef.current = createStallState(Date.now());
      if (nextVideoId && playerRef.current) {
        currentVideoIdRef.current = nextVideoId;
        try {
          playerRef.current.loadVideoById(nextVideoId);
        } catch {
          // player wedged — the stall ladder's recreate rung will handle it
        }
      } else if (!nextVideoId) {
        currentVideoIdRef.current = null;
      }
    } finally {
      skippingRef.current = false;
    }
  }, [advance]);

  // ---- Create/update YT player when ytReady and queue changes ----
  useEffect(() => {
    if (!ytReady || !playerDivRef.current) return;

    const nowVideoId = queue[0]?.videoId ?? null;

    if (!nowVideoId) {
      if (playerRef.current) {
        try {
          playerRef.current.stopVideo();
        } catch {
          // wedged player with an empty queue — nothing to watch
        }
      }
      currentVideoIdRef.current = null;
      return;
    }

    if (playerRef.current) {
      // Player already exists — only load new video if it changed
      if (currentVideoIdRef.current !== nowVideoId) {
        currentVideoIdRef.current = nowVideoId;
        stallStateRef.current = createStallState(Date.now());
        try {
          playerRef.current.loadVideoById(nowVideoId);
        } catch {
          // wedged — stall ladder escalates to recreate
        }
      }
      return;
    }

    // Create player. Handlers are attached ONCE at creation (TICKET-18: no
    // listener accumulation); creation is try/caught so a failed constructor
    // (half-loaded API on venue wifi) retries on the next effect run instead
    // of crashing the TV (TICKET-41c).
    currentVideoIdRef.current = nowVideoId;
    stallStateRef.current = createStallState(Date.now());
    try {
      playerRef.current = new window.YT.Player(playerDivRef.current, {
        videoId: nowVideoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: (e) => {
            (e.target as unknown as { playVideo: () => void }).playVideo?.();
          },
          onStateChange: async (e) => {
            if (e.data === window.YT.PlayerState.ENDED) {
              const nextVideoId = await advance();
              stallStateRef.current = createStallState(Date.now());
              if (nextVideoId && playerRef.current) {
                currentVideoIdRef.current = nextVideoId;
                playerRef.current.loadVideoById(nextVideoId);
              } else {
                currentVideoIdRef.current = null;
              }
            }
          },
          // TICKET-41a: bad/removed video (2/5/100) or embedding disabled
          // (101/150) → pt-BR notice + auto-advance. Non-fatal codes are left
          // to the stall ladder.
          onError: (e) => {
            if (isFatalPlayerError(e.data)) void skipUnplayable();
          },
        },
      });
    } catch {
      playerRef.current = null;
      currentVideoIdRef.current = null; // retry cleanly on the next run
    }
  }, [ytReady, queue, advance, skipUnplayable, playerEpoch]);

  // ---- TICKET-41b: stall watchdog — when a video SHOULD be playing, poll
  // getCurrentTime(); no progress over the window walks the escalation ladder
  // (replay → reload → recreate → advance). One interval, cleared on unmount.
  useEffect(() => {
    if (!ytReady) return;
    const t = setInterval(() => {
      const player = playerRef.current;
      const videoId = currentVideoIdRef.current;
      if (!player || !videoId || skippingRef.current) return;

      // A wedged player (getter throws) reads as null → counts as no-progress.
      let playerState: number | null = null;
      let currentTime: number | null = null;
      try {
        playerState = player.getPlayerState?.() ?? null;
      } catch {}
      try {
        currentTime = player.getCurrentTime?.() ?? null;
      } catch {}

      const { state, action } = stallTick(stallStateRef.current, {
        playerState,
        currentTime,
        now: Date.now(),
        states: window.YT.PlayerState,
      });
      stallStateRef.current = state;

      switch (action) {
        case "replay":
          try {
            player.seekTo?.(currentTime ?? 0, true);
            player.playVideo?.();
          } catch {}
          break;
        case "reload":
          try {
            player.loadVideoById(videoId);
          } catch {}
          break;
        case "recreate":
          try {
            player.destroy();
          } catch {}
          playerRef.current = null;
          currentVideoIdRef.current = null;
          setPlayerEpoch((n) => n + 1); // deterministic rebuild via the player effect
          break;
        case "advance":
          void skipUnplayable();
          break;
        // "none": healthy or still inside the window
      }
    }, WATCHDOG_POLL_MS);
    return () => clearInterval(t);
  }, [ytReady, skipUnplayable]);

  // Skip-notice timer hygiene: cleared on unmount (TICKET-18 pattern).
  useEffect(() => {
    return () => {
      if (skipNoticeTimerRef.current) clearTimeout(skipNoticeTimerRef.current);
    };
  }, []);

  // ---- Fullscreen (AC2): user-gesture affordance + `F` key; Esc exits natively ----
  const requestAppFullscreen = useCallback(() => {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    try {
      if (el.requestFullscreen) {
        void el.requestFullscreen().catch(() => {});
      } else if (el.webkitRequestFullscreen) {
        void el.webkitRequestFullscreen();
      }
    } catch {
      // graceful degradation — fullscreen just doesn't happen
    }
  }, []);

  useEffect(() => {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: unknown;
    };
    setFullscreenSupported(
      Boolean(el.requestFullscreen || el.webkitRequestFullscreen)
    );

    const doc = document as Document & { webkitFullscreenElement?: Element };
    const onChange = () =>
      setIsFullscreen(
        Boolean(document.fullscreenElement || doc.webkitFullscreenElement)
      );
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        if (!document.fullscreenElement) requestAppFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestAppFullscreen]);

  // ---- Screen wake lock (AC6): progressive enhancement, never throws ----
  useEffect(() => {
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;

    const acquire = async () => {
      try {
        const wakeLock = (
          navigator as Navigator & {
            wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
          }
        ).wakeLock;
        if (!wakeLock?.request) return; // unsupported — fine
        const s = await wakeLock.request("screen");
        if (disposed) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
      } catch {
        // denied / low battery / unsupported — never an error on /tv
      }
    };

    void acquire();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, []);

  // ---- Auto-hide chrome + cursor: visible on activity, gone when passive ----
  const pokeChrome = useCallback(() => {
    setChromeVisible(true);
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = setTimeout(
      () => setChromeVisible(false),
      CHROME_HIDE_MS
    );
  }, []);

  useEffect(() => {
    pokeChrome(); // discoverable on load / reload (ticket: re-show after reload)
    window.addEventListener("mousemove", pokeChrome);
    window.addEventListener("pointerdown", pokeChrome);
    return () => {
      window.removeEventListener("mousemove", pokeChrome);
      window.removeEventListener("pointerdown", pokeChrome);
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
    };
  }, [pokeChrome]);

  const nowPlaying = queue[0] ?? null;
  const upcoming = queue.slice(1, 4); // design: max 3 on the rail

  // ---- TICKET-46 Layer 1: proactive reload when the token is OLD *and* idle ----
  // The screen token is valid only for its 24h bucket + the previous one (≤48h).
  // A kiosk that runs for days without a reload outlives its token and — under
  // `ADVANCE_AUTH=enforce` — wedges silently. So when the token crosses a safe
  // threshold (~20h, comfortably inside the first bucket) AND no song is playing
  // (queue empty → idle), reload: force-dynamic re-mints a fresh token with no
  // singer interrupted. We NEVER reload mid-song (that would cut off the current
  // singer); an old-but-playing page waits for the next idle window — a busy
  // venue reaches idle between songs long before 48h. Dormant when the room has
  // no token (screenTokenMintedAt absent) and behavior-neutral in log mode (the
  // reload just re-mints; nothing else changes). Checked on an interval so a
  // page that is idle when the threshold is crossed heals without waiting for a
  // queue change to re-render.
  const isPlaying = nowPlaying !== null;
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (screenTokenMintedAt === undefined) return; // no-key room — nothing to heal
    const check = () => {
      const tokenAgeMs = Date.now() - screenTokenMintedAt;
      if (shouldProactivelyReload({ tokenAgeMs, isPlaying })) {
        window.location.reload();
      }
    };
    check(); // evaluate immediately on idle/playing transitions
    // Re-check periodically so an idle page still heals if it crossed the
    // threshold while sitting idle (no queue change to re-fire the effect).
    const interval = setInterval(check, 60_000);
    return () => clearInterval(interval);
  }, [screenTokenMintedAt, isPlaying]);

  const singerLine = (entry: QueueEntry) =>
    entry.mode === "listen-dance" ? `${entry.nickname} 🎶` : entry.nickname;

  // TICKET-10: 30s "get to the mic" call whenever a NEW sing entry reaches the
  // stage (spec §no-shows). Counts down once per entry; the host's "🙅 Não veio"
  // control grants the grace re-queue during this window.
  const nowPlayingId = nowPlaying?.id ?? null;
  const nowPlayingIsSing = nowPlaying?.mode === "sing";
  useEffect(() => {
    if (!nowPlayingId || !nowPlayingIsSing) {
      setMicCallSecs(null);
      micCallEntryRef.current = null;
      return;
    }
    if (micCallEntryRef.current === nowPlayingId) return; // already announced
    micCallEntryRef.current = nowPlayingId;
    setMicCallSecs(MIC_CALL_SECONDS);
    const t = setInterval(() => {
      setMicCallSecs((s) => {
        if (s === null) return null;
        if (s <= 1) {
          clearInterval(t);
          return null;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [nowPlayingId, nowPlayingIsSing]);

  return (
    <div
      className={`${styles.tv} ${!chromeVisible ? styles.cursorHidden : ""}`}
      data-testid="tv-root"
    >
      {/* top bar */}
      <div className={styles.topBar}>
        <span className={styles.wordmark}>Boraoke</span>
        <span className={styles.venue}>{venueName || t("venueFallback")}</span>
      </div>

      {nowPlaying ? (
        <>
          {/* main row: video + meta */}
          <div className={styles.main}>
            <div className={styles.video}>
              <div ref={playerDivRef} id="yt-player" className={styles.playerHost} />
            </div>
            <div className={styles.meta}>
              <span className={styles.label}>{t("nowPlaying")}</span>
              <h1 className={styles.hero} data-testid="tv-hero">
                {nowPlaying.title ?? `youtu.be/${nowPlaying.videoId}`}
              </h1>
              <div className={styles.singer} data-testid="tv-singer">
                🎤 {singerLine(nowPlaying)}
                {nowPlaying.table ? (
                  <span className={styles.mesa}> · {t("table", { table: nowPlaying.table })}</span>
                ) : null}
              </div>
              {micCallSecs !== null && (
                <div className={styles.micCall} data-testid="tv-mic-call" role="status">
                  {t.rich("micCall", {
                    nickname: nowPlaying.nickname,
                    table: nowPlaying.table ?? "none",
                    seconds: micCallSecs,
                    s: (chunks) => <strong>{chunks}</strong>,
                  })}
                </div>
              )}
            </div>
          </div>
          {reorderNotice && (
            <div className={styles.reorderNotice} data-testid="tv-reorder-toast" role="status">
              {reorderNotice}
            </div>
          )}
          {skipNotice && (
            <div className={styles.skipNotice} data-testid="tv-skip-notice" role="status">
              {t("skipNotice")}
            </div>
          )}

          {/* bottom rail */}
          <div className={styles.rail}>
            {upcoming.length > 0 && (
              <>
                <span className={styles.railLabel}>{t("upNext")}</span>
                {upcoming.map((entry, idx) => (
                  <div className={styles.nextCard} key={entry.id}>
                    <span className={styles.n}>{idx + 2}</span>
                    <div className={styles.info}>
                      <div className={styles.who}>{singerLine(entry)}</div>
                      <div className={styles.what}>
                        {entry.title ?? `youtu.be/${entry.videoId}`}
                      </div>
                    </div>
                    {entry.table ? (
                      <span className={styles.mesa}>{t("table", { table: entry.table })}</span>
                    ) : null}
                  </div>
                ))}
              </>
            )}
            {poweredByFooter && (
              <div className={styles.join} data-testid="tv-powered-by">
                <QrCode
                  className={styles.qr}
                  value={joinUrl}
                  size={120}
                  title={t("qrTitle")}
                />
                <div>
                  <div className={styles.cta}>{t("scanAndSing")}</div>
                  <div className={styles.url}>{joinLabel}</div>
                  <div className={styles.poweredBy}>
                    {t("poweredBy")} <span className={styles.pbMark}>{tCommon("brand")}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* idle state — the recruitment poster */
        <div className={styles.idle} data-testid="tv-idle">
          <span className={styles.wordmark}>{tCommon("brand")}</span>
          <div className={styles.idleCta}>{t("scanAndSingIdle")}</div>
          <QrCode
            className={styles.idleQr}
            value={joinUrl}
            size={280}
            title={t("qrTitle")}
          />
          <div className={styles.idleUrl}>{joinLabel}</div>
          {poweredByFooter && (
            <div className={styles.poweredBy} data-testid="tv-powered-by">
              {t("poweredBy")} <span className={styles.pbMark}>{tCommon("brand")}</span>
            </div>
          )}
        </div>
      )}

      {/* auto-hiding chrome: fullscreen affordance + host skip */}
      <div
        className={`${styles.chrome} ${!chromeVisible ? styles.chromeHidden : ""}`}
        data-testid="tv-chrome"
      >
        {nowPlaying && (
          <button
            type="button"
            className={styles.chromeBtn}
            data-testid="tv-skip"
            onClick={() => void advance()}
          >
            {t("skip")}
          </button>
        )}
        {fullscreenSupported && !isFullscreen ? (
          <button
            type="button"
            className={styles.chromeBtn}
            data-testid="tv-fullscreen"
            onClick={requestAppFullscreen}
          >
            {t("fullscreen")}
          </button>
        ) : null}
        {isFullscreen ? (
          <span className={styles.chromeHint}>{t("exitFullscreen")}</span>
        ) : null}
      </div>
    </div>
  );
}
