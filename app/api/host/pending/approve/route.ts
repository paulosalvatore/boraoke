import { NextRequest, NextResponse } from "next/server";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { pendingStore } from "@/lib/pending-store";
import { store, QUEUE_MAX } from "@/lib/store";
import { getRoomMode } from "@/lib/rooms";
import { checkSubmit, relayQueue } from "@/lib/rotation";
import { getTranslations } from "next-intl/server";
import { track } from "@/lib/telemetry";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/pending/approve?room=<id> — approve a pending submission
 * (TICKET-44). Body: `{ pendingId }`. Host-authed, room-scoped.
 *
 * Approval is where an entry FINALLY enters the real queue — so ALL existing
 * caps/fairness apply AT APPROVAL TIME (not submit time): a song that sat pending
 * for 20 minutes must still fit the live queue. We take the entry from the
 * pending store, re-run `checkSubmit` + the `QUEUE_MAX` cap against the CURRENT
 * queue, and only then `addEntry` + `relayQueue`. If the entry no longer fits, we
 * put it BACK in pending (re-add) and refuse with a friendly 409 so the host can
 * retry after the queue drains — the entry is never silently lost.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  const pendingId = (body as Record<string, unknown>)?.pendingId;
  if (typeof pendingId !== "string" || !pendingId) {
    return NextResponse.json({ error: "pendingId is required" }, { status: 400 });
  }

  // Take (pop) the entry. Null = already approved/rejected/gone → 404.
  const item = await pendingStore.take(roomId, pendingId);
  if (!item) {
    return NextResponse.json({ error: "Pending entry not found" }, { status: 404 });
  }

  const mode = await getRoomMode(roomId);
  const currentQueue = await store.getQueue(roomId);

  // Caps AT APPROVAL time — same gate as a live submission.
  const check = checkSubmit(currentQueue, item.entry, mode);
  if (!check.ok) {
    await pendingStore.add(item); // put it back — never lost
    const te = await getTranslations("Errors");
    const CODE_KEY = {
      "table-required": "submitTableRequired",
      "listen-cap": "submitListenCap",
      duplicate: "submitDuplicate",
      "table-cap": "submitTableCap",
      "person-cap": "submitPersonCap",
    } as const;
    return NextResponse.json(
      {
        error: te(CODE_KEY[check.code], { cap: check.cap ?? 0 }),
        reason: check.reason,
      },
      { status: 409 },
    );
  }

  const added = await store.addEntry(roomId, item.entry);
  if (!added) {
    await pendingStore.add(item); // queue full — put it back
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("queueFull", { max: QUEUE_MAX }), reason: "cap" },
      { status: 409 },
    );
  }

  await relayQueue(roomId, mode);

  // Telemetry: host approved (new host_action prop VALUE) + the play now counts
  // as a real queue entry (song_queued), emitted here rather than at submit time.
  void track("host_action", { roomId, props: { action: "approve" } });
  void track("song_queued", {
    roomId,
    uuid: item.entry.patronUuid,
    props: { kind: "moderated", mode: item.entry.mode },
  });

  return NextResponse.json({ ok: true, entry: item.entry });
}
