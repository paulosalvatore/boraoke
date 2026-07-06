/**
 * Feedback domain types + constants (TICKET-11) — the single source of truth
 * shared by the client widget and the server API/store.
 *
 * This file is deliberately PURE: no `server-only`, no React, no driver imports,
 * so both the `"use client"` widget and the server route/store can import it
 * without pulling server code into the client bundle (or vice-versa).
 */

/** 1-tap sentiment tokens. UI labels/emoji live in the widget; the wire stores tokens. */
export type Sentiment = "love" | "happy" | "meh" | "angry";

/** Optional category chips (spec: song search, queue/fairness, TV player, other). */
export type Category = "song-search" | "queue-fairness" | "tv-player" | "other";

/** Lifecycle status — powers the future close-the-loop (#15). */
export type FeedbackStatus =
  | "new"
  | "triaged"
  | "planned"
  | "shipped"
  | "dismissed";

export type Role = "patron" | "host";

export const SENTIMENTS: readonly Sentiment[] = [
  "love",
  "happy",
  "meh",
  "angry",
];

export const CATEGORIES: readonly Category[] = [
  "song-search",
  "queue-fairness",
  "tv-player",
  "other",
];

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  "new",
  "triaged",
  "planned",
  "shipped",
  "dismissed",
];

/**
 * Auto-attached context. No PII beyond the self-chosen nickname (LGPD-friendly).
 * Client fills the first block; the server augments the rest (it never trusts
 * the client for version/time/UA).
 */
export interface FeedbackContext {
  /** Device uuid (client localStorage). Required — it keys rate-limiting + close-the-loop. */
  uuid: string;
  nickname?: string;
  roomId?: string;
  route: string;
  mode?: string; // "sing" | "listen-dance" — best-effort
  role: Role;
  locale?: string;
  // ── server-filled (never trusted from the client) ──
  appVersion?: string;
  userAgent?: string; // coarse
  createdAt?: string; // server ISO 8601
}

/** A durable feedback record. */
export interface FeedbackRecord {
  id: string;
  sentiment: Sentiment;
  text?: string;
  category?: Category;
  context: FeedbackContext;
  status: FeedbackStatus;
  triageRef?: string;
}

/** The client → POST /api/feedback body. Everything but sentiment + uuid is optional. */
export interface FeedbackSubmission {
  sentiment: Sentiment;
  text?: string;
  category?: Category;
  context: Pick<
    FeedbackContext,
    "uuid" | "nickname" | "roomId" | "route" | "mode" | "role" | "locale"
  >;
}

/** Rate-limit policy (server-side, durable): 5 submissions per uuid per hour. */
export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
