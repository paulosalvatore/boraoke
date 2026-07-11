import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { getRoomMode } from "@/lib/rooms";
import { relayQueue } from "@/lib/rotation";
import { track } from "@/lib/telemetry";

/**
 * POST /api/host/skip?room=<id> — advance past the current head immediately,
 * regardless of playback position. Thin wrapper over the frozen store `advance`
 * op (the same one /tv uses on video end). Token-guarded, room-scoped.
 *
 * TICKET-10 no-show grace: an optional body `{ grace: true }` marks the skip as
 * a "singer didn't show" during the TV 30s call. For a sing head this grants the
 * spec's one grace re-queue — the entry is re-queued with `graceRequeue: true`
 * (the engine then schedules it at the front of its group's next-round slot)
 * instead of being dropped. Grace is HOST-authorized only (a patron can't
 * self-grant), and single-use by construction (the flag clears once it plays).
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let grace = false;
  try {
    const body = await req.json();
    grace = (body as Record<string, unknown>)?.grace === true;
  } catch {
    // no body / invalid JSON → plain skip
  }

  const head = await store.nowPlaying(roomId);

  if (grace && head && head.mode === "sing") {
    // No-show grace: re-queue this singer's entry with the grace flag rather
    // than dropping it. removeEntry + addEntry (frozen ops) rewrite the field;
    // relay then lands it at the front of its group's next round.
    await store.removeEntry(roomId, head.id);
    const requeued = await store.addEntry(roomId, {
      ...head,
      graceRequeue: true,
      submittedAt: new Date().toISOString(),
    });
    if (!requeued) {
      // Re-add was rejected (e.g. queue at QUEUE_MAX). The entry is already
      // removed and did NOT come back — surface it rather than silently dropping
      // the singer. Telemetry stays fire-and-forget, fail-open (TICKET-12 style).
      void track("host_action", {
        roomId,
        props: { action: "skip", grace: true, requeueFailed: "queue-full" },
      });
      const nowPlaying = await store.nowPlaying(roomId);
      return NextResponse.json(
        { ok: false, grace: true, requeued: false, reason: "queue-full", nowPlaying },
        { status: 200 },
      );
    }
    const mode = await getRoomMode(roomId);
    await relayQueue(roomId, mode);
    void track("song_skipped", { roomId, props: { reason: "noshow" } });
    void track("host_action", { roomId, props: { action: "skip", grace: true } });
    const nowPlaying = await store.nowPlaying(roomId);
    return NextResponse.json({ ok: true, grace: true, requeued: true, nowPlaying });
  }

  const nowPlaying = await store.advance(roomId);
  void track("song_skipped", { roomId, props: { reason: grace ? "noshow" : "host" } }); // TICKET-12: fire-and-forget, fail-open
  void track("host_action", { roomId, props: { action: "skip" } }); // TICKET-12: fire-and-forget, fail-open
  return NextResponse.json({ ok: true, nowPlaying });
}
