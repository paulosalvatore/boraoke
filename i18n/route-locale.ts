/**
 * Route classification for locale resolution (TICKET-79) — PURE, client/edge-safe.
 *
 * WHY THIS EXISTS
 * ---------------
 * `<html lang>` is set in `app/layout.tsx`, the ONE root layout every route
 * renders through. A root layout cannot see the URL: Next.js gives it no
 * `params` and no pathname, and it is rendered before its children, so a page
 * deeper in the tree can never influence the `lang` attribute of the already
 * emitted `<html>` element. That is exactly why TICKET-75 had to patch the
 * attribute from a client-side script — and why a JS-disabled fetch still saw
 * the wrong value.
 *
 * The fix is to make the value the root layout already reads — the next-intl
 * REQUEST locale (`i18n/request.ts` → `getLocale()`) — route-aware, so the
 * server-rendered `<html lang>` is right the first time. The only supported way
 * to get a pathname into a server component is a middleware-forwarded request
 * header (`middleware.ts` → {@link PATHNAME_HEADER}), so this module owns the
 * shape of that contract and the pure classification on top of it.
 *
 * This file must stay dependency-free (no `server-only`, no `lib/**`): the
 * middleware runs on the edge runtime and imports {@link PATHNAME_HEADER} from
 * here. The room-id vocabulary is therefore mirrored, not imported — a unit test
 * (`__tests__/route-locale.test.ts`) pins it against `lib/rooms` so it cannot
 * drift.
 */

/**
 * Request header the middleware sets so server components can see the pathname.
 * `x-`-prefixed and app-specific to avoid colliding with anything Next.js or a
 * proxy sets. Never trusted for authorization — it only steers which locale a
 * page is rendered in, and every value it produces is normalized against the
 * fixed LOCALES enum downstream.
 */
export const PATHNAME_HEADER = "x-boraoke-pathname";

/**
 * Mirror of `lib/rooms.ts`'s room-id shape. Kept here (rather than imported)
 * because `lib/rooms` is `server-only` and this module is edge/client-safe.
 */
const ROOM_ID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Mirror of `lib/rooms.ts`'s `RESERVED_ROOM_IDS`. A reserved single segment is a
 * real static route, never a venue, so `/new` and friends are classified as an
 * ordinary app page and skip the room lookup entirely.
 *
 * This applies to the ONE-segment (patron) form only. `/<x>/tv` keeps the room
 * tier for every valid id shape, `default` included: `/default/tv` is the legacy
 * global room's real venue screen, and it must still resolve pt-BR rather than
 * inherit a patron's cookie. (`getRoomLanguage` returns pt-BR for a room with no
 * record, which is precisely the behavior TICKET-75's script produced there.)
 */
export const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "new",
  "api",
  "tv",
  "admin",
  "default",
]);

/**
 * The middleware's `matcher` pattern — document routes only.
 *
 * `middleware.ts` CANNOT import this: Next.js statically analyses
 * `export const config` at build time and rejects any identifier it cannot
 * resolve (`Unknown identifier "MIDDLEWARE_MATCHER" at "config.matcher[0]"`),
 * so the pattern is duplicated as an inline literal there. This copy is the
 * documented one — it carries the reasoning below and is what the tests assert
 * against — and `__tests__/route-locale.test.ts` parses `middleware.ts` and
 * fails if the two ever disagree. Keep the reasoning here; keep the literal
 * there; let the drift guard keep them equal.
 *
 * Every exclusion is anchored deliberately, because a room slug is
 * `[a-z0-9-]{1,64}` and therefore collides with careless prefixes:
 *
 * - `api/` keeps its trailing slash. A bare `api` prefix would also exclude
 *   `/api-bar`, `/apiacas`, … — real, mintable venue slugs ("API Bar",
 *   "Apiacás") — which would silently opt those rooms out of the whole fix and
 *   serve them the pre-TICKET-79 wrong `lang`.
 * - `favicon\.ico` escapes its dot. Unescaped, `.` matches any character, so
 *   `/favicon-ico` (a venue named "Favicon Ico") would be excluded too.
 * - `_next/*` needs no such care — `_` cannot appear in a room slug.
 *
 * The final alternative drops anything with a file extension (static assets);
 * a room slug cannot contain `.`, so it is safe as written.
 */
export const MIDDLEWARE_MATCHER =
  "/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.[\\w]+$).*)";

/**
 * How a route wants its locale resolved.
 *
 * - `tv` — `/<room>/tv`, the venue screen. It ALWAYS follows the room's
 *   language and never a patron cookie: one screen serves a whole bar.
 * - `room` — `/<room>`, the patron page. Full precedence chain:
 *   cookie → room default → Accept-Language → pt-BR.
 * - `app` — everything else (`/`, `/new`, `/admin`, `/admin/analytics`,
 *   `/<room>/admin`, API routes). Precedence chain WITHOUT a room tier:
 *   cookie → Accept-Language → pt-BR. This is the pre-TICKET-79 behavior,
 *   preserved untouched.
 */
export type LocaleRoute =
  | { kind: "tv"; room: string }
  | { kind: "room"; room: string }
  | { kind: "app" };

const APP_ROUTE: LocaleRoute = { kind: "app" };

/**
 * Classify a pathname into a {@link LocaleRoute}. Pure and total: an absent,
 * malformed or unrecognized path is `app`, i.e. exactly today's app-wide
 * behavior — so a missing header can only ever degrade to the status quo, never
 * to a wrong-room locale.
 *
 * NOTE `/<room>/admin` is deliberately `app`: the host console is a personal
 * device and keeps following the host's own cookie, unlike the shared TV.
 */
export function classifyLocaleRoute(pathname: string | null | undefined): LocaleRoute {
  if (!pathname) return APP_ROUTE;
  // Drop query/hash defensively — the middleware sends a bare pathname, but this
  // stays total if that ever changes.
  const path = pathname.split("?")[0].split("#")[0];
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return APP_ROUTE;

  const [first, second] = segments;
  if (!ROOM_ID_RE.test(first)) return APP_ROUTE;

  if (segments.length === 1) {
    return RESERVED_FIRST_SEGMENTS.has(first) ? APP_ROUTE : { kind: "room", room: first };
  }
  if (second === "tv") return { kind: "tv", room: first };
  return APP_ROUTE;
}
