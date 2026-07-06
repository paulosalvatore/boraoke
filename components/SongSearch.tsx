"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseYouTubeVideoId } from "@/lib/youtube";
import type { SearchResult } from "@/lib/youtube-search";

const DEBOUNCE_MS = 400;
const MIN_CHARS = 3;

export interface SongSelection {
  videoId: string;
  title?: string;
}

interface SongSearchProps {
  patronUuid: string;
  /** Called with the current selection, or null when the selection is cleared. */
  onSelect: (selection: SongSelection | null) => void;
}

const FALLBACK_COPY = "Busca indisponível — cola o link do YouTube";

/**
 * Dual-behavior song picker (TICKET-8 / design §2 patron-02-pick-song):
 *   - Free text (≥3 chars) → debounced call to /api/search → tappable result rows.
 *   - A pasted YouTube URL/ID → resolved locally via parseYouTubeVideoId, NO API call.
 * Degraded (no key / quota / error) shows the fallback copy; paste-link still works.
 */
export default function SongSearch({ patronUuid, onSelect }: SongSearchProps) {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [rateLimitMsg, setRateLimitMsg] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0); // guards against out-of-order responses

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    onSelect(null);
  }, [onSelect]);

  const runSearch = useCallback(
    async (q: string) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setDegraded(false);
      setRateLimitMsg("");
      try {
        const params = new URLSearchParams({ q, uuid: patronUuid || "anon" });
        const res = await fetch(`/api/search?${params.toString()}`);
        if (seq !== seqRef.current) return; // a newer query superseded this one

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          setResults([]);
          setRateLimitMsg(data.error ?? "Muitas buscas — aguarde um instante.");
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data.degraded) {
          setResults([]);
          setDegraded(true);
          return;
        }
        setResults(Array.isArray(data.results) ? data.results : []);
      } catch {
        if (seq !== seqRef.current) return;
        // Network error → fail soft to the paste-link fallback.
        setResults([]);
        setDegraded(true);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [patronUuid],
  );

  // React to input changes: resolve pasted links locally, else debounce a search.
  useEffect(() => {
    const trimmed = input.trim();

    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Empty → reset everything.
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setDegraded(false);
      setRateLimitMsg("");
      clearSelection();
      return;
    }

    // Pasted URL / raw ID → resolve directly, no API call (AC2).
    const pastedId = parseYouTubeVideoId(trimmed);
    if (pastedId) {
      seqRef.current++; // cancel any in-flight search
      setLoading(false);
      setDegraded(false);
      setRateLimitMsg("");
      setResults([
        {
          videoId: pastedId,
          title: "Link do YouTube",
          channelTitle: "Link colado",
          duration: "",
          thumbnailUrl: `https://i.ytimg.com/vi/${pastedId}/mqdefault.jpg`,
        },
      ]);
      // Auto-select the resolved link.
      setSelectedId(pastedId);
      onSelect({ videoId: pastedId });
      return;
    }

    // Too short to search — keep paste-link possible but no results yet.
    if (trimmed.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      setDegraded(false);
      clearSelection();
      return;
    }

    // Free-text search (debounced).
    clearSelection();
    debounceRef.current = setTimeout(() => runSearch(trimmed), DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // onSelect/clearSelection are stable via useCallback in the parent contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, runSearch]);

  function handlePick(r: SearchResult) {
    setSelectedId(r.videoId);
    onSelect({
      videoId: r.videoId,
      title: r.title && r.title !== "Link do YouTube" ? r.title : undefined,
    });
  }

  return (
    <div>
      <label
        htmlFor="song-search-input"
        style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}
      >
        Buscar música ou colar link do YouTube *
      </label>
      <input
        id="song-search-input"
        aria-label="Buscar música ou colar link do YouTube"
        placeholder="Ex.: evidências — ou cole um link do YouTube"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        autoComplete="off"
      />

      {/* Loading skeleton rows */}
      {loading && (
        <div data-testid="search-skeleton" style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "0.5rem",
              }}
            >
              <div style={{ width: 64, height: 48, borderRadius: 4, background: "#2e2e2e" }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 12, width: "70%", background: "#2e2e2e", borderRadius: 3, marginBottom: 8 }} />
                <div style={{ height: 10, width: "45%", background: "#242424", borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Degraded / quota state — paste-link still works via the input above */}
      {degraded && !loading && (
        <p
          data-testid="search-degraded"
          role="status"
          style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "var(--text-muted)" }}
        >
          {FALLBACK_COPY}
        </p>
      )}

      {/* Rate-limit notice */}
      {rateLimitMsg && !loading && (
        <p role="status" style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "var(--accent)" }}>
          {rateLimitMsg}
        </p>
      )}

      {/* Results */}
      {!loading && results.length > 0 && (
        <ul
          style={{ listStyle: "none", marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          {results.map((r) => {
            const selected = selectedId === r.videoId;
            return (
              <li key={r.videoId}>
                <button
                  type="button"
                  className="song-row"
                  aria-pressed={selected}
                  onClick={() => handlePick(r)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    textAlign: "left",
                    background: selected ? "rgba(230,57,70,0.10)" : "var(--surface)",
                    border: `${selected ? 2 : 1}px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: "var(--radius)",
                    padding: selected ? "calc(0.5rem - 1px)" : "0.5rem",
                    color: "var(--text)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={r.thumbnailUrl}
                    alt=""
                    width={64}
                    height={48}
                    style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 4, flexShrink: 0, background: "#000" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: "15px",
                        fontWeight: 700,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.title}
                    </span>
                    <span style={{ display: "block", fontSize: "13px", color: "var(--text-muted)", marginTop: 2 }}>
                      {r.channelTitle}
                      {r.duration ? ` · ${r.duration}` : ""}
                    </span>
                  </span>
                  {selected && (
                    <span aria-hidden style={{ color: "var(--accent)", fontWeight: 700, fontSize: "1.1rem" }}>
                      ✓
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
