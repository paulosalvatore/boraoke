import { NextRequest, NextResponse } from "next/server";
import { requireHost } from "@/lib/host-auth";
import { DEFAULT_ROOM } from "@/lib/store";
import { telemetryStore } from "@/lib/telemetry-store";
import { computeAnalytics, DEFAULT_TOP_SONGS } from "@/lib/analytics";

/** Hard ceiling on the requested day range (defense against unbounded reads). */
const MAX_RANGE_DAYS = 90;

function isValidDay(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&topSongs=N] —
 * READ-ONLY site-wide analytics (TICKET-31): karaoke days-over-time, top
 * played songs, per-room activity. No mutation of any kind.
 *
 * AUTH (TICKET-31 decision, documented in work/tickets/TICKET-31-admin-analytics.md):
 * gated by the SAME host-session mechanism as `/[room]/admin`, scoped to the
 * `default` room — i.e. the site's existing `HOST_TOKEN` secret. This is not a
 * new attack surface: it reuses `requireHost`/`resolveRoomToken` byte-for-byte
 * (per-room host auth untouched), just checked against `DEFAULT_ROOM` instead
 * of a real room id, exactly like the legacy `/admin` redirect target did
 * before multi-room. Defaults to LOCKED in production if `HOST_TOKEN` is unset
 * (same fail-closed behavior as every other host route).
 */
export async function GET(req: NextRequest) {
  if (!(await requireHost(req, DEFAULT_ROOM))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl;
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");
  const toDay = isValidDay(toParam) ? toParam : new Date().toISOString().slice(0, 10);
  let fromDay = isValidDay(fromParam) ? fromParam : null;
  if (!fromDay) {
    const d = new Date(`${toDay}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 29); // default: trailing 30 days
    fromDay = d.toISOString().slice(0, 10);
  }
  if (fromDay > toDay) {
    return NextResponse.json({ error: "`from` must not be after `to`" }, { status: 400 });
  }
  const rangeDays =
    Math.round(
      (new Date(`${toDay}T00:00:00.000Z`).getTime() - new Date(`${fromDay}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Range too large (max ${MAX_RANGE_DAYS} days)` },
      { status: 400 },
    );
  }

  const topSongsParam = url.searchParams.get("topSongs");
  const topSongs = topSongsParam ? Math.max(1, Math.min(50, Number(topSongsParam) || DEFAULT_TOP_SONGS)) : undefined;

  const events = await telemetryStore.listRange(fromDay, toDay);
  const summary = computeAnalytics(events, fromDay, toDay, { topSongs });
  return NextResponse.json(summary);
}
