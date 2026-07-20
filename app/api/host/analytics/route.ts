import { NextRequest, NextResponse } from "next/server";
import { requireHost } from "@/lib/host-auth";
import { DEFAULT_ROOM } from "@/lib/store";
import { telemetryStore } from "@/lib/telemetry-store";
import { computeAnalytics, DEFAULT_TOP_SONGS } from "@/lib/analytics";

/** Hard ceiling on the requested day range (defense against unbounded reads). */
const MAX_RANGE_DAYS = 90;

/**
 * A real `YYYY-MM-DD` UTC calendar date. The regex alone (used pre-review)
 * would accept junk like `2026-13-45`, which `new Date()` silently coerces to
 * `Invalid Date`/NaN downstream; here we additionally parse and round-trip the
 * components so an impossible date is rejected up front (400), not smuggled in.
 */
function isValidDay(s: string | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * GET /api/host/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&topSongs=N] —
 * READ-ONLY site-wide analytics (TICKET-31): karaoke days-over-time, top
 * played songs, per-room activity. No mutation of any kind.
 *
 * ROUTE LOCATION IS LOAD-BEARING (App Tester real-browser fix): this endpoint
 * MUST live under `/api/host/*`. The host session cookie is scoped to
 * `HOST_COOKIE_PATH = "/api/host"` (see lib/host-auth.ts), so a real browser
 * only sends the cookie to paths under that prefix. An earlier draft placed
 * this at `/api/admin/analytics` — outside the scope — so a genuinely
 * logged-in host's browser never attached the cookie and every request 401'd
 * (unit tests missed it because they set the cookie directly on mock requests,
 * bypassing browser path-scoping). Do NOT move it out from under `/api/host`,
 * and do NOT widen the cookie path to `/` to compensate — keep the tight scope.
 * See __tests__/api-admin-analytics.test.ts for the path-scope regression test.
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

  // Present-but-invalid params are a client error (400) rather than a silent
  // fall-through to defaults — a `2026-13-45` should not quietly become "today".
  // Absent params (null/"") fall back to the trailing-30-day default.
  if (toParam && !isValidDay(toParam)) {
    return NextResponse.json({ error: "Invalid `to` date (expected YYYY-MM-DD)" }, { status: 400 });
  }
  if (fromParam && !isValidDay(fromParam)) {
    return NextResponse.json({ error: "Invalid `from` date (expected YYYY-MM-DD)" }, { status: 400 });
  }
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
