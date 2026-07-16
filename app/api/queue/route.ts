import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { store, DEFAULT_ROOM, QUEUE_MAX, type Mode, type QueueEntry } from "@/lib/store";
import { isValidRoomId, getRoomMode, getRoomModeration } from "@/lib/rooms";
import { checkSubmit, orderQueue, relayQueue } from "@/lib/rotation";
import { submitRateLimitOk } from "@/lib/queue-rate-limit";
import { getTranslations } from "next-intl/server";
import { clientIpFrom } from "@/lib/host-auth";
import { isValidVideoId, parseYouTubeVideoId } from "@/lib/youtube";
import { track } from "@/lib/telemetry";
import { pendingStore } from "@/lib/pending-store";
import {
  generatePendingId,
  pendingRoomMax,
  pendingUuidMax,
  type PendingEntry,
} from "@/lib/pending-types";

/**
 * Resolve the target room for a queue request. `room` comes from the `?room=`
 * query param (GET) or the request body (POST). Absent = the legacy `default`
 * room (back-compat). Returns null for a present-but-malformed id so the caller
 * can 400 — an unvalidated id must never reach a Redis key.
 */
function resolveRoomId(raw: unknown): string | null {
  if (raw == null || raw === "") return DEFAULT_ROOM;
  return isValidRoomId(raw) ? raw : null;
}

// Input limits — this is an unauthenticated endpoint; reject oversized input with 400.
const MAX_BODY_BYTES = 4096;
const MAX_NICKNAME = 30;
const MAX_TITLE = 120;
const MAX_TABLE = 10;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const roomId = resolveRoomId(req.nextUrl.searchParams.get("room"));
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  const [rawItems, paused, mode, moderation] = await Promise.all([
    store.getQueue(roomId),
    store.isPaused(roomId),
    getRoomMode(roomId),
    getRoomModeration(roomId),
  ]);
  // TICKET-10: render the EFFECTIVE (fairness-engine) order, not raw insertion
  // order. `orderQueue` pins items[0] as now-playing and is idempotent, so this
  // is correct whether or not a re-lay has already run. `mode` is additive —
  // patron/TV use it for position hints and the "queue reordered" toast.
  const items = orderQueue(rawItems, mode);
  const current = items[0] ?? null;
  // `paused` is additive (TICKET-7): host pause reflected on every polling view.
  // /tv consumes it to freeze playback; patron submits stay accepted while paused.
  // `moderation` is additive (TICKET-44): patron/admin views read it to know
  // whether a submit lands in the queue or in the pending-approval list.
  return NextResponse.json({ items, nowPlaying: current, paused, mode, moderation });
}

export async function POST(req: NextRequest) {
  // Cheap request-body size cap (defense in depth; platform limits still apply)
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const {
    room,
    youtubeUrl,
    videoId: rawVideoId,
    title,
    nickname,
    patronUuid,
    table,
    mode,
  } = body as Record<string, unknown>;

  const roomId = resolveRoomId(room);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  // Resolve videoId — accept either a pre-parsed videoId or a full URL.
  // BOTH paths must produce a strictly-valid 11-char YouTube video ID.
  const resolvedVideoId =
    typeof rawVideoId === "string" && rawVideoId
      ? rawVideoId
      : parseYouTubeVideoId(typeof youtubeUrl === "string" ? youtubeUrl : "");

  if (!resolvedVideoId || !isValidVideoId(resolvedVideoId)) {
    return NextResponse.json(
      { error: "Valid YouTube URL or videoId is required" },
      { status: 400 }
    );
  }

  if (typeof nickname !== "string" || nickname.trim().length === 0) {
    return NextResponse.json({ error: "nickname is required" }, { status: 400 });
  }
  if (nickname.trim().length > MAX_NICKNAME) {
    return NextResponse.json(
      { error: `nickname must be at most ${MAX_NICKNAME} characters` },
      { status: 400 }
    );
  }

  if (typeof patronUuid !== "string" || !UUID_RE.test(patronUuid.trim())) {
    return NextResponse.json(
      { error: "patronUuid must be a valid UUID" },
      { status: 400 }
    );
  }

  // TICKET-10 (security MEDIUM-1 track 2): dual-bucket submit rate limit —
  // 10/min per patronUuid + 60/min per IP. Charged only for well-formed
  // submissions (after uuid validation) so garbage requests can't burn a
  // legitimate patron's bucket; checked BEFORE any store work so an over-limit
  // caller never triggers a queue read or re-lay.
  if (!submitRateLimitOk(patronUuid.trim().toLowerCase(), clientIpFrom(req))) {
    void track("submit_rejected", { roomId, uuid: patronUuid.trim(), props: { reason: "rate" } }); // fire-and-forget, fail-open
    // i18n (TICKET-30): user-facing copy follows the request locale.
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("submitRateLimited"), reason: "rate" },
      { status: 429 },
    );
  }

  if (typeof title === "string" && title.trim().length > MAX_TITLE) {
    return NextResponse.json(
      { error: `title must be at most ${MAX_TITLE} characters` },
      { status: 400 }
    );
  }

  if (typeof table === "string" && table.trim().length > MAX_TABLE) {
    return NextResponse.json(
      { error: `table must be at most ${MAX_TABLE} characters` },
      { status: 400 }
    );
  }

  const resolvedMode: Mode =
    mode === "listen-dance" ? "listen-dance" : "sing";

  const entry: QueueEntry = {
    id: uuidv4(),
    videoId: resolvedVideoId,
    title: typeof title === "string" && title.trim() ? title.trim() : undefined,
    nickname: nickname.trim(),
    patronUuid: patronUuid.trim(),
    table:
      typeof table === "string" && table.trim() ? table.trim() : undefined,
    mode: resolvedMode,
    submittedAt: new Date().toISOString(),
  };

  // TICKET-10: rotation-mode enforcement (caps / table-required / duplicate)
  // BEFORE the entry is stored. Friendly pt-BR copy for the patron; a 409 so the
  // client can distinguish it from a validation 400 or the capacity 429.
  const roomMode = await getRoomMode(roomId);
  const currentQueue = await store.getQueue(roomId);
  const check = checkSubmit(currentQueue, entry, roomMode);
  if (!check.ok) {
    void track("submit_rejected", { roomId, uuid: entry.patronUuid, props: { reason: check.reason } }); // TICKET-12: fire-and-forget, fail-open
    // i18n (TICKET-30): translate by the lib's fine-grained refusal code (the
    // lib's `message` stays the pt-BR source of truth / test surface).
    const te = await getTranslations("Errors");
    const CODE_KEY = {
      "table-required": "submitTableRequired",
      "listen-cap": "submitListenCap",
      duplicate: "submitDuplicate",
      "table-cap": "submitTableCap",
      "person-cap": "submitPersonCap",
    } as const;
    return NextResponse.json(
      { error: te(CODE_KEY[check.code], { cap: check.cap ?? 0 }), reason: check.reason },
      { status: 409 },
    );
  }

  // TICKET-44: venue-optional moderation. When the room has moderation ON, the
  // entry does NOT enter the queue — it is diverted to the parallel pending
  // keyspace so it never reaches the rotation engine / public queue / TV. The
  // host approves it later (that is where addEntry + caps finally apply). The
  // submit-time `checkSubmit` above already ran as a cheap pre-filter. When
  // moderation is OFF (default), this whole block is skipped and the flow below
  // is byte-identical to before.
  const moderation = await getRoomModeration(roomId);
  if (moderation) {
    // Bound the pending list: per-room + per-uuid caps (abuse coherence §6). The
    // upstream submit rate limit already ran; this is a second, durable bound so
    // one patron can't flood the host's approval queue.
    const [roomCount, uuidCount] = await Promise.all([
      pendingStore.countRoom(roomId),
      pendingStore.countUuid(roomId, entry.patronUuid),
    ]);
    if (roomCount >= pendingRoomMax() || uuidCount >= pendingUuidMax()) {
      void track("submit_rejected", { roomId, uuid: entry.patronUuid, props: { reason: "moderation" } }); // fire-and-forget
      const te = await getTranslations("Errors");
      return NextResponse.json(
        { error: te("pendingFull"), reason: "moderation" },
        { status: 429 },
      );
    }
    const pendingEntry: PendingEntry = {
      pendingId: generatePendingId(),
      roomId,
      entry,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await pendingStore.add(pendingEntry);
    // 202 Accepted (not 201): the submission is received but not yet queued.
    // Response is a minimal ack — the patron client refetches its own pending
    // list (GET /api/queue/pending) rather than reading the entry back here, so
    // we do NOT echo the full QueueEntry (drops patronUuid et al. — PR#25 sec
    // LOW-1: no needless PII/enumeration surface). `pending`/`pendingId` stay:
    // they are non-PII and the moderation test asserts them.
    return NextResponse.json(
      { pending: true, pendingId: pendingEntry.pendingId },
      { status: 202 },
    );
  }

  // Queue-depth cap — stop unauthenticated storage exhaustion. addEntry returns
  // false (without adding) when the room is at QUEUE_MAX.
  const added = await store.addEntry(roomId, entry);
  if (!added) {
    void track("submit_rejected", { roomId, uuid: entry.patronUuid, props: { reason: "cap" } }); // TICKET-12: fire-and-forget, fail-open
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("queueFull", { max: QUEUE_MAX }) },
      { status: 429 },
    );
  }

  // TICKET-10: re-lay the stored queue into effective (fairness) order so reads
  // AND the store-head-based advance/skip all reflect the new entry's fair slot.
  await relayQueue(roomId, roomMode);

  void track("song_queued", { roomId, uuid: entry.patronUuid, props: { kind: typeof rawVideoId === "string" && rawVideoId ? "search" : "paste", mode: resolvedMode } }); // TICKET-12: fire-and-forget, fail-open
  // Minimal ack — the patron client discards this body and refetches the queue
  // (GET /api/queue), so we do NOT echo the full QueueEntry / patronUuid back
  // (PR#25 sec LOW-2: trim needless PII/enumeration surface).
  return NextResponse.json({ ok: true }, { status: 201 });
}
