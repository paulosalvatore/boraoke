"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { parseYouTubeVideoId } from "@/lib/youtube";
import { augmentQuery } from "@/lib/search-query";
import type { Mode } from "@/lib/store";
import { MAX_SEARCH_PAGES, type SearchResult } from "@/lib/youtube-search";

const DEBOUNCE_MS = 400;
const MIN_CHARS = 3;

/**
 * Rows revealed per "load more" tap. The server hands us up to
 * SEARCH_DEFAULTS.maxResults (50) rows for ONE of the platform's 100 daily
 * `search.list` calls, so the first ~6 taps of "load more" are pure client-side
 * reveals costing nothing — only exhausting all 50 spends another daily search,
 * and only up to MAX_SEARCH_PAGES (TICKET-83).
 */
const PAGE_SIZE = 8;

export interface SongSelection {
  videoId: string;
  title?: string;
}

interface SongSearchProps {
  patronUuid: string;
  /**
   * Entry mode (TICKET-40). In "sing" mode the free-text query is augmented with
   * the "karaoke" keyword before hitting /api/search; other modes search raw.
   * Pasted YouTube links are never affected.
   *
   * TICKET-83: the chooser now lives HERE, ABOVE the query input, so the patron
   * picks the mode BEFORE typing. Changing it never re-fires a search — see
   * `runSearch`/`modeRef` below.
   */
  mode: Mode;
  /** Set the entry mode (owned by the parent — it also rides on submit). */
  onModeChange: (mode: Mode) => void;
  /**
   * Called with the current selection, or null when the selection is cleared.
   * NOTE (TICKET-40 §1 / BUG-01): the parent drives the jump-to-CTA
   * (scroll+focus) off this selection state via an effect — one code path for
   * both the result-pick and paste-resolve flows (see PatronRoom).
   */
  onSelect: (selection: SongSelection | null) => void;
}

/**
 * Dual-behavior song picker (TICKET-8 / design §2 patron-02-pick-song):
 *   - Free text (≥3 chars) → debounced call to /api/search → tappable result rows.
 *   - A pasted YouTube URL/ID → resolved locally via parseYouTubeVideoId, NO API call.
 * Degraded (no key / quota / error) shows the fallback copy; paste-link still works.
 *
 * TICKET-83 adds: mode-before-query (a mode change costs ZERO quota) and a
 * "load more" affordance that reveals already-fetched rows before it ever
 * spends a second API call.
 */
export default function SongSearch({ patronUuid, mode, onModeChange, onSelect }: SongSearchProps) {
  // i18n (TICKET-30): all user-facing copy from the `Search` catalog.
  const t = useTranslations("Search");
  const [input, setInput] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  /** How many of `results` are currently rendered (grows by PAGE_SIZE). */
  const [visible, setVisible] = useState(PAGE_SIZE);
  /** Google cursor for the NEXT server page; "" when there is no further page. */
  const [nextPageToken, setNextPageToken] = useState("");
  /**
   * How many server pages this query has spent so far. Each one is a whole
   * daily search for the entire platform, so it is hard-capped at
   * MAX_SEARCH_PAGES and NEVER incremented speculatively — only a deliberate
   * "load more" tap past the fetched rows spends one (TICKET-83).
   */
  const [pagesFetched, setPagesFetched] = useState(1);
  /** The mode the CURRENT results were searched under (null = none/paste). */
  const [resultsMode, setResultsMode] = useState<Mode | null>(null);
  /**
   * The RAW query the current results came from. "load more" must page against
   * THIS, not the live input: during the 400ms debounce after the patron edits
   * the query, the old results (and the load-more button) are still on screen
   * while `nextPageToken` still belongs to the OLD query. Pairing a new query
   * with an old cursor is a guaranteed cache miss — one of the platform's 100
   * daily searches spent on a request whose results are junk, then cached for
   * 12h. Pinning the query makes that impossible.
   */
  const [resultsQuery, setResultsQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [degraded, setDegraded] = useState(false);
  /**
   * TICKET-87: which degraded copy to show. The platform's daily `search.list`
   * budget being spent is a DIFFERENT thing from "search is down" — it is
   * expected, temporary, and resets at midnight Pacific — so it gets its own
   * honest message instead of a generic outage line. Every other degraded
   * reason keeps the pre-existing copy. Either way the paste-a-YouTube-link
   * input above stays fully functional (it costs no search call).
   */
  const [dailyLimited, setDailyLimited] = useState(false);

  /**
   * Leave the degraded state entirely (TICKET-87). Both flags must clear
   * together — a stale `dailyLimited` would otherwise mislabel the NEXT
   * degraded response as "today's budget is spent". State setters are stable,
   * so this callback never changes identity.
   */
  const clearDegraded = useCallback(() => {
    setDegraded(false);
    setDailyLimited(false);
  }, []);
  const [rateLimitMsg, setRateLimitMsg] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which mode chip has keyboard focus (the real radio is visually hidden). */
  const [focusedMode, setFocusedMode] = useState<Mode | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0); // guards against out-of-order responses

  /**
   * THE POINT OF TICKET-83: the live mode is read through a ref, so `runSearch`
   * keeps a STABLE identity across mode changes. The search effect below
   * depends on `runSearch`, so a mode flip re-renders the chooser and nothing
   * else — it can never re-trigger a debounce, a fetch, or a quota charge.
   */
  const modeRef = useRef<Mode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    onSelect(null);
  }, [onSelect]);

  const runSearch = useCallback(
    async (q: string) => {
      const seq = ++seqRef.current;
      const searchMode = modeRef.current;
      setLoading(true);
      clearDegraded();
      setRateLimitMsg("");
      try {
        // Mode-aware augmentation (TICKET-40): sing → append "karaoke", others → raw.
        const augmented = augmentQuery(q, searchMode);
        const params = new URLSearchParams({ q: augmented, uuid: patronUuid || "anon" });
        const res = await fetch(`/api/search?${params.toString()}`);
        if (seq !== seqRef.current) return; // a newer query superseded this one

        // A fresh search always restarts pagination (and its page budget).
        setVisible(PAGE_SIZE);
        setNextPageToken("");
        setPagesFetched(1);

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          setResults([]);
          setResultsMode(null);
          setResultsQuery("");
          setRateLimitMsg(data.error ?? t("rateLimited"));
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data.degraded) {
          setResults([]);
          setResultsMode(null);
          setResultsQuery("");
          setDailyLimited(data.reason === "daily-limit");
          setDegraded(true);
          return;
        }
        setResults(Array.isArray(data.results) ? data.results : []);
        setNextPageToken(typeof data.nextPageToken === "string" ? data.nextPageToken : "");
        setResultsMode(searchMode);
        setResultsQuery(q);
      } catch {
        if (seq !== seqRef.current) return;
        // Network error → fail soft to the paste-link fallback. This is a real
        // outage, not the daily budget, so it keeps the generic copy.
        setResults([]);
        setResultsMode(null);
        setResultsQuery("");
        setDailyLimited(false);
        setDegraded(true);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    // `t` is stable per locale (a locale change remounts the tree) and is
    // deliberately excluded so `runSearch` keeps a stable identity — the search
    // effect depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patronUuid],
  );

  /**
   * "Load more" (TICKET-83). Two tiers, cheapest first:
   *   1. Rows already fetched but not yet rendered → reveal them. ZERO quota,
   *      zero network. This is the common case (50 fetched, 8 shown) and covers
   *      ~6 taps.
   *   2. Only once those run out, AND Google gave us a nextPageToken, AND we
   *      are still under MAX_SEARCH_PAGES → fetch the next server page. On a
   *      cache MISS that is one of the platform's 100 daily searches; on a hit
   *      it is free, since the route's cache key includes the token.
   * Nothing is prefetched: a page is only ever fetched after the patron taps.
   * Any failure leaves the current results intact (fail-open).
   */
  const loadMore = useCallback(async () => {
    if (visible < results.length) {
      setVisible((v) => v + PAGE_SIZE);
      return;
    }
    // Depth cap: past this the honest answer is "refine your search", not
    // another 1% of the platform's daily search budget.
    if (!nextPageToken || loadingMore || pagesFetched >= MAX_SEARCH_PAGES) return;
    // The cursor belongs to `resultsQuery`; if we don't have it, we have no
    // business spending a daily search.
    if (!resultsQuery) return;

    const seq = seqRef.current;
    setLoadingMore(true);
    try {
      const augmented = augmentQuery(resultsQuery, resultsMode ?? modeRef.current);
      const params = new URLSearchParams({
        q: augmented,
        uuid: patronUuid || "anon",
        pageToken: nextPageToken,
        page: String(pagesFetched + 1),
      });
      const res = await fetch(`/api/search?${params.toString()}`);
      if (seq !== seqRef.current) return; // a newer search superseded this page
      const data = await res.json().catch(() => ({}));
      // TICKET-87: the platform's daily search budget is spent. Silently
      // swallowing this would leave the patron tapping "load more" forever with
      // nothing happening. Keep the rows already on screen (they cost nothing),
      // retire the load-more button by dropping the cursor so there is nothing
      // left to tap, and say plainly why. The paste-a-link input is unaffected.
      if (data.degraded && data.reason === "daily-limit") {
        setNextPageToken("");
        setDailyLimited(true);
        setDegraded(true);
        return;
      }
      if (!res.ok || data.degraded || !Array.isArray(data.results)) return;
      setResults((prev) => {
        // Defensive de-dup: Google can repeat an id across page boundaries.
        const seen = new Set(prev.map((r) => r.videoId));
        return [...prev, ...(data.results as SearchResult[]).filter((r) => !seen.has(r.videoId))];
      });
      setNextPageToken(typeof data.nextPageToken === "string" ? data.nextPageToken : "");
      setPagesFetched((p) => p + 1);
      setVisible((v) => v + PAGE_SIZE);
    } catch {
      // Fail-open: keep what we have; the button stays available for a retry.
    } finally {
      setLoadingMore(false);
    }
  }, [visible, results.length, nextPageToken, loadingMore, pagesFetched, resultsQuery, resultsMode, patronUuid]);

  // React to input changes: resolve pasted links locally, else debounce a search.
  useEffect(() => {
    const trimmed = input.trim();

    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Empty → reset everything.
    if (!trimmed) {
      setResults([]);
      setResultsMode(null);
      setResultsQuery("");
      setVisible(PAGE_SIZE);
      setNextPageToken("");
      setPagesFetched(1);
      setLoading(false);
      clearDegraded();
      setRateLimitMsg("");
      clearSelection();
      return;
    }

    // Pasted URL / raw ID → resolve directly, no API call (AC2).
    const pastedId = parseYouTubeVideoId(trimmed);
    if (pastedId) {
      seqRef.current++; // cancel any in-flight search
      setLoading(false);
      clearDegraded();
      setRateLimitMsg("");
      // A pasted link is a single, mode-irrelevant row: no pagination, and no
      // "results are for another mode" notice (TICKET-83).
      setVisible(PAGE_SIZE);
      setNextPageToken("");
      setPagesFetched(1);
      setResultsMode(null);
      setResultsQuery("");
      setResults([
        {
          videoId: pastedId,
          title: t("youtubeLink"),
          channelTitle: t("pastedLink"),
          duration: "",
          thumbnailUrl: `https://i.ytimg.com/vi/${pastedId}/mqdefault.jpg`,
        },
      ]);
      // Auto-select the resolved link. (The parent's effect on the selection
      // state performs the jump-to-CTA — TICKET-40 §1.)
      setSelectedId(pastedId);
      onSelect({ videoId: pastedId });
      return;
    }

    // Too short to search — keep paste-link possible but no results yet.
    if (trimmed.length < MIN_CHARS) {
      setResults([]);
      setResultsMode(null);
      setResultsQuery("");
      setVisible(PAGE_SIZE);
      setNextPageToken("");
      setPagesFetched(1);
      setLoading(false);
      clearDegraded();
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
      title: r.title && r.title !== t("youtubeLink") ? r.title : undefined,
    });
  }

  const modeName = (m: Mode) => (m === "sing" ? t("modeSing") : t("modeListen"));
  const shown = results.slice(0, visible);
  /**
   * The patron has edited the query but the debounced search hasn't landed yet,
   * so the results (and their cursor) belong to the PREVIOUS query. Offering
   * "load more" here would spend one of the day's 100 searches deepening a
   * query the patron has already moved off. Withdraw the affordance instead.
   */
  const queryDirty = resultsQuery !== "" && input.trim() !== resultsQuery;
  const canFetchMore =
    !!nextPageToken && pagesFetched < MAX_SEARCH_PAGES && !queryDirty;
  const hasMore = visible < results.length || canFetchMore;
  /** Everything fetched is shown and the page budget is spent — suggest refining. */
  const capped = !hasMore && !!nextPageToken;
  /**
   * Can we honestly claim we've seen everything? Only if this payload came from
   * a post-TICKET-83 fetch. A LEGACY cache entry (written before this ticket, and
   * live for up to 12h after deploy) is a bare array of the OLD 8-row page with
   * no cursor — Google had more, we just can't see it from here. Those look
   * exactly like an exhausted list, so on anything at or under one client page
   * we use the neutral "try other words" copy rather than asserting a falsehood.
   */
  const certainlyExhausted = results.length > PAGE_SIZE;
  /** Results on screen were fetched under a different mode than the one now selected. */
  const staleMode = resultsMode !== null && resultsMode !== mode && results.length > 0;

  const chipStyle = (active: boolean, focused: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.4rem",
    flex: 1,
    // Positioned ancestor for the visually-hidden radio, so the native focus
    // ring lands on the chip rather than the initial containing block.
    position: "relative",
    minHeight: 44, // comfortable phone tap target
    padding: "0.5rem 0.75rem",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "0.95rem",
    fontWeight: active ? 700 : 500,
    color: active ? "var(--accent-text)" : "var(--text-muted)",
    background: active ? "rgba(230,57,70,0.12)" : "var(--surface)",
    border: `${active ? 2 : 1}px solid ${active ? "var(--accent)" : "var(--border)"}`,
    // The radio itself is visually hidden, so the chip has to carry the focus
    // ring or keyboard users get no indication at all.
    outline: focused ? "2px solid var(--accent-text)" : "none",
    outlineOffset: 2,
  });

  return (
    <div>
      {/* TICKET-83 §1: the mode choice comes BEFORE the query. "sing" is
          pre-selected, so a patron can ignore this and type immediately — the
          input is never gated behind a choice. Flipping it costs zero quota. */}
      <div
        role="radiogroup"
        aria-label={t("modeLegend")}
        data-testid="search-mode-chooser"
        style={{ marginBottom: "0.75rem" }}
      >
        <span style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
          {t("modeLegend")}
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {(["sing", "listen-dance"] as const).map((m) => (
            <label key={m} style={chipStyle(mode === m, focusedMode === m)}>
              <input
                type="radio"
                name="song-search-mode"
                value={m}
                checked={mode === m}
                onChange={() => onModeChange(m)}
                onFocus={() => setFocusedMode(m)}
                onBlur={() => setFocusedMode(null)}
                style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
              />
              {modeName(m)}
            </label>
          ))}
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>{t("modeHint")}</p>
      </div>

      <label
        htmlFor="song-search-input"
        style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}
      >
        {t("label")}
      </label>
      <input
        id="song-search-input"
        aria-label={t("aria")}
        placeholder={t("placeholder")}
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
          {dailyLimited ? t("dailyLimit") : t("degraded")}
        </p>
      )}

      {/* Rate-limit notice */}
      {rateLimitMsg && !loading && (
        <p role="status" style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "var(--accent-text)" }}>
          {rateLimitMsg}
        </p>
      )}

      {/* Which mode these results were searched under (TICKET-83 — "make it
          obvious which mode is active when results are shown"). */}
      {!loading && results.length > 0 && resultsMode !== null && (
        <p
          data-testid="search-results-mode"
          style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}
        >
          {t("resultsFor", { mode: modeName(resultsMode) })}
        </p>
      )}

      {/* The patron changed mode AFTER searching. We deliberately do NOT re-fire
          automatically (that is the quota bug TICKET-83 fixes) — re-running is
          an explicit, deliberate tap. */}
      {!loading && staleMode && resultsMode !== null && (
        <div
          data-testid="search-mode-stale"
          role="status"
          style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
        >
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {t("modeChanged", { mode: modeName(resultsMode) })}
          </span>
          <button
            type="button"
            data-testid="search-again"
            onClick={() => runSearch(input.trim())}
            style={{
              minHeight: 36,
              padding: "0.25rem 0.75rem",
              borderRadius: "999px",
              background: "transparent",
              border: "1px solid var(--accent)",
              color: "var(--accent-text)",
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            {t("searchAgain")}
          </button>
        </div>
      )}

      {/* Results */}
      {!loading && results.length > 0 && (
        <ul
          style={{ listStyle: "none", marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          {shown.map((r) => {
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
                    <span aria-hidden style={{ color: "var(--accent-text)", fontWeight: 700, fontSize: "1.1rem" }}>
                      ✓
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* TICKET-83 §2 — "load more", not numbered pages: one big thumb target at
          the end of the list is the right affordance on a phone in a noisy bar,
          and it keeps the patron's place instead of repainting the list. */}
      {!loading && results.length > 0 && hasMore && (
        <button
          type="button"
          data-testid="search-load-more"
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            marginTop: "0.75rem",
            width: "100%",
            minHeight: 48,
            borderRadius: "var(--radius)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            fontSize: "0.95rem",
            fontWeight: 600,
            cursor: loadingMore ? "progress" : "pointer",
          }}
        >
          {loadingMore ? t("loadingMore") : t("loadMore")}
        </button>
      )}

      {/* End of the road: everything fetched is shown and Google has no more.
          Deliberately gated on >1 row: a single result (including a resolved
          paste-link) needs no epilogue telling the patron the list ended. */}
      {!loading && results.length > 1 && !hasMore && (
        <p
          data-testid="search-no-more"
          style={{ marginTop: "0.6rem", fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center" }}
        >
          {capped || !certainlyExhausted ? t("refineSearch") : t("noMoreResults")}
        </p>
      )}
    </div>
  );
}
