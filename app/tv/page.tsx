"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { QueueEntry } from "@/lib/store";

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

const POLL_INTERVAL = 3000;

export default function TvPage() {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [ytReady, setYtReady] = useState(false);
  const playerRef = useRef<YTPlayer | null>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);
  const currentVideoIdRef = useRef<string | null>(null);

  // Load YouTube IFrame API
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

  // Poll queue
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

  // Advance queue on the server and tell player to load the next video
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

  // Create/update YT player when ytReady and queue changes
  useEffect(() => {
    if (!ytReady || !playerDivRef.current) return;

    const nowVideoId = queue[0]?.videoId ?? null;

    if (!nowVideoId) {
      // Nothing to play
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
          // Auto-play on ready
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

  const nowPlaying = queue[0] ?? null;
  const upcoming = queue.slice(1, 6); // show next 5

  return (
    <div
      style={{
        background: "#000",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        color: "#fff",
      }}
    >
      {/* Player */}
      <div
        style={{
          position: "relative",
          width: "100%",
          paddingTop: "56.25%", // 16:9
          background: "#111",
          flex: "none",
        }}
      >
        {nowPlaying ? (
          <div
            ref={playerDivRef}
            id="yt-player"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            <span style={{ fontSize: "4rem" }}>🎤</span>
            <p style={{ fontSize: "1.5rem", color: "#888" }}>
              Queue is empty — add a song!
            </p>
            <p style={{ fontSize: "1rem", color: "#555" }}>
              Visit this venue&apos;s karaoke page on your phone
            </p>
          </div>
        )}
      </div>

      {/* Now playing bar */}
      {nowPlaying && (
        <div
          style={{
            background: "#1a1a2e",
            borderTop: "2px solid #4f46e5",
            padding: "1rem 2rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <div>
            <p style={{ fontSize: "0.75rem", color: "#818cf8", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.25rem" }}>
              Now playing
            </p>
            <p style={{ fontSize: "1.5rem", fontWeight: 700, lineHeight: 1.2 }}>
              {nowPlaying.title ?? `youtu.be/${nowPlaying.videoId}`}
            </p>
            <p style={{ color: "#aaa", marginTop: "0.25rem" }}>
              {nowPlaying.nickname}
              {nowPlaying.table ? ` · Table ${nowPlaying.table}` : ""}
              {" · "}
              <span style={{
                background: nowPlaying.mode === "sing" ? "#2563eb33" : "#16a34a33",
                color: nowPlaying.mode === "sing" ? "#93c5fd" : "#86efac",
                borderRadius: 4,
                padding: "1px 6px",
                fontSize: "0.85rem",
              }}>
                {nowPlaying.mode === "sing" ? "🎤 Singing" : "💃 Listen / Dance"}
              </span>
            </p>
          </div>
          <button
            onClick={async () => {
              await advance();
            }}
            style={{
              background: "#e6394622",
              border: "1px solid #e6394655",
              borderRadius: 8,
              color: "#f87171",
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: 600,
              padding: "0.5rem 1.25rem",
              whiteSpace: "nowrap",
            }}
          >
            Skip ⏭
          </button>
        </div>
      )}

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <div style={{ padding: "1.25rem 2rem", flex: 1 }}>
          <p style={{ fontSize: "0.75rem", color: "#555", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.75rem" }}>
            Up next
          </p>
          <ol style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {upcoming.map((entry, idx) => (
              <li
                key={entry.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  background: "#111",
                  borderRadius: 8,
                  padding: "0.65rem 1rem",
                }}
              >
                <span style={{ color: "#555", fontWeight: 700, fontSize: "1.1rem", minWidth: "1.5rem" }}>
                  {idx + 2}
                </span>
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: 600, fontSize: "1.1rem" }}>
                    {entry.title ?? `youtu.be/${entry.videoId}`}
                  </p>
                  <p style={{ color: "#666", fontSize: "0.875rem" }}>
                    {entry.nickname}
                    {entry.table ? ` · Table ${entry.table}` : ""}
                  </p>
                </div>
                <span style={{
                  borderRadius: 4,
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  padding: "2px 8px",
                  background: entry.mode === "sing" ? "#2563eb22" : "#16a34a22",
                  color: entry.mode === "sing" ? "#60a5fa" : "#4ade80",
                }}>
                  {entry.mode === "sing" ? "Sing" : "Dance"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
