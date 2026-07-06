"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { QueueEntry } from "@/lib/store";
import styles from "./tv.module.css";

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
}

/** Minimal WakeLock typings — the lib.dom versions are still flaky across TS targets. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

const POLL_INTERVAL = 3000;
const CHROME_HIDE_MS = 4000;

export default function TvScreen({
  poweredByFooter,
}: {
  poweredByFooter: boolean;
}) {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [ytReady, setYtReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [joinHost, setJoinHost] = useState("");
  const playerRef = useRef<YTPlayer | null>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- join URL (client-only to avoid hydration mismatch) ----
  useEffect(() => {
    setJoinHost(window.location.host);
  }, []);

  // ---- Load YouTube IFrame API ----
  useEffect(() => {
    if (typeof window === "undefined") return;

    if ((window as unknown as { YT?: unknown }).YT) {
      setYtReady(true);
      return;
    }

    window.onYouTubeIframeAPIReady = () => setYtReady(true);

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);

    return () => {
      // Leave the script tag; removing it causes issues if player re-mounts
    };
  }, []);

  // ---- Poll queue ----
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      if (!res.ok) return;
      const data = await res.json();
      setQueue(data.items ?? []);
    } catch {
      // network hiccup — retry on next poll
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // ---- Advance queue on the server and tell player to load the next video ----
  const advance = useCallback(async () => {
    try {
      await fetch("/api/queue/advance", { method: "POST" });
      const res = await fetch("/api/queue");
      if (!res.ok) return;
      const data = await res.json();
      const items: QueueEntry[] = data.items ?? [];
      setQueue(items);
      return items[0]?.videoId ?? null;
    } catch {
      return null;
    }
  }, []);

  // ---- Create/update YT player when ytReady and queue changes ----
  useEffect(() => {
    if (!ytReady || !playerDivRef.current) return;

    const nowVideoId = queue[0]?.videoId ?? null;

    if (!nowVideoId) {
      if (playerRef.current) {
        playerRef.current.stopVideo();
      }
      currentVideoIdRef.current = null;
      return;
    }

    if (playerRef.current) {
      // Player already exists — only load new video if it changed
      if (currentVideoIdRef.current !== nowVideoId) {
        currentVideoIdRef.current = nowVideoId;
        playerRef.current.loadVideoById(nowVideoId);
      }
      return;
    }

    // Create player
    currentVideoIdRef.current = nowVideoId;
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
            if (nextVideoId && playerRef.current) {
              currentVideoIdRef.current = nextVideoId;
              playerRef.current.loadVideoById(nextVideoId);
            } else {
              currentVideoIdRef.current = null;
            }
          }
        },
      },
    });
  }, [ytReady, queue, advance]);

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

  const singerLine = (entry: QueueEntry) =>
    entry.mode === "listen-dance" ? `${entry.nickname} 🎶` : entry.nickname;

  return (
    <div
      className={`${styles.tv} ${!chromeVisible ? styles.cursorHidden : ""}`}
      data-testid="tv-root"
    >
      {/* top bar */}
      <div className={styles.topBar}>
        <span className={styles.wordmark}>cantai</span>
        <span className={styles.venue}>noite de karaokê</span>
      </div>

      {nowPlaying ? (
        <>
          {/* main row: video + meta */}
          <div className={styles.main}>
            <div className={styles.video}>
              <div ref={playerDivRef} id="yt-player" className={styles.playerHost} />
            </div>
            <div className={styles.meta}>
              <span className={styles.label}>Tocando agora</span>
              <h1 className={styles.hero} data-testid="tv-hero">
                {nowPlaying.title ?? `youtu.be/${nowPlaying.videoId}`}
              </h1>
              <div className={styles.singer}>
                🎤 {singerLine(nowPlaying)}
                {nowPlaying.table ? (
                  <span className={styles.mesa}> · Mesa {nowPlaying.table}</span>
                ) : null}
              </div>
            </div>
          </div>

          {/* bottom rail */}
          <div className={styles.rail}>
            {upcoming.length > 0 && (
              <>
                <span className={styles.railLabel}>A SEGUIR</span>
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
                      <span className={styles.mesa}>Mesa {entry.table}</span>
                    ) : null}
                  </div>
                ))}
              </>
            )}
            {poweredByFooter && (
              <div className={styles.join} data-testid="tv-powered-by">
                <div className={styles.qr} aria-label="QR code (placeholder)" />
                <div>
                  <div className={styles.cta}>Escaneia e canta!</div>
                  <div className={styles.url}>{joinHost || "cantai"}</div>
                  <div className={styles.poweredBy}>
                    powered by <span className={styles.pbMark}>cantai</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* idle state — the recruitment poster */
        <div className={styles.idle} data-testid="tv-idle">
          <span className={styles.wordmark}>cantai</span>
          <div className={styles.idleCta}>Escaneia e canta! 🎤</div>
          <div className={styles.idleQr} aria-label="QR code (placeholder)" />
          <div className={styles.idleUrl}>{joinHost || "cantai"}</div>
          {poweredByFooter && (
            <div className={styles.poweredBy} data-testid="tv-powered-by">
              powered by <span className={styles.pbMark}>cantai</span>
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
            Pular ⏭
          </button>
        )}
        {fullscreenSupported && !isFullscreen ? (
          <button
            type="button"
            className={styles.chromeBtn}
            data-testid="tv-fullscreen"
            onClick={requestAppFullscreen}
          >
            Tela cheia (F)
          </button>
        ) : null}
        {isFullscreen ? (
          <span className={styles.chromeHint}>Esc para sair</span>
        ) : null}
      </div>
    </div>
  );
}
