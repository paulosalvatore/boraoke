/**
 * TICKET-31 — closes the top-songs telemetry gap: `POST /api/queue/advance`'s
 * `song_played` emit must carry `videoId` (and `title`, when the advancing
 * entry has one) so `lib/analytics.ts` can rank plays without a schema break.
 *
 * NOTE: `store.advance()` shifts the queue and returns the NEW head (the
 * entry that becomes now-playing) — with a single queued entry, advancing it
 * empties the queue and returns null (nothing "next" to play), so every case
 * here seeds a "currently playing" head entry PLUS the entry under test as
 * the second queue slot, matching the real host-clicks-advance flow.
 */
import { NextRequest } from "next/server";
import { store, DEFAULT_ROOM, type QueueEntry } from "@/lib/store";
import { POST } from "@/app/api/queue/advance/route";
import { telemetryStore } from "@/lib/telemetry-store";
import { _resetAdvanceRateLimit } from "@/lib/advance-rate-limit";

function makeRequest(): NextRequest {
  return new NextRequest(`http://127.0.0.1:3040/api/queue/advance?room=${DEFAULT_ROOM}`, {
    method: "POST",
  });
}

function seed(id: string, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    videoId: overrides.videoId ?? `vid-${id}----`,
    title: overrides.title,
    nickname: overrides.nickname ?? `nick-${id}`,
    patronUuid: overrides.patronUuid ?? "123e4567-e89b-42d3-a456-426614174000",
    mode: overrides.mode ?? "sing",
    submittedAt: overrides.submittedAt ?? new Date().toISOString(),
  };
}

async function latestSongPlayedProps() {
  const today = new Date().toISOString().slice(0, 10);
  const events = await telemetryStore.listRange(today, today);
  const played = events.filter((e) => e.event === "song_played");
  return played[played.length - 1]?.props;
}

beforeEach(async () => {
  _resetAdvanceRateLimit();
  await store.clear(DEFAULT_ROOM);
  await telemetryStore.clear();
});

describe("POST /api/queue/advance — song_played telemetry props (TICKET-31)", () => {
  it("includes videoId and title when the entry that becomes now-playing has both", async () => {
    await store.addEntry(DEFAULT_ROOM, seed("currently-playing"));
    await store.addEntry(
      DEFAULT_ROOM,
      seed("entry-1", { videoId: "dQw4w9WgXcQ", title: "Never Gonna Give You Up" }),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nowPlaying?.id).toBe("entry-1"); // sanity: it's the seeded entry that advanced-into

    const props = await latestSongPlayedProps();
    expect(props).toMatchObject({
      mode: "sing",
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
    });
  });

  it("includes videoId but omits title when the entry has none (sanitizeProps drops undefined)", async () => {
    await store.addEntry(DEFAULT_ROOM, seed("currently-playing"));
    await store.addEntry(DEFAULT_ROOM, seed("entry-2", { videoId: "abcdefghijk" }));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const props = await latestSongPlayedProps();
    expect(props?.videoId).toBe("abcdefghijk");
    expect(props).not.toHaveProperty("title");
  });

  it("truncates an over-long title to MAX_PROP_STRING (64 chars) via the existing sanitizeProps guard", async () => {
    const longTitle = "x".repeat(200);
    await store.addEntry(DEFAULT_ROOM, seed("currently-playing"));
    await store.addEntry(DEFAULT_ROOM, seed("entry-3", { videoId: "zzzzzzzzzzz", title: longTitle }));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const props = await latestSongPlayedProps();
    expect(typeof props?.title).toBe("string");
    expect((props?.title as string).length).toBe(64);
  });

  it("still tracks song_played (no videoId prop) when the queue empties out (next is null)", async () => {
    await store.addEntry(DEFAULT_ROOM, seed("only-entry"));

    const res = await POST(makeRequest()); // advancing the only entry empties the queue → next === null
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nowPlaying).toBeNull();

    const props = await latestSongPlayedProps();
    expect(props).toBeUndefined(); // no song_played emitted at all — matches existing `if (next)` gate
  });
});
