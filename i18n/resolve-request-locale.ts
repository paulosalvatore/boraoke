import "server-only";

import { getPublicRoom, getRoomLanguage } from "@/lib/rooms";
import { resolveLocale, isLocale, type Locale } from "./locales";
import { classifyLocaleRoute } from "./route-locale";

/**
 * The route-aware request-locale decision (TICKET-79).
 *
 * Split out of `i18n/request.ts` so it is a plain async function with explicit
 * inputs — unit-testable under ts-jest without a live Next request context,
 * which is what gives the `<html lang>` guarantee real teeth
 * (`__tests__/served-lang.test.ts`).
 *
 * PRECEDENCE — three distinct chains, deliberately NOT flattened into one:
 *
 *   `/<room>/tv`  (venue screen)  room language → pt-BR
 *       A TV serves a whole bar; it can never follow one patron's cookie.
 *       Unchanged from TICKET-75, just moved from a post-hydration script into
 *       the server-rendered response.
 *
 *   `/<room>`     (patron page)   cookie → room default → Accept-Language → pt-BR
 *       The design §3 chain, exactly as `app/(patron)/[room]/page.tsx` already
 *       implements it for MESSAGES. Note the room tier reads the RAW stored
 *       `settings.language`, never `getRoomLanguage` — the latter normalizes an
 *       absent field to pt-BR, which would swallow the Accept-Language tier for
 *       every legacy room that never set a language.
 *
 *   everything else               cookie → Accept-Language → pt-BR
 *       Landing page, `/new`, `/admin`, `/admin/analytics`, `/<room>/admin`.
 *       The pre-TICKET-79 app-wide behavior, untouched.
 *
 * The per-page `NextIntlClientProvider` overrides on the TV and patron routes
 * stay in place. They are now redundant with this resolution rather than in
 * tension with it, and they keep the MESSAGES correct even in the degenerate
 * case where the pathname header never arrives — in which case this function
 * falls back to the app-wide chain, i.e. exactly today's behavior.
 */
export async function resolveRequestLocale(input: {
  pathname: string | null | undefined;
  cookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
}): Promise<Locale> {
  const route = classifyLocaleRoute(input.pathname);

  if (route.kind === "tv") {
    return getRoomLanguage(route.room);
  }

  // An explicit, supported user cookie wins outright — so we can skip the room
  // lookup entirely on the patron route when one is present.
  if (route.kind === "room" && !isLocale(input.cookie)) {
    const record = await getPublicRoom(route.room);
    return resolveLocale({
      roomLanguage: record?.settings.language,
      acceptLanguage: input.acceptLanguage,
    });
  }

  return resolveLocale({
    cookie: input.cookie,
    acceptLanguage: input.acceptLanguage,
  });
}
