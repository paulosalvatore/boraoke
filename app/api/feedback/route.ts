/**
 * /api/feedback (TICKET-11)
 *
 *   POST   — public. Zero-friction sentiment capture. Validates + rate-limits
 *            (5/uuid/hour, server-side) + writes to the durable feedback store.
 *   GET     — admin (house intake). `?since=<id>` watermark read. Guarded by a
 *            server-side FEEDBACK_ADMIN_TOKEN (never shipped to clients; fail-closed
 *            when unset).
 *   PATCH   — admin. Status-update write path (`new → triaged`, close-the-loop).
 *
 * The server NEVER trusts the client for appVersion / userAgent / createdAt /
 * status — it fills those itself.
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  feedbackStore,
  generateFeedbackId,
} from "@/lib/feedback-store";
import {
  CATEGORIES,
  FEEDBACK_STATUSES,
  RATE_LIMIT_MAX,
  SENTIMENTS,
  type Category,
  type FeedbackContext,
  type FeedbackRecord,
  type FeedbackStatus,
  type Role,
  type Sentiment,
} from "@/lib/feedback-types";

const MAX_BODY_BYTES = 8192;
const MAX_TEXT = 1000;
const MAX_NICKNAME = 30;
const MAX_ROOM = 64;
const MAX_ROUTE = 512;
const MAX_LOCALE = 35;
const MAX_UA = 180;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Coarsen a UA to a low-fingerprint token (truncate; drop nothing else fancy). */
function coarseUserAgent(ua: string | null): string | undefined {
  if (!ua) return undefined;
  return ua.slice(0, MAX_UA);
}

function appVersion(): string {
  return (
    process.env.GIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_GIT_SHA ||
    "dev"
  );
}

/**
 * Timing-safe admin token check (security M1). Fail-closed when the env token
 * is unset. `crypto.timingSafeEqual` requires equal-length buffers, so a length
 * mismatch is rejected up front — that leaks only the token's length, never its
 * contents, which is fine for a long random secret.
 */
function isAdmin(req: NextRequest): boolean {
  const expected = process.env.FEEDBACK_ADMIN_TOKEN;
  if (!expected) return false; // no token configured → nobody is admin
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = m?.[1]?.trim();
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — public submit
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return badRequest("Request body too large");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("Invalid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Body must be an object");
  }

  const { sentiment, text, category, context } = body as Record<
    string,
    unknown
  >;

  // sentiment — required, enum
  if (
    typeof sentiment !== "string" ||
    !SENTIMENTS.includes(sentiment as Sentiment)
  ) {
    return badRequest("A valid sentiment is required");
  }

  // category — optional, enum
  let cat: Category | undefined;
  if (category != null) {
    if (
      typeof category !== "string" ||
      !CATEGORIES.includes(category as Category)
    ) {
      return badRequest("Invalid category");
    }
    cat = category as Category;
  }

  // text — optional, capped
  const cleanText = str(text, MAX_TEXT);

  // context — object with a valid uuid (needed to key rate-limiting)
  if (typeof context !== "object" || context === null) {
    return badRequest("context is required");
  }
  const ctx = context as Record<string, unknown>;
  const uuid = typeof ctx.uuid === "string" ? ctx.uuid.trim() : "";
  if (!UUID_RE.test(uuid)) {
    return badRequest("A valid context.uuid is required");
  }

  const role: Role = ctx.role === "host" ? "host" : "patron";

  // Rate limit (durable, server-side): 5 per uuid per hour.
  const rate = await feedbackStore.hitRateLimit(uuid);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: `Você já mandou ${RATE_LIMIT_MAX} feedbacks nesta última hora — valeu demais! 🙏 Tenta de novo mais tarde.`,
      },
      { status: 429 },
    );
  }

  const fullContext: FeedbackContext = {
    uuid,
    nickname: str(ctx.nickname, MAX_NICKNAME),
    roomId: str(ctx.roomId, MAX_ROOM),
    route: str(ctx.route, MAX_ROUTE) ?? "/",
    mode: str(ctx.mode, 32),
    role,
    locale: str(ctx.locale, MAX_LOCALE),
    // ── server-filled (never trusted from the client) ──
    appVersion: appVersion(),
    userAgent: coarseUserAgent(req.headers.get("user-agent")),
    createdAt: new Date().toISOString(),
  };

  const record: FeedbackRecord = {
    id: generateFeedbackId(),
    sentiment: sentiment as Sentiment,
    ...(cleanText ? { text: cleanText } : {}),
    ...(cat ? { category: cat } : {}),
    context: fullContext,
    status: "new",
  };

  await feedbackStore.add(record);

  return NextResponse.json({ ok: true, id: record.id }, { status: 201 });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — admin watermark read
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const since = req.nextUrl.searchParams.get("since") ?? undefined;
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
  const items = await feedbackStore.list({
    since,
    ...(limit != null && Number.isFinite(limit) ? { limit } : {}),
  });
  const watermark = items.length ? items[items.length - 1].id : (since ?? null);
  return NextResponse.json({ items, watermark });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — admin status update (intake write path)
// ─────────────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return badRequest("Request body too large");

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("Invalid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Body must be an object");
  }

  const { id, status, triageRef } = body as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim()) {
    return badRequest("id is required");
  }
  if (
    typeof status !== "string" ||
    !FEEDBACK_STATUSES.includes(status as FeedbackStatus)
  ) {
    return badRequest("A valid status is required");
  }
  const ref = typeof triageRef === "string" ? triageRef.slice(0, 200) : undefined;

  const ok = await feedbackStore.updateStatus(
    id.trim(),
    status as FeedbackStatus,
    ref,
  );
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
