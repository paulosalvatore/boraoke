"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { useTranslations } from "next-intl";
import type { QueueEntry, Mode } from "@/lib/store";
import type { PendingEntry } from "@/lib/pending-types";
import { MODE_MESSAGE_KEY, type RoomMode } from "@/lib/rotation-modes";
import SongSearch, { type SongSelection } from "@/components/SongSearch";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { rememberJoinedRoom } from "@/lib/room-memory";

const POLL_INTERVAL = 3000;

/**
 * Patron flow for a specific room (TICKET-9). Moved from the old global
 * `app/page.tsx` and made room-scoped: every queue call carries `?room=`/`room`,
 * and nickname + table persist PER ROOM in localStorage (`cantai:<room>:*`),
 * with the global `cantai_nickname` as a first-visit prefill. The venue name is
 * shown as a chip in the top bar.
 *
 * STORAGE-KEY NOTE (TICKET-33 rebrand): the `cantai*` localStorage keys below
 * are DELIBERATELY kept under the old brand name. They are live state on real
 * users' devices — renaming them would drop every returning patron's identity,
 * nickname and table. Cosmetic key rename is not worth that. See
 * work/tickets/TICKET-33-code-rebrand.md.
 */
export default function PatronRoom({
  roomId,
  venueName,
}: {
  roomId: string;
  venueName: string;
}) {
  // i18n (TICKET-30): this page was the string audit's headline finding (~26
  // English strings on a pt-BR product). All user-facing copy now follows the
  // request locale via the `Patron` catalog.
  const t = useTranslations("Patron");
  const tCommon = useTranslations("Common");
  const tModes = useTranslations("Modes");
  const localizedMode = (m: RoomMode) => tModes(`${MODE_MESSAGE_KEY[m]}Name`);

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
  // TICKET-61: non-blocking server warning shown NEXT TO the success message
  // (the submit succeeded — this only says the video may not play on the TV).
  const [submitWarning, setSubmitWarning] = useState("");
  // TICKET-61: how the current selection was made, forwarded to the API so the
  // server only spends a quota unit on the paste path (search results are
  // already filtered to embeddable+syndicated videos). See the route comment.
  const [selectionSource, setSelectionSource] = useState<"paste" | "search">("search");
  const [submitting, setSubmitting] = useState(false);

  // Queue state
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [roomMode, setRoomMode] = useState<RoomMode | null>(null);
  const [reorderNotice, setReorderNotice] = useState("");
  const prevModeRef = useRef<RoomMode | null>(null);

  // Moderation (TICKET-44): this patron's own pending/rejected submissions.
  const [myPending, setMyPending] = useState<PendingEntry[]>([]);

  // Add-to-queue CTA — jumped into view + focused once a song is chosen (TICKET-40 §1).
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);

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

    // TICKET-26: register/refresh the server-side anonymous identity, adopting
    // this existing localStorage uuid for continuity (own-row highlighting
    // keeps working, no duplicate identity). Fire-and-forget — the join flow
    // never awaits this; a network/store failure is silently ignored and the
    // local uuid above keeps working exactly as before (fail-open, acceptance
    // #4). The server response uuid should normally equal what we sent; if it
    // ever differs (e.g. this device's cookie already pointed elsewhere) we
    // adopt the server's uuid so future submissions stay consistent with the
    // cookie, which is authoritative.
    fetch("/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legacyUuid: id }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { uuid?: string; registered?: boolean } | null) => {
        if (data?.registered && data.uuid && data.uuid !== id) {
          try {
            ls.setItem("cantai_patron_uuid", data.uuid);
          } catch { /* sandboxed */ }
          setPatronUuid(data.uuid);
        }
      })
      .catch(() => {
        // network hiccup / store outage — local uuid above already works;
        // registration retries on the next page load.
      });

    // Remember this as the last room joined (landing prefill).
    try { ls.setItem("cantai_last_room", roomId); } catch { /* sandboxed */ }

    // TICKET-43: add this room to the device's remembered-rooms list (joined
    // role) so it shows under the landing "Suas salas" section for quick
    // re-entry after a refresh. Uses the venue name for a friendly label.
    rememberJoinedRoom({ id: roomId, name: venueName || roomId });

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
          setReorderNotice(t("reorderNotice", { mode: localizedMode(nextMode) }));
          window.setTimeout(() => setReorderNotice(""), 5000);
        }
        prevModeRef.current = nextMode;
      }
    } catch {
      // network hiccup — next poll retries
    }
    // t/localizedMode are stable per locale (locale change remounts the tree).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Poll THIS patron's own pending/rejected submissions (TICKET-44). uuid-scoped
  // and public — only ever returns entries this patronUuid submitted. Skips until
  // the uuid is loaded.
  const fetchPending = useCallback(async () => {
    if (!patronUuid) return;
    try {
      const res = await fetch(
        `/api/queue/pending?room=${encodeURIComponent(roomId)}&uuid=${encodeURIComponent(patronUuid)}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setMyPending((data.items ?? []) as PendingEntry[]);
    } catch {
      // network hiccup — next poll retries
    }
  }, [roomId, patronUuid]);

  useEffect(() => {
    fetchQueue();
    fetchPending();
    const interval = setInterval(() => {
      fetchQueue();
      fetchPending();
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchQueue, fetchPending]);

  const handleSelect = useCallback((sel: SongSelection | null) => {
    setParsedVideoId(sel?.videoId ?? null);
    // TICKET-61: derive the selection SOURCE from the selection shape, which is
    // the only signal SongSearch exposes today (`SongSelection` is
    // `{ videoId, title? }`). SongSearch emits a title ONLY for a picked search
    // result; a resolved pasted link — and a pick of the synthetic row that a
    // paste creates — always come through with `title` undefined. So
    // "no title" == "paste" for every path in that component.
    //
    // Being wrong here is cheap by design: a mislabelled search result costs at
    // most one extra quota unit (and its check comes back embeddable anyway,
    // since search only returns embeddable results), and a mislabelled paste
    // just loses one advisory warning. Nothing about acceptance changes.
    // FOLLOW-UP: have SongSearch carry an explicit `source` on SongSelection —
    // that file is owned by a parallel ticket right now.
    setSelectionSource(sel && sel.title === undefined ? "paste" : "search");
    if (sel?.title) {
      setTitle((prev) => (prev.trim() ? prev : sel.title!));
    }
  }, []);

  // TICKET-40 §1: once a song is chosen (result picked or pasted link resolved),
  // remove the hunt for the CTA — scroll it into view AND focus it, WITHOUT
  // auto-submitting. On phones the CTA sits below the fold, so we center it above
  // the keyboard fold (block:"center") and focus without a second competing scroll
  // (preventScroll:true).
  //
  // Implemented as an effect on parsedVideoId (TICKET-40-BUG-01): both selection
  // sources (result pick AND paste-resolve) converge on setParsedVideoId via
  // handleSelect, and effects run AFTER React commits — so the CTA is already
  // enabled (`disabled={submitting || !parsedVideoId}`) when we focus it. The
  // previous callback + requestAnimationFrame fired while the state commit was
  // still pending in the degraded-paste path: the button was still disabled and
  // .focus() silently no-op'd. One effect = one code path for both flows. Skips
  // null (selection cleared / post-submit reset) so focus never jumps uninvited.
  useEffect(() => {
    if (!parsedVideoId) return;
    const btn = submitBtnRef.current;
    if (!btn) return;
    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    btn.focus({ preventScroll: true });
  }, [parsedVideoId]);

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
    setSubmitWarning("");

    if (!parsedVideoId) {
      setSubmitError(t("errorPasteUrl"));
      return;
    }
    if (!nickname.trim()) {
      setSubmitError(t("errorEnterNickname"));
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
          source: selectionSource,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSubmitError(err.error ?? t("errorAddFailed"));
        return;
      }
      // TICKET-61: the success body may carry an optional, non-blocking
      // `warning` (a localized string). Absent = nothing to show. A body that
      // fails to parse must never turn a successful submit into an error.
      const data = await res.json().catch(() => null);
      const w = (data as { warning?: unknown } | null)?.warning;
      if (typeof w === "string" && w) setSubmitWarning(w);
      setSubmitSuccess(true);
      setTitle("");
      setParsedVideoId(null);
      setSearchKey((k) => k + 1);
      fetchQueue();
      // TICKET-44: a moderated submit lands in pending (202), not the queue —
      // refresh the patron's own pending list so the "aguardando" card appears.
      fetchPending();
    } catch {
      setSubmitError(tCommon("networkError"));
    } finally {
      setSubmitting(false);
    }
  }

  // Nickname gate
  if (!nicknameSet) {
    return (
      <main style={{ maxWidth: 480, margin: "0 auto", padding: "2rem 1rem" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem" }}>
          <LanguageSwitcher />
        </div>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.25rem" }}>🎤 {tCommon("brand")}</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: "0.5rem" }}>
          {t.rich("queueForVenue", {
            venue: venueName,
            v: (chunks) => (
              <span style={{ color: "var(--accent-text)", fontWeight: 600 }}>{chunks}</span>
            ),
          })}
        </p>
        <p style={{ color: "var(--text-muted)", marginBottom: "2rem", fontSize: "0.85rem" }}>
          {t("roomLabel", { room: roomId })}
        </p>
        <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: 600 }}>
          {t("nicknameLabel")}
        </label>
        <input
          id="nickname-input"
          aria-label={t("nicknameLabel")}
          autoFocus
          placeholder={t("nicknamePlaceholder")}
          maxLength={30}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveNickname()}
          style={{ marginBottom: "1rem" }}
        />
        <button className="btn-primary" onClick={saveNickname} disabled={!nickname.trim()}>
          {t("joinQueue")}
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 540, margin: "0 auto", padding: "1.5rem 1rem" }}>
      {/*
       * TICKET-72: this header is also the mount point for the global feedback
       * widget's compact entry point (portalled in — see components/FeedbackWidget.tsx).
       * It used to be a rigid `space-between` row whose greeting could not shrink,
       * so a long nickname pushed the last item past the viewport edge: at 320px
       * the App Tester measured the feedback trigger fully off-canvas (header
       * scrollWidth 389 vs clientWidth 288) and ~15px clipped at 390px. The
       * greeting now degrades gracefully instead — it is allowed to shrink, and
       * the nickname ellipsizes — so the trailing control stays on screen at
       * every phone width. `flex-wrap` is the belt-and-braces fallback for
       * extreme cases (very large text-zoom).
       */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "1.75rem" }}>🎤 {tCommon("brand")}</h1>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.6rem", color: "var(--text-muted)", fontSize: "0.875rem", minWidth: 0, flexShrink: 1, overflow: "hidden" }}>
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <LanguageSwitcher />
          </span>
          <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{t("greeting")}</span>
          <button
            data-testid="patron-nickname-button"
            onClick={() => setNicknameSet(false)}
            style={{ background: "none", border: "none", color: "var(--accent-text)", cursor: "pointer", fontSize: "0.875rem", padding: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
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
          {table.trim() ? ` · ${tCommon("table")} ${table.trim()}` : ""}
        </span>
      </div>

      {/* Submit form */}
      <section style={{ background: "var(--surface)", borderRadius: "var(--radius)", padding: "1.25rem", marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>{t("addSong")}</h2>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {/* TICKET-83: the sing/vibe chooser now lives INSIDE SongSearch,
              above the query input, so the patron picks before searching and a
              change of mind costs no YouTube quota. The state stays here
              because the submit payload carries it. */}
          <SongSearch
            key={searchKey}
            patronUuid={patronUuid}
            mode={mode}
            onModeChange={setMode}
            onSelect={handleSelect}
          />
          {parsedVideoId && (
            <p style={{ fontSize: "0.8rem", color: "#4ade80" }}>{t("selected", { videoId: parsedVideoId })}</p>
          )}

          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
              {t("songTitleLabel")}
            </label>
            <input
              placeholder={t("songTitlePlaceholder")}
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Mode used to sit here as a <select>; TICKET-83 moved it above the
              search input (see SongSearch), so the table field is now full width. */}
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
              {t("tableLabel")}
            </label>
            <input
              placeholder={t("tablePlaceholder")}
              aria-label={t("tableAria")}
              maxLength={10}
              value={table}
              onChange={(e) => updateTable(e.target.value)}
            />
          </div>

          {submitError && <p style={{ color: "var(--accent-text)", fontSize: "0.875rem" }}>{submitError}</p>}
          {submitSuccess && <p style={{ color: "#4ade80", fontSize: "0.875rem" }}>{t("songAdded")}</p>}
          {/* TICKET-61: advisory only — the song IS in the queue; this warns the
              patron that the venue screen may refuse to play it. Amber, not red,
              and rendered below the success line so the two read together. */}
          {submitWarning && (
            <p role="status" data-testid="submit-warning" style={{ color: "#fbbf24", fontSize: "0.8rem" }}>
              ⚠️ {submitWarning}
            </p>
          )}

          <button
            ref={submitBtnRef}
            className="btn-primary"
            type="submit"
            disabled={submitting || !parsedVideoId}
          >
            {submitting ? t("adding") : t("addToQueue")}
          </button>
        </form>
      </section>

      {/* Moderation: this patron's pending / rejected submissions (TICKET-44).
          Shown OUTSIDE the public queue — a pending song is NOT in the queue and
          not on TV until the host approves it. */}
      {myPending.length > 0 && (
        <section data-testid="patron-pending" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>{t("pendingTitle")}</h2>
          <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {myPending.map((p) => {
              const rejected = p.status === "rejected";
              return (
                <li
                  key={p.pendingId}
                  data-testid={rejected ? "patron-pending-rejected" : "patron-pending-waiting"}
                  style={{
                    background: "var(--surface)",
                    border: `1px dashed ${rejected ? "var(--accent)" : "#818cf8"}`,
                    borderRadius: "var(--radius)",
                    padding: "0.75rem 1rem",
                    opacity: rejected ? 0.85 : 1,
                  }}
                >
                  <p style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.entry.title ?? `youtu.be/${p.entry.videoId}`}
                  </p>
                  <p style={{ fontSize: "0.8rem", color: rejected ? "var(--accent-text)" : "var(--text-muted)", marginTop: "4px" }}>
                    {rejected ? t("pendingRejected") : t("pendingWaiting")}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
          {t.rich("playerHint", {
            b: (chunks) => <strong>{chunks}</strong>,
            a: (chunks) => <span style={{ color: "var(--accent-text)" }}>{chunks}</span>,
          })}
        </span>
      </a>

      {/* Live queue */}
      <section>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
          {t("liveQueue")}{" "}
          <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: "0.875rem" }}>
            {t("queueCount", { count: queue.length })}
          </span>
        </h2>
        {roomMode && (
          <p
            data-testid="patron-mode-hint"
            style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginBottom: "0.5rem" }}
          >
            {t("modeHint", { mode: localizedMode(roomMode) })}
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
          <p style={{ color: "var(--text-muted)" }}>{t("emptyQueue")}</p>
        ) : (
          <ol style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {queue.map((entry, idx) => (
              <li
                key={entry.id}
                data-testid="queue-row"
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
                  <p
                    data-testid="queue-row-title"
                    style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {entry.title ?? `youtu.be/${entry.videoId}`}
                  </p>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px" }}>
                    {entry.nickname}
                    {entry.table ? ` · ${tCommon("table")} ${entry.table}` : ""}
                  </p>
                </div>
                <span
                  data-testid="queue-row-badge"
                  className={`badge ${entry.mode === "sing" ? "badge-sing" : "badge-listen"}`}
                >
                  {entry.mode === "sing" ? t("badgeSing") : t("badgeDance")}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer style={{ marginTop: "3rem", color: "var(--text-muted)", fontSize: "0.75rem", textAlign: "center" }}>
        <a href={`/${roomId}/tv`} target="_blank" rel="noreferrer">{t("venueScreen")}</a>
        {" · "}
        <span>{t("footer")}</span>
      </footer>
    </main>
  );
}
