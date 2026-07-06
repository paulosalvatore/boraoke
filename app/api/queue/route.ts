import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { store, DEFAULT_ROOM, QUEUE_MAX, type Mode } from "@/lib/store";
import { isValidVideoId, parseYouTubeVideoId } from "@/lib/youtube";

// Input limits — this is an unauthenticated endpoint; reject oversized input with 400.
const MAX_BODY_BYTES = 4096;
const MAX_NICKNAME = 30;
const MAX_TITLE = 120;
const MAX_TABLE = 10;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const [items, current] = await Promise.all([
    store.getQueue(DEFAULT_ROOM),
    store.nowPlaying(DEFAULT_ROOM),
  ]);
  return NextResponse.json({ items, nowPlaying: current });
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
    youtubeUrl,
    videoId: rawVideoId,
    title,
    nickname,
    patronUuid,
    table,
    mode,
  } = body as Record<string, unknown>;

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

  const entry = {
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

  // Queue-depth cap — stop unauthenticated storage exhaustion. addEntry returns
  // false (without adding) when the room is at QUEUE_MAX.
  const added = await store.addEntry(DEFAULT_ROOM, entry);
  if (!added) {
    return NextResponse.json(
      { error: `Queue is full (max ${QUEUE_MAX} entries) — try again later` },
      { status: 429 }
    );
  }

  return NextResponse.json({ entry }, { status: 201 });
}
