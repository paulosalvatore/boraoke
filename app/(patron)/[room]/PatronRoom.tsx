"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import type { QueueEntry, Mode } from "@/lib/store";
import { modeLabel, type RoomMode } from "@/lib/rotation-modes";
import SongSearch, { type SongSelection } from "@/components/SongSearch";

const POLL_INTERVAL = 3000;

/**
 * Patron flow for a specific room (TICKET-9). Moved from the old global
 * `app/page.tsx` and made room-scoped: every queue call carries `?room=`/`room`,
 * and nickname + table persist PER ROOM in localStorage (`cantai:<room>:*`),
 * with the global `cantai_nickname` as a first-visit prefill. The venue name is
 * shown as a chip in the top bar.
 */
export default function PatronRoom({
  roomId,
  venueName,
}: {
  roomId: string;
  venueName: string;
}) {
  // Identity — persisted in localStorage
  const [patronUuid, setPatronUuid] = useState<string>("");
  const [nickname, setNickname] = useState<string>("");
  const [nicknameSet, setNicknameSet] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [table, setTable] = useState("");
  const [mode, setMode] = useState<Mode>("sing");

  // UI state — parsedVideoId is driven by the SongSearch selection.
  const [parsedVideoId, setParsedVideoId] = useState<string | null>(null);
  const [searchKey, setSearchKey] = useState(0);
  const [submitError, setSubmitError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Queue state
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [roomMode, setRoomMode] = useState<RoomMode | null>(null);
  const [reorderNotice, setReorderNotice] = useState("");
  const prevModeRef = useRef<RoomMode | null>(null);

  const nickKey = `cantai:${roomId}:nick`;
  const tableKey = `cantai:${roomId}:table`;

  // Boot — load or generate uuid + per-room nickname/table
  useEffect(() => {
    const ls = (() => {
      try {
        return typeof window !== "undefined" ? window.localStorage : null;
      } catch {
        return null;
      }
    })();
    if (!ls) return;

    let id = ls.getItem("cantai_patron_uuid");
    if (!id) {
      id = uuidv4();
      ls.setItem("cantai_patron_uuid", id);
    }
    setPatronUuid(id);

    // Remember this as the last room joined (landing prefill).
    try { ls.setItem("cantai_last_room", roomId); } catch { /* sandboxed */ }

    // Per-room nickname, falling back to the global prefill.
    const savedNick = ls.getItem(nickKey) ?? ls.getItem("cantai_nickname");
    if (savedNick) {
      setNickname(savedNick);
      setNicknameSet(true);
    }
    const savedTable = ls.getItem(tableKey);
    if (savedTable) setTable(savedTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Poll this room's queue
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/queue?room=${encodeURIComponent(roomId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setQueue(data.items ?? []);
      const nextMode = (data.mode ?? null) as RoomMode | null;
      if (nextMode) {
        setRoomMode(nextMode);
        // Toast on a live mode change (skip the very first load).
        if (prevModeRef.current && prevModeRef.current !== nextMode) {
          setReorderNotice(`Fila reordenada — modo mudou para ${modeLabel(nextMode)}.`);
          window.setTimeout(() => setReorderNotice(""), 5000);
        }
        prevModeRef.current = nextMode;
      }
    } catch {
      // network hiccup — next poll retries
    }
  }, [roomId]);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const handleSelect = useCallback((sel: SongSelection | null) => {
    setParsedVideoId(sel?.videoId ?? null);
    if (sel?.title) {
      setTitle((prev) => (prev.trim() ? prev : sel.title!));
    }
  }, []);

  function saveNickname() {
    const trimmed = nickname.trim();
    if (!trimmed) return;
    try {
      window.localStorage.setItem(nickKey, trimmed);
      window.localStorage.setItem("cantai_nickname", trimmed); // global prefill
    } catch { /* sandboxed */ }
    setNicknameSet(true);
  }

  // Persist table per-room as it changes.
  function updateTable(value: string) {
    setTable(value);
    try {
      if (value.trim()) window.localStorage.setItem(tableKey, value.trim());
      else window.localStorage.removeItem(tableKey);
    } catch { /* sandboxed */ }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setSubmitSuccess(false);

    if (!parsedVideoId) {
      setSubmitError("Paste a valid YouTube URL first.");
      return;
    }
    if (!nickname.trim()) {
      setSubmitError("Enter a nickname first.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: roomId,
          videoId: parsedVideoId,
          title: title.trim() || undefined,
          nickname: nickname.trim(),
          patronUuid,
          table: table.trim() || undefined,
          mode,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSubmitError(err.error ?? "Failed to add song.");
        return;
      }
      setSubmitSuccess(true);
      setTitle("");
      setParsedVideoId(null);
      setSearchKey((k) => k + 1);
      fetchQueue();
    } catch {
      setSubmitError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Nickname gate
  if (!nicknameSet) {
    return (
      <main style={{ maxWidth: 480, margin: "0 auto", padding: "2rem 1rem" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.25rem" }}>🎤 Cantai</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: "0.5rem" }}>
          Karaoke queue for{" "}
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>{venueName}</span>
        </p>
        <p style={{ color: "var(--text-muted)", marginBottom: "2rem", fontSize: "0.85rem" }}>
          Sala: {roomId}
        </p>
        <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: 600 }}>
          Your nickname
        </label>
        <input
          id="nickname-input"
          aria-label="Your nickname"
          autoFocus
          placeholder="e.g. Maria, Table 4 Guy…"
          maxLength={30}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveNickname()}
          style={{ marginBottom: "1rem" }}
        />
        <button className="btn-primary" onClick={saveNickname} disabled={!nickname.trim()}>
          Join queue
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 540, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "1.75rem" }}>🎤 Cantai</h1>
        <span style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
          Hi,{" "}
          <button
            onClick={() => setNicknameSet(false)}
            style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.875rem", padding: 0 }}
          >
            {nickname}
          </button>
        </span>
      </header>

      {/* Venue chip */}
      <div style={{ marginBottom: "1.5rem" }}>
        <span
          data-testid="venue-chip"
          style={{
            display: "inline-block",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "999px",
            padding: "0.25rem 0.75rem",
            fontSize: "0.8rem",
            color: "var(--text-muted)",
          }}
        >
          📍 {venueName}
          {table.trim() ? ` · Mesa ${table.trim()}` : ""}
        </span>
      </div>

      {/* Submit form */}
      <section style={{ background: "var(--surface)", borderRadius: "var(--radius)", padding: "1.25rem", marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Add a song</h2>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <SongSearch key={searchKey} patronUuid={patronUuid} onSelect={handleSelect} />
          {parsedVideoId && (
            <p style={{ fontSize: "0.8rem", color: "#4ade80" }}>✓ Selected: {parsedVideoId}</p>
          )}

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
              Song title (optional)
            </label>
            <input
              placeholder="e.g. Bohemian Rhapsody"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
                Table # (optional)
              </label>
              <input
                placeholder="e.g. 7"
                aria-label="Table number"
                maxLength={10}
                value={table}
                onChange={(e) => updateTable(e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
                Mode
              </label>
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="Mode">
                <option value="sing">🎤 Sing</option>
                <option value="listen-dance">💃 Listen / Dance</option>
              </select>
            </div>
          </div>

          {submitError && <p style={{ color: "var(--accent)", fontSize: "0.875rem" }}>{submitError}</p>}
          {submitSuccess && <p style={{ color: "#4ade80", fontSize: "0.875rem" }}>✓ Song added to the queue!</p>}

          <button className="btn-primary" type="submit" disabled={submitting || !parsedVideoId}>
            {submitting ? "Adding…" : "Add to queue"}
          </button>
        </form>
      </section>

      {/* Player hint (TICKET-20). DESIGN DECISION: the patron page has NO video
          player by design — the karaoke video plays on the venue's shared TV
          screen (/[room]/tv), not on every customer's phone (that would mean N
          overlapping audio streams). The TL's "the yt screen isn't showing on
          the customer page" is answered here: it is intentional, and this hint
          points patrons at the TV view. */}
      <a
        href={`/${roomId}/tv`}
        target="_blank"
        rel="noreferrer"
        data-testid="patron-player-hint"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "0.75rem 1rem",
          marginBottom: "1.5rem",
          color: "var(--text)",
          textDecoration: "none",
        }}
      >
        <span style={{ fontSize: "1.4rem" }}>🖥️</span>
        <span style={{ fontSize: "0.9rem", lineHeight: 1.4 }}>
          O vídeo toca na <strong>tela do bar</strong>.{" "}
          <span style={{ color: "var(--accent)" }}>Assistir na TV ↗</span>
        </span>
      </a>

      {/* Live queue */}
      <section>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
          Live queue{" "}
          <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: "0.875rem" }}>
            ({queue.length} {queue.length === 1 ? "song" : "songs"})
          </span>
        </h2>
        {roomMode && (
          <p
            data-testid="patron-mode-hint"
            style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginBottom: "0.5rem" }}
          >
            Modo: {modeLabel(roomMode)}
          </p>
        )}
        {reorderNotice && (
          <p
            role="status"
            data-testid="reorder-toast"
            style={{
              background: "rgba(230, 57, 70, 0.12)",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius)",
              padding: "0.5rem 0.75rem",
              fontSize: "0.85rem",
              marginBottom: "0.75rem",
            }}
          >
            {reorderNotice}
          </p>
        )}

        {queue.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>No songs yet — be the first!</p>
        ) : (
          <ol style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {queue.map((entry, idx) => (
              <li
                key={entry.id}
                style={{
                  background: idx === 0 ? "#1e1e2e" : "var(--surface)",
                  border: `1px solid ${idx === 0 ? "#4f46e5" : "var(--border)"}`,
                  borderRadius: "var(--radius)",
                  padding: "0.75rem 1rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                <span style={{
                  fontWeight: 700,
                  fontSize: "1.25rem",
                  color: idx === 0 ? "#818cf8" : "var(--text-muted)",
                  minWidth: "2rem",
                  textAlign: "center",
                }}>
                  {idx === 0 ? "▶" : idx + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.title ?? `youtu.be/${entry.videoId}`}
                  </p>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px" }}>
                    {entry.nickname}
                    {entry.table ? ` · Table ${entry.table}` : ""}
                  </p>
                </div>
                <span className={`badge ${entry.mode === "sing" ? "badge-sing" : "badge-listen"}`}>
                  {entry.mode === "sing" ? "Sing" : "Dance"}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer style={{ marginTop: "3rem", color: "var(--text-muted)", fontSize: "0.75rem", textAlign: "center" }}>
        <a href={`/${roomId}/tv`} target="_blank" rel="noreferrer">Venue screen ↗</a>
        {" · "}
        <span>Early-access prototype — queues are per-room</span>
      </footer>
    </main>
  );
}
