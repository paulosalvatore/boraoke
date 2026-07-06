"use client";

import { useState, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { QueueEntry, Mode } from "@/lib/store";
import SongSearch, { type SongSelection } from "@/components/SongSearch";

const POLL_INTERVAL = 3000;

export default function PatronPage() {
  // Identity — persisted in localStorage
  const [patronUuid, setPatronUuid] = useState<string>("");
  const [nickname, setNickname] = useState<string>("");
  const [nicknameSet, setNicknameSet] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [table, setTable] = useState("");
  const [mode, setMode] = useState<Mode>("sing");

  // UI state — parsedVideoId is now driven by the SongSearch selection.
  const [parsedVideoId, setParsedVideoId] = useState<string | null>(null);
  // Bumped after a successful submit to remount SongSearch and clear its input.
  const [searchKey, setSearchKey] = useState(0);
  const [submitError, setSubmitError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Queue state
  const [queue, setQueue] = useState<QueueEntry[]>([]);

  // Boot — load or generate uuid + nickname
  useEffect(() => {
    // Guard: localStorage may not be available in SSR or sandboxed envs
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

    const savedNick = ls.getItem("cantai_nickname");
    if (savedNick) {
      setNickname(savedNick);
      setNicknameSet(true);
    }
  }, []);

  // Poll queue
  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      if (!res.ok) return;
      const data = await res.json();
      setQueue(data.items ?? []);
    } catch {
      // network hiccup — ignore, next poll will retry
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // Selection from the search/paste-link picker.
  const handleSelect = useCallback((sel: SongSelection | null) => {
    setParsedVideoId(sel?.videoId ?? null);
    // Prefill the (optional) title from a picked search result when empty.
    if (sel?.title) {
      setTitle((prev) => (prev.trim() ? prev : sel.title!));
    }
  }, []);

  function saveNickname() {
    const trimmed = nickname.trim();
    if (!trimmed) return;
    try { window.localStorage.setItem("cantai_nickname", trimmed); } catch { /* sandboxed */ }
    setNicknameSet(true);
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
      setSearchKey((k) => k + 1); // remount SongSearch → clear its input/results
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
        <p style={{ color: "var(--text-muted)", marginBottom: "2rem" }}>
          Karaoke queue for this venue
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
        <button
          className="btn-primary"
          onClick={saveNickname}
          disabled={!nickname.trim()}
        >
          Join queue
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 540, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "1.5rem" }}>
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

      {/* Submit form */}
      <section style={{ background: "var(--surface)", borderRadius: "var(--radius)", padding: "1.25rem", marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Add a song</h2>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <SongSearch key={searchKey} patronUuid={patronUuid} onSelect={handleSelect} />
          {parsedVideoId && (
            <p style={{ fontSize: "0.8rem", color: "#4ade80" }}>
              ✓ Selected: {parsedVideoId}
            </p>
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
                maxLength={10}
                value={table}
                onChange={(e) => setTable(e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
                Mode
              </label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
                aria-label="Mode"
              >
                <option value="sing">🎤 Sing</option>
                <option value="listen-dance">💃 Listen / Dance</option>
              </select>
            </div>
          </div>

          {submitError && (
            <p style={{ color: "var(--accent)", fontSize: "0.875rem" }}>{submitError}</p>
          )}
          {submitSuccess && (
            <p style={{ color: "#4ade80", fontSize: "0.875rem" }}>✓ Song added to the queue!</p>
          )}

          <button className="btn-primary" type="submit" disabled={submitting || !parsedVideoId}>
            {submitting ? "Adding…" : "Add to queue"}
          </button>
        </form>
      </section>

      {/* Live queue */}
      <section>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>
          Live queue{" "}
          <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: "0.875rem" }}>
            ({queue.length} {queue.length === 1 ? "song" : "songs"})
          </span>
        </h2>

        {queue.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>
            No songs yet — be the first!
          </p>
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
        <a href="/tv" target="_blank">Venue screen ↗</a>
        {" · "}
        <span>Early-access prototype — queues may reset or differ between devices until persistent storage ships</span>
      </footer>
    </main>
  );
}
