/**
 * next-intl request config (TICKET-30) — WITHOUT i18n routing.
 *
 * Resolves the active locale from the `NEXT_LOCALE` cookie, falling back to the
 * `Accept-Language` header on first visit, then pt-BR. No `[locale]` URL segment
 * exists (rooms stay `/<room>`), so the locale is never in the path.
 *
 * Room-default-language override: a room page that wants to honor its venue's
 * default language (when the visitor has NO explicit cookie) wraps its subtree
 * in its own `NextIntlClientProvider` with the room locale + messages. The TV
 * surface does exactly this (it always follows the room, never a user cookie).
 * This request config handles the app-wide default; the per-room override is a
 * deliberate, scoped layer on top.
 *
 * ROUTE-AWARE SINCE TICKET-79. Those scoped providers fix the MESSAGES but not
 * `<html lang>`, which is set once in the single root layout from THIS locale —
 * so a pt-BR room's TV served `lang="es"` to a visitor with an `es` cookie, and
 * TICKET-75 could only correct it with a post-hydration script (wrong in the
 * served HTML, invisible with JS off). The resolution below now applies the
 * route's own chain — see ./resolve-request-locale for the three chains and
 * why they are not flattened into one.
 */

import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, type Locale } from "./locales";
import { resolveRequestLocale } from "./resolve-request-locale";
import { PATHNAME_HEADER } from "./route-locale";

/** Load a locale's message catalog. Kept in one place for reuse by overrides. */
export async function loadMessages(locale: Locale) {
  return (await import(`../messages/${locale}.json`)).default;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  // TICKET-79: route-aware. The root layout renders `<html lang={getLocale()}>`
  // and cannot see the URL, so the ROUTE's chain is applied here — the one place
  // upstream of every page — rather than patched into the DOM after hydration.
  // `middleware.ts` forwards the pathname; see ./resolve-request-locale.
  const locale = await resolveRequestLocale({
    pathname: headerStore.get(PATHNAME_HEADER),
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });

  return {
    locale,
    messages: await loadMessages(locale),
  };
});
