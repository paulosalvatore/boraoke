/**
 * Karaoke index harvest — builds index shards using ONLY the
 * endpoints that bill against the ~10,000-unit/day pool boraoke barely touches.
 *
 * IT CAN NEVER SPEND A `search.list` CALL. Every outbound URL passes through
 * `assertNoSearchList()`, which throws on any path containing "search" before a
 * request is made. That is a guard, not a comment: the 100-call/day search
 * bucket is the resource this whole tier exists to protect.
 *
 * Unit ledger (1 unit per call, all against the 10k pool):
 *   videos.list        — resolve seed videoIds -> channelIds   (1 per 50 ids)
 *   playlistItems.list — 50 upload rows per page               (1 per page)
 *   videos.list        — duration + playability for that page  (1 per page)
 *
 * The uploads playlist id is derived ("UC…" -> "UU…"), which saves a
 * channels.list call per channel; a channel whose derived playlist 404s is
 * skipped and reported, never retried in a loop.
 *
 * Pure apart from the injected `fetchImpl`: the API key is passed in by the
 * caller (CLI script or cron route), never read here, and never logged.
 */

import { formatISODuration, decodeHtmlEntities } from "../youtube-search";
import type { ChannelShard, IndexRow } from "./types";

const API_ORIGIN = "https://www.googleapis.com";
const API_BASE = "/youtube/v3/";
const CALL_TIMEOUT_MS = 10_000;

/** Throws if `url` would hit the search.list bucket. Exported for tests. */
export function assertNoSearchList(url: string): void {
  const path = new URL(url).pathname;
  if (/search/i.test(path)) {
    throw new Error(`REFUSED: ${path} would spend the search.list bucket`);
  }
}

/** Counts units and refuses to exceed a hard cap. */
export class UnitLedger {
  used = 0;
  constructor(readonly max: number) {}
  get remaining(): number {
    return this.max - this.used;
  }
  charge(): void {
    if (this.used >= this.max) throw new UnitBudgetExhausted(this.max);
    this.used++;
  }
  /**
   * Atomically reserve `n` units (false = not enough left). Concurrent
   * channel harvests reserve a whole page up front, so two workers can never
   * both start a page the budget can only pay for once.
   */
  tryReserve(n: number): boolean {
    if (this.max - this.used < n) return false;
    this.used += n;
    return true;
  }
  /** Return reserved units that were not spent (e.g. a page with no new ids). */
  refund(n: number): void {
    this.used = Math.max(0, this.used - n);
  }
}

export class UnitBudgetExhausted extends Error {
  constructor(max: number) {
    super(`unit budget ${max} exhausted`);
    this.name = "UnitBudgetExhausted";
  }
}

export interface HarvestDeps {
  key: string;
  ledger: UnitLedger;
  fetchImpl?: typeof fetch;
}

async function api<T>(
  endpoint: "videos" | "playlistItems",
  params: Record<string, string>,
  deps: HarvestDeps,
  prepaid = false,
): Promise<{ ok: true; json: T } | { ok: false; status: number }> {
  const url = new URL(`${API_BASE}${endpoint}`, API_ORIGIN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", deps.key);
  assertNoSearchList(url.toString());
  if (!prepaid) deps.ledger.charge(); // charged BEFORE the call: a failed call still bills
  const res = await (deps.fetchImpl ?? fetch)(url.toString(), {
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, json: (await res.json()) as T };
}

const chunk = <T,>(a: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

interface VideosJson {
  items?: Array<{
    id?: string;
    snippet?: { channelId?: string; channelTitle?: string };
    contentDetails?: {
      duration?: string;
      regionRestriction?: { allowed?: string[]; blocked?: string[] };
    };
    status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
  }>;
}

interface PlaylistItemsJson {
  nextPageToken?: string;
  items?: Array<{
    snippet?: { title?: string; channelTitle?: string };
    contentDetails?: { videoId?: string };
  }>;
}

/** Resolve seed videoIds to their channels (1 unit per 50 ids). */
export async function resolveSeedChannels(
  videoIds: readonly string[],
  deps: HarvestDeps,
): Promise<Map<string, string>> {
  const byVideo = new Map<string, { channelId: string; title: string }>();
  const unique = [...new Set(videoIds)];
  for (const ids of chunk(unique, 50)) {
    const r = await api<VideosJson>("videos", { part: "snippet", id: ids.join(",") }, deps);
    if (!r.ok) throw new Error(`videos.list HTTP ${r.status} while resolving seeds`);
    for (const it of r.json.items ?? []) {
      const channelId = it.snippet?.channelId;
      if (it.id && channelId) byVideo.set(it.id, { channelId, title: it.snippet?.channelTitle ?? "" });
    }
  }
  // Preserve the SEED order (seeds are ranked), not the API's response order.
  const channels = new Map<string, string>(); // channelId -> channelTitle
  for (const v of unique) {
    const c = byVideo.get(v);
    if (c && !channels.has(c.channelId)) channels.set(c.channelId, c.title);
  }
  return channels;
}

/** "UCxxxx" -> "UUxxxx" (YouTube's uploads playlist id convention). */
export function uploadsPlaylistId(channelId: string): string | null {
  return /^UC[A-Za-z0-9_-]{22}$/.test(channelId) ? `UU${channelId.slice(2)}` : null;
}

/** The market the product serves; rows blocked here are useless to a venue. */
const REGION = "BR";

/**
 * Keep only rows a venue TV can actually play: public, processed, embeddable,
 * not region-blocked in BR, and with a real duration (a live/upcoming stream
 * reports P0D). Mirrors what search.list's videoEmbeddable filter gives the
 * live tier; the queue route's embeddability pre-check still runs on submit.
 */
export function isPlayableHere(v: NonNullable<VideosJson["items"]>[number]): boolean {
  if (v.status?.embeddable === false) return false;
  if (v.status?.privacyStatus && v.status.privacyStatus !== "public") return false;
  if (v.status?.uploadStatus && v.status.uploadStatus !== "processed") return false;
  const rr = v.contentDetails?.regionRestriction;
  if (rr?.blocked?.includes(REGION)) return false;
  if (rr?.allowed && !rr.allowed.includes(REGION)) return false;
  const d = formatISODuration(v.contentDetails?.duration);
  return d !== "" && d !== "0:00";
}

export interface HarvestChannelResult {
  shard: ChannelShard | null;
  /**
   * True only when the channel was harvested to its natural end (last page) or
   * to the `maxPages` policy cap. Anything cut short — unit budget, time budget,
   * an HTTP error mid-channel — is incomplete, and an incomplete shard must
   * never replace a stored complete one.
   */
  complete: boolean;
  /** Why the shard is null / partial, for the run log. */
  note?: string;
  calls: number;
}

/**
 * Harvest one channel's most recent uploads (newest first) into a shard.
 * Stops at `maxPages` pages (50 rows each) or when the ledger runs dry; a run
 * that hits the ledger mid-channel keeps what it already has.
 */
export async function harvestChannel(
  channelId: string,
  deps: HarvestDeps,
  opts: { maxPages: number; now?: number; /** Epoch ms after which no new page starts. */ deadline?: number },
): Promise<HarvestChannelResult> {
  const playlistId = uploadsPlaylistId(channelId);
  if (!playlistId) return { shard: null, complete: false, note: "not a UC channel id", calls: 0 };
  const startUnits = deps.ledger.used;
  const rows: IndexRow[] = [];
  const seen = new Set<string>();
  let channelTitle = "";
  let pageToken = "";
  let note: string | undefined;
  let complete = false;
  for (let page = 0; ; page++) {
    if (page >= opts.maxPages) {
      complete = true; // the per-channel policy cap is a full harvest
      break;
    }
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      note = "time budget reached mid-channel";
      break;
    }
    // Each page costs up to 2 units, reserved atomically up front so a page is
    // never started that the (shared, concurrent) budget cannot finish.
    if (!deps.ledger.tryReserve(2)) {
      note = "unit budget reached mid-channel";
      break;
    }
    const pl = await api<PlaylistItemsJson>(
      "playlistItems",
      {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      },
      deps,
      true,
    );
    if (!pl.ok) {
      deps.ledger.refund(1); // the videos.list half of the reservation was not spent
      note = `playlistItems HTTP ${pl.status}`;
      break;
    }
    const titles = new Map<string, string>();
    for (const it of pl.json.items ?? []) {
      const id = it.contentDetails?.videoId;
      const title = it.snippet?.title;
      if (!channelTitle && it.snippet?.channelTitle) channelTitle = it.snippet.channelTitle;
      if (!id || !title || title === "Private video" || title === "Deleted video") continue;
      if (!seen.has(id)) titles.set(id, title);
    }
    if (titles.size > 0) {
      const vids = await api<VideosJson>(
        "videos",
        { part: "contentDetails,status", id: [...titles.keys()].join(",") },
        deps,
        true,
      );
      if (vids.ok) {
        for (const v of vids.json.items ?? []) {
          if (!v.id || !titles.has(v.id) || !isPlayableHere(v)) continue;
          seen.add(v.id);
          rows.push([
            v.id,
            decodeHtmlEntities(titles.get(v.id) as string),
            formatISODuration(v.contentDetails?.duration),
          ]);
        }
      } else {
        note = `videos.list HTTP ${vids.status}`;
        break;
      }
    } else {
      deps.ledger.refund(1);
    }
    pageToken = pl.json.nextPageToken ?? "";
    if (!pageToken) {
      complete = true;
      break;
    }
  }
  const calls = deps.ledger.used - startUnits;
  if (rows.length === 0) return { shard: null, complete, note: note ?? "no playable rows", calls };
  return {
    shard: {
      v: 1,
      channelId,
      channelTitle: decodeHtmlEntities(channelTitle),
      harvestedAt: opts.now ?? Date.now(),
      rows,
    },
    complete,
    note,
    calls,
  };
}
